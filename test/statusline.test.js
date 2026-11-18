import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCapture, formatStatusLine, main, sanitizeRateLimits, writeStateAtomically,
} from '../scripts/claude-statusline.mjs';

const ScriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'claude-statusline.mjs');
const now = new Date('2026-11-17T17:30:00Z');
const nowSeconds = now.getTime() / 1000;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ud-statusline-'));

// A realistic status line payload, including fields that must never be persisted.
const sampleInput = (baseSeconds = nowSeconds) => ({
  cwd: '/Users/someone/secret-project',
  session_id: 'session-123',
  session_name: 'private name',
  transcript_path: '/Users/someone/.claude/projects/x/session-123.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: '/Users/someone/secret-project', project_dir: '/Users/someone/secret-project', repo: { host: 'github.com', owner: 'o', name: 'n' } },
  cost: { total_cost_usd: 1.23 },
  context_window: { used_percentage: 8 },
  rate_limits: {
    five_hour: { used_percentage: 34.2, resets_at: baseSeconds + 2 * 3600 },
    seven_day: { used_percentage: 41, resets_at: baseSeconds + 3 * 86400 },
    seven_day_opus: { used_percentage: 12, resets_at: baseSeconds + 3 * 86400, nested: { secret: 'x' } },
  },
});

function runScript({ input, environment = {}, args = [] }) {
  return spawnSync(process.execPath, [ScriptPath, ...args], {
    input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: environment.HOME || tempDir(), ...environment },
  });
}

describe('claude-statusline.mjs capture', () => {
  it('persists only rate_limits plus capturedAt/sessionId/model, and captures unknown windows generically', () => {
    const capture = buildCapture(sampleInput(), now);
    assert.deepEqual(Object.keys(capture).sort(), ['capturedAt', 'model', 'rate_limits', 'sessionId']);
    assert.deepEqual(capture.model, { id: 'claude-opus-5-5', displayName: 'Opus 5.5' });
    assert.deepEqual(Object.keys(capture.rate_limits), ['five_hour', 'seven_day', 'seven_day_opus']);
    assert.deepEqual(capture.rate_limits.seven_day_opus, { used_percentage: 12, resets_at: nowSeconds + 3 * 86400 }, 'nested objects are dropped');
    const serialized = JSON.stringify(capture);
    for (const forbidden of ['secret-project', 'transcript', '.jsonl', 'private name', 'total_cost', 'github.com']) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} must not be persisted`);
    }
  });

  it('returns null (no write) when rate_limits is missing, empty or malformed', () => {
    assert.equal(buildCapture({ model: { display_name: 'Opus' } }, now), null);
    assert.equal(buildCapture({ rate_limits: {} }, now), null);
    assert.equal(buildCapture({ rate_limits: [] }, now), null);
    assert.equal(buildCapture({ rate_limits: { five_hour: { resets_at: 1 } } }, now), null, 'a window needs used_percentage');
    assert.equal(sanitizeRateLimits({ 'bad key!': { used_percentage: 1 } }), null);
  });

  it('keeps spend_limit gateway fields and truncates long strings', () => {
    const windows = sanitizeRateLimits({ spend_limit: { used_percentage: 62.8, resets_at: 5, used_usd: 314.12, limit_usd: 500, period: 'm'.repeat(200) } });
    assert.equal(windows.spend_limit.used_usd, 314.12);
    assert.equal(windows.spend_limit.period.length, 64);
  });

  it('writes atomically: no temp files left behind, readers never see a partial file', () => {
    const directory = tempDir();
    const stateFile = path.join(directory, 'nested', 'rate-limits.json');
    writeStateAtomically(stateFile, { capturedAt: 'a', rate_limits: { five_hour: { used_percentage: 1 } } });
    writeStateAtomically(stateFile, { capturedAt: 'b', rate_limits: { five_hour: { used_percentage: 2 } } });
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ['rate-limits.json']);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).capturedAt, 'b');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  });

  it('formats a compact line, skipping expired windows; falls back to context % without rate_limits', () => {
    const input = sampleInput();
    input.rate_limits.five_hour.resets_at = nowSeconds - 1; // expired
    const line = formatStatusLine(input, now);
    assert.match(line, /^Opus 5\.5 · wk 41% \(\w{3} \d\d:\d\d\) · seven day opus 12%/);
    assert.ok(!line.includes('5h'));
    assert.equal(formatStatusLine({ model: { display_name: 'Haiku' }, context_window: { used_percentage: 8.4 } }, now), 'Haiku · ctx 8%');
    assert.equal(formatStatusLine({}, now), 'Claude');
  });
});

describe('claude-statusline.mjs process', () => {
  it('valid input: prints the line and writes the state file at USAGE_DASHBOARD_STATE_FILE', () => {
    const stateFile = path.join(tempDir(), 'rate-limits.json');
    const result = runScript({ input: JSON.stringify(sampleInput(Math.floor(Date.now() / 1000))), environment: { USAGE_DASHBOARD_STATE_FILE: stateFile } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Opus 5\.5 · 5h 34% \(resets \d\d:\d\d\) · wk 41%/);
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.rate_limits.five_hour.used_percentage, 34.2);
    assert.equal(saved.sessionId, 'session-123');
  });

  it('defaults to ~/.claude/usage-dashboard/rate-limits.json', () => {
    const home = tempDir();
    runScript({ input: JSON.stringify(sampleInput(Math.floor(Date.now() / 1000))), environment: { HOME: home } });
    assert.ok(fs.existsSync(path.join(home, '.claude', 'usage-dashboard', 'rate-limits.json')));
  });

  it('missing rate_limits: prints a line and leaves an earlier capture untouched', () => {
    const stateFile = path.join(tempDir(), 'rate-limits.json');
    fs.writeFileSync(stateFile, '{"capturedAt":"earlier"}');
    const result = runScript({ input: JSON.stringify({ model: { display_name: 'Opus' } }), environment: { USAGE_DASHBOARD_STATE_FILE: stateFile } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'Opus\n');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"capturedAt":"earlier"}');
  });

  it('garbage, empty or non-object stdin: exit 0 with a fallback line, nothing written', () => {
    const directory = tempDir();
    const stateFile = path.join(directory, 'rate-limits.json');
    for (const input of ['not json {', '', 'null', '[1,2]', '"str"', '\u0000\u00ff']) {
      const result = runScript({ input, environment: { USAGE_DASHBOARD_STATE_FILE: stateFile } });
      assert.equal(result.status, 0, input);
      assert.equal(result.stdout, 'Claude\n', input);
      assert.equal(result.stderr, '', input);
    }
    assert.equal(fs.existsSync(stateFile), false);
  });

  it('an unwritable state path still prints the line', () => {
    const blocker = path.join(tempDir(), 'file');
    fs.writeFileSync(blocker, '');
    const result = runScript({ input: JSON.stringify(sampleInput(Math.floor(Date.now() / 1000))), environment: { USAGE_DASHBOARD_STATE_FILE: path.join(blocker, 'x', 'rate-limits.json') } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Opus 5\.5 · 5h 34%/);
  });

  it('chains a previous status line: same stdin, its output wins; a failing chain falls back', () => {
    const stateFile = path.join(tempDir(), 'rate-limits.json');
    const ok = runScript({
      input: JSON.stringify(sampleInput(Math.floor(Date.now() / 1000))),
      environment: { USAGE_DASHBOARD_STATUSLINE_CHAIN: `${JSON.stringify(process.execPath)} -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('prev:'+JSON.parse(d).model.id))"`, USAGE_DASHBOARD_STATE_FILE: stateFile },
    });
    assert.equal(ok.stdout, 'prev:claude-opus-5-5\n');
    assert.ok(fs.existsSync(stateFile), 'the capture is still written');
    const failing = runScript({ input: JSON.stringify(sampleInput(Math.floor(Date.now() / 1000))), environment: { USAGE_DASHBOARD_STATUSLINE_CHAIN: 'exit 3', USAGE_DASHBOARD_STATE_FILE: stateFile } });
    assert.match(failing.stdout, /^Opus 5\.5/);
  });

  it('reads the chain from statusline-chain.json next to the state file and ignores self-references', () => {
    const directory = tempDir();
    const stateFile = path.join(directory, 'rate-limits.json');
    fs.writeFileSync(path.join(directory, 'statusline-chain.json'), JSON.stringify({ command: 'echo chained' }));
    assert.equal(runScript({ input: '{}', environment: { USAGE_DASHBOARD_STATE_FILE: stateFile } }).stdout, 'chained\n');
    fs.writeFileSync(path.join(directory, 'statusline-chain.json'), JSON.stringify({ command: `node ${ScriptPath}` }));
    assert.equal(runScript({ input: '{}', environment: { USAGE_DASHBOARD_STATE_FILE: stateFile } }).stdout, 'Claude\n');
  });

  it('--help prints usage without reading stdin', () => {
    const lines = [];
    main({ argv: ['--help'], write: (text) => lines.push(text) });
    assert.match(lines.join(''), /^Usage: claude-statusline\.mjs/);
    const result = runScript({ args: ['--help'] });
    assert.match(result.stdout, /USAGE_DASHBOARD_STATE_FILE/);
  });
});
