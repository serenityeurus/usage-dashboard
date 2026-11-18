import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadClaudeQuotaConfig, loadConfig } from '../src/config.js';
import { createClaudeProvider, lastResponseAt } from '../src/providers/claude/index.js';
import { applyOfficialQuota, currentBlock, readStatuslineState } from '../src/providers/claude/official-quota.js';
import { estimateClaudeQuota } from '../src/providers/claude/quota.js';
import { parseTranscriptText } from '../src/transcript-scanner.js';

const TestDir = path.dirname(fileURLToPath(import.meta.url));
const PricingPath = path.join(TestDir, '..', 'config', 'pricing.json');
const now = new Date('2026-11-17T17:30:00Z');
const nowSeconds = now.getTime() / 1000;
const estimate = () => estimateClaudeQuota([{ timestamp: '2026-11-17T16:10:00Z', usd: 2, tokens: 100 }], {
  quotaConfig: loadClaudeQuotaConfig({ CLAUDE_SESSION_LIMIT_USD: '10', CLAUDE_WEEKLY_LIMIT_USD: '100' }), now,
});
const capture = (rateLimits, capturedAt = '2026-11-17T17:25:00Z') => ({ status: 'ok', capture: { capturedAt, rate_limits: rateLimits } });
const windowAt = (usedPercentage, resetsInSeconds) => ({ used_percentage: usedPercentage, resets_at: nowSeconds + resetsInSeconds });

function writeStateFile(contents) {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ud-state-')), 'rate-limits.json');
  if (contents !== undefined) fs.writeFileSync(stateFile, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return stateFile;
}

describe('official Claude quota from the status line capture', () => {
  it('uses the official % per window while resets_at is in the future', () => {
    const quota = applyOfficialQuota(estimate(), capture({ five_hour: windowAt(34.25, 3600), seven_day: windowAt(41, 86400) }), { now });
    assert.equal(quota.session.source, 'official');
    assert.equal(quota.session.official.usedPercent, 34.3);
    assert.equal(quota.session.official.resetsAt, '2026-11-17T18:30:00.000Z');
    assert.equal(quota.session.official.ageSeconds, 300);
    assert.equal(quota.session.official.stale, false);
    assert.equal(quota.session.sourceLabel, 'Claude Code /usage (status line, captured 5 min ago)');
    assert.equal(quota.weekly.source, 'official');
    assert.equal(quota.estimate, false);
    assert.equal(quota.session.percent, 20, 'estimate fields are kept for API compatibility');
  });

  it('falls back to the estimate for a missing window and for an expired one', () => {
    const quota = applyOfficialQuota(estimate(), capture({ five_hour: windowAt(90, -1) }), { now });
    assert.equal(quota.session.source, 'estimate');
    assert.equal(quota.session.official, null);
    assert.match(quota.session.sourceLabel, /^Estimate/);
    assert.equal(quota.weekly.source, 'estimate');
    assert.deepEqual(quota.official.expiredWindows, ['five_hour']);
    assert.equal(quota.estimate, true);
  });

  it('keeps a stale capture as a lower bound "as of" its time, until the window resets', () => {
    const stale = capture({ five_hour: windowAt(50, 600), seven_day: windowAt(70, 86400) }, '2026-11-17T16:00:00Z');
    const quota = applyOfficialQuota(estimate(), stale, { now, maxAgeSeconds: 900 });
    assert.equal(quota.session.source, 'official');
    assert.equal(quota.session.official.stale, true);
    assert.equal(quota.official.stale, true);
    assert.equal(quota.official.ageSeconds, 5400);
    assert.match(quota.session.sourceLabel, /as of 2026-11-17T16:00:00\.000Z: a lower bound/);
    const fresh = applyOfficialQuota(estimate(), stale, { now, maxAgeSeconds: 6000 });
    assert.equal(fresh.session.official.stale, false);
  });

  it('exposes other windows (spend_limit, per-model) as extraWindows', () => {
    const quota = applyOfficialQuota(estimate(), capture({
      five_hour: windowAt(10, 60), seven_day_opus: windowAt(12, 86400),
      spend_limit: { ...windowAt(62.8, 86400), used_usd: 314.12, limit_usd: 500, period: 'monthly' },
      junk: { resets_at: 5 }, 'bad key': windowAt(1, 60),
    }), { now });
    assert.deepEqual(quota.extraWindows.map((window) => window.key), ['seven_day_opus', 'spend_limit']);
    assert.equal(quota.extraWindows[1].usedUsd, 314.12);
    assert.equal(quota.extraWindows[1].period, 'monthly');
  });

  it('reads the state file: ok, missing, garbage, wrong shape', async () => {
    assert.equal((await readStatuslineState(writeStateFile({ capturedAt: now.toISOString(), rate_limits: {} }))).status, 'ok');
    assert.deepEqual(await readStatuslineState(writeStateFile()), { status: 'missing' });
    assert.deepEqual(await readStatuslineState(null), { status: 'missing' });
    assert.equal((await readStatuslineState(writeStateFile('{nope'))).status, 'invalid');
    assert.equal((await readStatuslineState(writeStateFile({ capturedAt: 'never', rate_limits: {} }))).status, 'invalid');
    assert.equal((await readStatuslineState(writeStateFile('[]'))).status, 'invalid');
    const missingQuota = applyOfficialQuota(estimate(), { status: 'missing' }, { now });
    assert.equal(missingQuota.session.source, 'estimate');
    assert.equal(missingQuota.official.status, 'missing');
  });

  it('validates CLAUDE_STATUSLINE_MAX_AGE_SECONDS and resolves the state file path', () => {
    assert.equal(loadClaudeQuotaConfig({}).statuslineMaxAgeSeconds, 900);
    assert.equal(loadClaudeQuotaConfig({ CLAUDE_STATUSLINE_MAX_AGE_SECONDS: '60' }).statuslineMaxAgeSeconds, 60);
    for (const bad of ['0', '-5', '1.5', 'soon']) {
      assert.throws(() => loadClaudeQuotaConfig({ CLAUDE_STATUSLINE_MAX_AGE_SECONDS: bad }), /CLAUDE_STATUSLINE_MAX_AGE_SECONDS/, bad);
    }
    assert.equal(loadConfig({ HOME: '/home/u' }).claudeQuota.statuslineStateFile, '/home/u/.claude/usage-dashboard/rate-limits.json');
    assert.equal(loadConfig({ USAGE_DASHBOARD_STATE_FILE: '/data/x.json' }).claudeQuota.statuslineStateFile, '/data/x.json');
  });
});

describe('rate-limit blocks from transcripts', () => {
  const rejected = (timestamp, resetsAt, rateLimitType = 'five_hour') => ({ timestamp, status: 'rejected', resetsAt, rateLimitType });

  it('is blocked until resetsAt of the latest rejection', () => {
    const block = currentBlock([rejected('2026-11-17T16:00:00Z', nowSeconds + 1800), rejected('2026-11-17T15:00:00Z', nowSeconds + 99999)], { now });
    assert.equal(block.blocked, true);
    assert.equal(block.until, '2026-11-17T18:00:00.000Z');
    assert.equal(block.rateLimitType, 'five_hour');
  });

  it('is not blocked once resetsAt passed, after a later successful response, or without rejections', () => {
    assert.equal(currentBlock([rejected('2026-11-17T16:00:00Z', nowSeconds - 1)], { now }), null);
    assert.equal(currentBlock([rejected('2026-11-17T16:00:00Z', nowSeconds + 1800)], { now, lastResponseAt: '2026-11-17T16:05:00Z' }), null);
    assert.notEqual(currentBlock([rejected('2026-11-17T16:00:00Z', nowSeconds + 1800)], { now, lastResponseAt: '2026-11-17T15:59:00Z' }), null);
    assert.equal(currentBlock([{ timestamp: '2026-11-17T16:00:00Z', status: 'allowed', resetsAt: nowSeconds + 60 }], { now }), null);
    assert.equal(currentBlock(undefined, { now }), null);
  });

  it('parses Claude Code\'s 429 line (synthetic assistant + apiErrorParams.rate_limit_info) and ignores errors without resetsAt', () => {
    const lines = [
      { type: 'assistant', uuid: 'u1', timestamp: '2026-11-17T16:00:00Z', sessionId: 's', apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: nowSeconds + 1800, rateLimitType: 'five_hour' } }, message: { id: 'm-err', model: '<synthetic>', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: 'assistant', uuid: 'u1', timestamp: '2026-11-17T16:00:00Z', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: nowSeconds + 1800 } } },
      { type: 'system', subtype: 'api_error', uuid: 'u2', timestamp: '2026-11-17T16:01:00Z', apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: nowSeconds + 1900, rateLimitType: 'seven_day' } } },
      { type: 'assistant', uuid: 'u3', timestamp: '2026-11-17T16:02:00Z', apiErrorParams: { rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } }, message: { id: 'm3', model: '<synthetic>', content: [] } },
    ].map((line) => JSON.stringify(line)).join('\n');
    const parsed = parseTranscriptText(lines, { projectDir: 'p', sessionFile: '/x/s.jsonl' });
    assert.deepEqual(parsed.rateLimitEvents.map((event) => [event.dedupeKey, event.rateLimitType]), [['u1', 'five_hour'], ['u2', 'seven_day']]);
    assert.equal(lastResponseAt(parsed.usageRecords), null, 'synthetic error messages are not responses');
    assert.equal(currentBlock(parsed.rateLimitEvents, { now }).rateLimitType, 'seven_day');
  });
});

describe('Claude provider with a status line capture', () => {
  const record = {
    model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, sessionId: 's1', projectDir: 'p',
  };

  async function collect({ stateContents, rateLimitEvents = [], usageRecords = [{ ...record, messageId: 'm1', timestamp: '2026-11-17T16:30:00Z' }] }) {
    const provider = createClaudeProvider({
      pricingFilePath: PricingPath, adminKey: '', timeZone: 'UTC',
      quotaConfig: { ...loadClaudeQuotaConfig({ CLAUDE_SESSION_LIMIT_TOKENS: '400', CLAUDE_QUOTA_METRIC: 'tokens' }), statuslineStateFile: writeStateFile(stateContents) },
    });
    return provider.collect({ now, reason: 'refresh', getTranscripts: async () => ({ usageRecords, rateLimitEvents, stats: {} }) });
  }

  it('puts source per window on summary.quota (what /api/summary returns)', async () => {
    const { summary, detail } = await collect({ stateContents: { capturedAt: '2026-11-17T17:29:00Z', rate_limits: { seven_day: windowAt(41, 86400) } } });
    assert.equal(summary.quota.session.source, 'estimate');
    assert.equal(summary.quota.session.percent, 50);
    assert.equal(summary.quota.weekly.source, 'official');
    assert.equal(summary.quota.weekly.official.usedPercent, 41);
    assert.equal(summary.quota.official.status, 'ok');
    assert.ok(detail.quota.recentBlocks);
    assert.deepEqual(summary.warnings, []);
  });

  it('missing state file: all estimate; an over-limit estimate warns only when the window is an estimate', async () => {
    const overRecords = [{ ...record, messageId: 'm1', inputTokens: 1000, timestamp: '2026-11-17T16:30:00Z' }];
    const missing = await collect({ usageRecords: overRecords });
    assert.equal(missing.summary.quota.official.status, 'missing');
    assert.equal(missing.summary.quota.session.source, 'estimate');
    assert.match(missing.summary.warnings.join(), /over a configured limit/);
    const official = await collect({ usageRecords: overRecords, stateContents: { capturedAt: '2026-11-17T17:29:00Z', rate_limits: { five_hour: windowAt(20, 3600) } } });
    assert.deepEqual(official.summary.warnings, [], 'the official % overrides the over-limit estimate');
  });

  it('adds blocked-until from transcript rate-limit events', async () => {
    const { summary } = await collect({ rateLimitEvents: [{ timestamp: '2026-11-17T17:00:00Z', status: 'rejected', resetsAt: nowSeconds + 1800, rateLimitType: 'five_hour' }] });
    assert.equal(summary.quota.block.until, '2026-11-17T18:00:00.000Z');
    assert.match(summary.warnings.join(), /rate-limited \(five hour limit\) until 2026-11-17T18:00:00\.000Z/);
  });
});
