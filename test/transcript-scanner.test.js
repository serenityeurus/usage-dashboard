import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseTranscriptText, TranscriptScanner } from '../src/transcript-scanner.js';

const FixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-projects');

describe('parseTranscriptText', () => {
  it('returns nothing for empty input', () => {
    const parsed = parseTranscriptText('', { projectDir: 'p', sessionFile: '/x/s.jsonl' });
    assert.deepEqual(parsed, { usageRecords: [], webSearchCalls: [], rateLimitEvents: [], malformedLineCount: 0 });
  });

  it('dedupes streaming duplicate lines that share a message id', async () => {
    const fileText = await fs.readFile(path.join(FixtureRoot, '-Users-testuser--openclaw-workspace-alpha', 'session-a.jsonl'), 'utf8');
    const parsed = parseTranscriptText(fileText, { projectDir: 'alpha', sessionFile: 'session-a.jsonl' });
    const messageIds = parsed.usageRecords.map((record) => record.messageId);
    assert.deepEqual(messageIds, ['msg_a1', 'msg_a2', 'msg_synth', 'msg_a3']);
    const firstRecord = parsed.usageRecords[0];
    assert.equal(firstRecord.inputTokens, 1000);
    assert.equal(firstRecord.cacheWrite1hTokens, 200000);
    assert.equal(firstRecord.cacheWrite5mTokens, 0);
  });

  it('treats unsplit cache_creation tokens as 5-minute writes', async () => {
    const fileText = await fs.readFile(path.join(FixtureRoot, '-Users-testuser--openclaw-workspace-alpha', 'session-a.jsonl'), 'utf8');
    const parsed = parseTranscriptText(fileText, { projectDir: 'alpha', sessionFile: 'session-a.jsonl' });
    const sonnetRecord = parsed.usageRecords.find((record) => record.messageId === 'msg_a2');
    assert.equal(sonnetRecord.cacheWrite5mTokens, 400000);
    assert.equal(sonnetRecord.cacheWrite1hTokens, 0);
  });

  it('counts web_search tool_use only from assistant lines, ignoring api-request-blob replays', async () => {
    const fileText = await fs.readFile(path.join(FixtureRoot, '-Users-testuser--openclaw-workspace-alpha', 'session-a.jsonl'), 'utf8');
    const parsed = parseTranscriptText(fileText, { projectDir: 'alpha', sessionFile: 'session-a.jsonl' });
    assert.deepEqual(parsed.webSearchCalls.map((call) => call.toolUseId), ['toolu_s1']);
  });

  it('skips a truncated trailing line and counts it as malformed', async () => {
    const fileText = await fs.readFile(path.join(FixtureRoot, '-Users-testuser--openclaw-workspace-alpha', 'session-a.jsonl'), 'utf8');
    const parsed = parseTranscriptText(fileText, { projectDir: 'alpha', sessionFile: 'session-a.jsonl' });
    assert.equal(parsed.malformedLineCount, 1);
  });

  it('clamps negative, missing and non-numeric token counts to zero', () => {
    const line = JSON.stringify({
      type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
      message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: -5, output_tokens: 'abc' } },
    });
    const [record] = parseTranscriptText(line, { projectDir: 'p', sessionFile: 's.jsonl' }).usageRecords;
    assert.equal(record.inputTokens, 0);
    assert.equal(record.outputTokens, 0);
    assert.equal(record.cacheReadTokens, 0);
  });

  it('falls back to requestId when message.id is missing and to the file name for sessionId', () => {
    const line = JSON.stringify({ type: 'assistant', requestId: 'req_only', message: { model: 'x', usage: { input_tokens: 1 } } });
    const [record] = parseTranscriptText(`${line}\n${line}`, { projectDir: 'p', sessionFile: '/a/abc.jsonl' }).usageRecords;
    assert.equal(record.messageId, 'req_only');
    assert.equal(record.sessionId, 'abc');
  });
});

describe('TranscriptScanner', () => {
  it('scans all project dirs, ignores non-jsonl files and dedupes across files', async () => {
    const scanner = new TranscriptScanner({ rootDir: FixtureRoot });
    const result = await scanner.scan();
    assert.equal(result.stats.fileCount, 2);
    assert.equal(result.usageRecords.length, 5); // a1, a2, synth, a3, b1 (a1 replay dropped)
    assert.equal(result.webSearchCalls.length, 2);
  });

  it('reports a missing root without throwing', async () => {
    const scanner = new TranscriptScanner({ rootDir: path.join(os.tmpdir(), 'does-not-exist-usage-dashboard') });
    const result = await scanner.scan();
    assert.equal(result.stats.rootMissing, true);
    assert.equal(result.usageRecords.length, 0);
  });

  it('re-parses only files whose mtime or size changed', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-dashboard-test-'));
    try {
      const projectPath = path.join(tempRoot, '-Users-testuser--openclaw-workspace-beta');
      await fs.mkdir(projectPath);
      const lineFor = (messageId) => `${JSON.stringify({
        type: 'assistant', timestamp: '2026-11-01T00:00:00Z',
        message: { id: messageId, model: 'claude-opus-5-5', usage: { input_tokens: 1 } },
      })}\n`;
      await fs.writeFile(path.join(projectPath, 'one.jsonl'), lineFor('m1'));
      await fs.writeFile(path.join(projectPath, 'two.jsonl'), lineFor('m2'));

      const scanner = new TranscriptScanner({ rootDir: tempRoot });
      assert.equal((await scanner.scan()).stats.reparsedFileCount, 2);
      assert.equal((await scanner.scan()).stats.reparsedFileCount, 0);

      await fs.appendFile(path.join(projectPath, 'two.jsonl'), lineFor('m3'));
      const third = await scanner.scan();
      assert.equal(third.stats.reparsedFileCount, 1);
      assert.equal(third.usageRecords.length, 3);

      await fs.rm(path.join(projectPath, 'one.jsonl'));
      const fourth = await scanner.scan();
      assert.equal(fourth.usageRecords.length, 2);
      assert.equal(scanner.fileCache.size, 1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
