import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractSearchProvider, mergeParsedFiles, parseTranscriptText } from '../src/transcript-scanner.js';
import { attributeWebSearchCall, parseProviderHistory, selectCallsForProvider } from '../src/web-search-attribution.js';

// Synthetic transcript lines in Claude Code's shape.
function searchUseLine(toolUseId, timestamp, messageId = `msg_${toolUseId}`) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId: 's1',
    message: {
      id: messageId, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__openclaw__web_search', input: { query: 'q' } }],
    },
  });
}

function searchResultLine(toolUseId, payload, { asString = false } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: asString ? text : [{ type: 'text', text }] }],
    },
  });
}

describe('extractSearchProvider', () => {
  it('reads the top-level provider from the OpenClaw result payload', () => {
    assert.equal(extractSearchProvider([{ type: 'text', text: '{"kind":"results","provider":"brave","results":[]}' }]), 'brave');
    assert.equal(extractSearchProvider('{"query":"q","provider":"searxng","results":[]}'), 'searxng');
  });

  it('returns null for errors, non-JSON and missing providers', () => {
    assert.equal(extractSearchProvider([{ type: 'text', text: 'Error: SearXNG base URL is not configured' }]), null);
    assert.equal(extractSearchProvider([{ type: 'text', text: '{"kind":"results"}' }]), null);
    assert.equal(extractSearchProvider(undefined), null);
    assert.equal(extractSearchProvider([{ type: 'image' }]), null);
    assert.equal(extractSearchProvider('{"provider": 42}'), null);
  });

  it('handles a truncated payload but ignores "provider" text inside results', () => {
    assert.equal(extractSearchProvider('{\n "query": "q",\n "provider": "searxng",\n "results": [ {"title": "cut'), 'searxng');
    // A snippet that says "provider":"brave" must not count when the real key is absent.
    assert.equal(extractSearchProvider('{"query":"q","results":[{"snippet":"\\"provider\\": \\"brave\\"'), null);
  });
});

describe('parseTranscriptText web_search results', () => {
  it('copies the provider from each tool_result onto its call', () => {
    const fileText = [
      searchUseLine('toolu_b', '2026-11-17T10:00:00Z'),
      searchResultLine('toolu_b', { kind: 'results', provider: 'brave', results: [] }),
      searchUseLine('toolu_x', '2026-11-17T22:00:00Z'),
      searchResultLine('toolu_x', { query: 'q', provider: 'searxng', results: [] }, { asString: true }),
      searchUseLine('toolu_err', '2026-11-17T22:05:00Z'),
      searchResultLine('toolu_err', 'Error: fetch failed'),
      searchUseLine('toolu_pending', '2026-11-17T22:06:00Z'), // session still running: no result yet
    ].join('\n');
    const parsed = parseTranscriptText(fileText, { projectDir: 'p', sessionFile: '/x/s1.jsonl' });
    assert.deepEqual(parsed.webSearchCalls.map((call) => [call.toolUseId, call.recordedProvider]), [
      ['toolu_b', 'brave'], ['toolu_x', 'searxng'], ['toolu_err', null], ['toolu_pending', null],
    ]);
    assert.equal(parsed.usageRecords.length, 4); // result lines never become usage records
  });

  it('still counts assistant usage on a line that mentions "tool_result" in its text', () => {
    const assistantLine = JSON.stringify({
      type: 'assistant', timestamp: '2026-11-17T10:01:00Z',
      message: { id: 'msg_talk', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: 'the "tool_result" toolu_b block' }] },
    });
    const fileText = [searchUseLine('toolu_b', '2026-11-17T10:00:00Z'), assistantLine].join('\n');
    const parsed = parseTranscriptText(fileText, { projectDir: 'p', sessionFile: '/x/s1.jsonl' });
    assert.ok(parsed.usageRecords.some((record) => record.messageId === 'msg_talk'));
  });

  it('merges a provider recorded only in a later (resumed) file', () => {
    const first = parseTranscriptText(searchUseLine('toolu_r', '2026-11-17T10:00:00Z'), { projectDir: 'p', sessionFile: '/x/a.jsonl' });
    const second = parseTranscriptText([
      searchUseLine('toolu_r', '2026-11-17T10:00:00Z'),
      searchResultLine('toolu_r', { provider: 'searxng', results: [] }),
    ].join('\n'), { projectDir: 'p', sessionFile: '/x/b.jsonl' });
    const merged = mergeParsedFiles([first, second]);
    assert.equal(merged.webSearchCalls.length, 1);
    assert.equal(merged.webSearchCalls[0].recordedProvider, 'searxng');
  });
});

describe('web search attribution', () => {
  const history = parseProviderHistory('searxng@2026-11-17T21:00:00Z, brave@2026-11-20T00:00:00-05:00');

  it('parses and sorts the cutover history', () => {
    assert.deepEqual(history.map((entry) => [entry.provider, entry.startAt]), [
      ['searxng', '2026-11-17T21:00:00.000Z'], ['brave', '2026-11-20T05:00:00.000Z'],
    ]);
    assert.deepEqual(parseProviderHistory(''), []);
  });

  it('rejects malformed history entries', () => {
    assert.throws(() => parseProviderHistory('searxng'), /provider@/);
    assert.throws(() => parseProviderHistory('bing@2026-11-17T21:00:00Z'), /must be one of/);
    assert.throws(() => parseProviderHistory('searxng@2026-11-17'), /ISO-8601/);
    assert.throws(() => parseProviderHistory('searxng@not-a-dateT'), /ISO-8601/);
  });

  it('prefers the recorded provider, then the cutover history, then the fallback', () => {
    const options = { history, fallbackProvider: 'brave' };
    assert.deepEqual(attributeWebSearchCall({ recordedProvider: 'brave', timestamp: '2026-11-18T00:00:00Z' }, options), { provider: 'brave', attributedBy: 'recorded' });
    assert.deepEqual(attributeWebSearchCall({ timestamp: '2026-11-17T20:59:59Z' }, options), { provider: 'brave', attributedBy: 'fallback' });
    assert.deepEqual(attributeWebSearchCall({ timestamp: '2026-11-17T21:00:00Z' }, options), { provider: 'searxng', attributedBy: 'cutover' });
    assert.deepEqual(attributeWebSearchCall({ timestamp: '2026-11-21T00:00:00Z' }, options), { provider: 'brave', attributedBy: 'cutover' });
    assert.deepEqual(attributeWebSearchCall({ timestamp: null }, options), { provider: 'brave', attributedBy: 'fallback' });
    assert.deepEqual(attributeWebSearchCall({ timestamp: 'garbage' }, options), { provider: 'brave', attributedBy: 'fallback' });
  });

  it('splits calls so no call is counted by two providers', () => {
    const calls = [
      { toolUseId: 'a', recordedProvider: 'brave', timestamp: '2026-11-17T10:00:00Z' },
      { toolUseId: 'b', recordedProvider: 'searxng', timestamp: '2026-11-17T22:00:00Z' },
      { toolUseId: 'c', recordedProvider: null, timestamp: '2026-11-17T22:30:00Z' },
      { toolUseId: 'd', recordedProvider: 'duckduckgo', timestamp: '2026-11-17T22:40:00Z' },
    ];
    const brave = selectCallsForProvider(calls, 'brave', { history });
    const searxng = selectCallsForProvider(calls, 'searxng', { history });
    assert.deepEqual(brave.calls.map((call) => call.toolUseId), ['a']);
    assert.deepEqual(searxng.calls.map((call) => call.toolUseId), ['b', 'c']);
    assert.deepEqual(searxng.attribution, { recorded: 1, cutover: 1, fallback: 0 });
  });
});
