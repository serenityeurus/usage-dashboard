import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadClaudeQuotaConfig, loadConfig, parseWeeklyReset } from '../src/config.js';
import { createClaudeProvider, quotaEntries } from '../src/providers/claude/index.js';
import { loadPricingTable } from '../src/providers/claude/pricing.js';
import {
  computeSessionBlocks, estimateClaudeQuota, fixedWeeklyWindow, wallTimeToInstant,
} from '../src/providers/claude/quota.js';

const TestDir = path.dirname(fileURLToPath(import.meta.url));
const PricingPath = path.join(TestDir, '..', 'config', 'pricing.json');
const Detroit = 'America/Detroit';

const entry = (timestamp, usd = 1, tokens = 1000) => ({ timestamp, usd, tokens });
const quotaConfig = (environment = {}) => loadClaudeQuotaConfig({
  CLAUDE_SESSION_LIMIT_USD: '10', CLAUDE_WEEKLY_LIMIT_USD: '100', ...environment,
});
const blockSpans = (blocks) => blocks.map((block) => [new Date(block.startMs).toISOString(), new Date(block.endMs).toISOString(), block.usage.messages]);

describe('Claude session blocks (5-hour windows)', () => {
  it('starts a new block after a gap longer than 5 hours', () => {
    const blocks = computeSessionBlocks([entry('2026-11-17T10:20:00Z'), entry('2026-11-17T11:00:00Z'), entry('2026-11-17T17:30:00Z')]);
    assert.deepEqual(blockSpans(blocks), [
      ['2026-11-17T10:00:00.000Z', '2026-11-17T15:00:00.000Z', 2],
      ['2026-11-17T17:00:00.000Z', '2026-11-17T22:00:00.000Z', 1],
    ]);
  });

  it('is a fixed block, not a trailing 5 hours: continuous use splits at the block end', () => {
    // One message every hour for 7 hours, never a gap: still two windows.
    const hourly = Array.from({ length: 7 }, (_, hour) => entry(`2026-11-17T${String(10 + hour).padStart(2, '0')}:30:00Z`));
    assert.deepEqual(blockSpans(computeSessionBlocks(hourly)), [
      ['2026-11-17T10:00:00.000Z', '2026-11-17T15:00:00.000Z', 5],
      ['2026-11-17T15:00:00.000Z', '2026-11-17T20:00:00.000Z', 2],
    ]);
  });

  it('puts a message exactly at the block end into the next block, and ignores order and bad timestamps', () => {
    const blocks = computeSessionBlocks([entry('2026-11-17T15:00:00Z'), entry(null), entry('not a date'), entry('2026-11-17T10:00:00Z')]);
    assert.deepEqual(blockSpans(blocks).map(([start]) => start), ['2026-11-17T10:00:00.000Z', '2026-11-17T15:00:00.000Z']);
  });

  it('reports the active window with its reset time, and none once it has expired', () => {
    const entries = [entry('2026-11-17T10:20:00Z', 2), entry('2026-11-17T12:00:00Z', 1.5)];
    const active = estimateClaudeQuota(entries, { quotaConfig: quotaConfig(), now: new Date('2026-11-17T14:59:59Z') });
    assert.equal(active.session.active, true);
    assert.equal(active.session.startAt, '2026-11-17T10:00:00.000Z');
    assert.equal(active.session.resetAt, '2026-11-17T15:00:00.000Z');
    assert.equal(active.session.firstMessageAt, '2026-11-17T10:20:00.000Z');
    assert.equal(active.session.used.usd, 3.5);
    assert.equal(active.session.percent, 35);
    const expired = estimateClaudeQuota(entries, { quotaConfig: quotaConfig(), now: new Date('2026-11-17T15:00:00Z') });
    assert.equal(expired.session.active, false);
    assert.equal(expired.session.resetAt, null);
    assert.equal(expired.session.used.usd, 0);
    assert.equal(expired.session.percent, 0);
    assert.equal(expired.recentBlocks.length, 1);
    assert.equal(expired.recentBlocks[0].active, false);
  });
});

describe('Claude weekly window', () => {
  it('rolling: counts the trailing 7 days and says when the oldest usage ages out', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const entries = [entry('2026-11-10T11:59:00Z', 50), entry('2026-11-10T12:30:00Z', 5), entry('2026-11-17T11:00:00Z', 7), entry('2026-11-17T13:00:00Z', 99)];
    const quota = estimateClaudeQuota(entries, { quotaConfig: quotaConfig(), now });
    assert.equal(quota.weekly.mode, 'rolling');
    assert.equal(quota.weekly.used.usd, 12, 'older than 7 days and future-dated messages are excluded');
    assert.equal(quota.weekly.resetAt, null);
    assert.equal(quota.weekly.nextDropAt, '2026-11-17T12:30:00.000Z');
    assert.equal(quota.weekly.percent, 12);
  });

  it('fixed: "mon 00:00" is Monday midnight in the dashboard time zone, not UTC', () => {
    const config = quotaConfig({ CLAUDE_WEEKLY_RESET: 'mon 00:00' });
    const now = new Date('2026-11-18T17:00:00Z'); // Wed 12:00 EST
    const entries = [entry('2026-11-16T04:59:00Z', 40), entry('2026-11-16T05:00:00Z', 3), entry('2026-11-18T16:00:00Z', 2)];
    const quota = estimateClaudeQuota(entries, { quotaConfig: config, now, timeZone: Detroit });
    assert.equal(quota.weekly.startAt, '2026-11-16T05:00:00.000Z');
    assert.equal(quota.weekly.resetAt, '2026-11-23T05:00:00.000Z');
    assert.equal(quota.weekly.used.usd, 5, 'Sunday 23:59 local belongs to the previous week');
    assert.equal(quota.weekly.label, 'mon 00:00');
  });

  it('fixed: a week spanning the DST change is 169 hours, and the reset instant opens the next week', () => {
    const reset = { dayOfWeek: 0, hour: 0, minute: 0 }; // Sunday 00:00; US DST ended Sun 2026-11-01
    const window = fixedWeeklyWindow(Date.parse('2026-11-02T12:00:00Z'), reset, Detroit);
    assert.equal(new Date(window.startMs).toISOString(), '2026-11-01T04:00:00.000Z'); // 00:00 EDT
    assert.equal(new Date(window.resetMs).toISOString(), '2026-11-08T05:00:00.000Z'); // 00:00 EST
    assert.equal((window.resetMs - window.startMs) / 3600_000, 169);
    const atReset = fixedWeeklyWindow(window.resetMs, reset, Detroit);
    assert.equal(atReset.startMs, window.resetMs);
    const beforeStart = fixedWeeklyWindow(window.startMs - 1, reset, Detroit);
    assert.equal(beforeStart.resetMs, window.startMs);
  });

  it('fixed: a reset later today than now still belongs to last week', () => {
    // Tue 2026-11-17 09:00 EST, reset "tue 17:30": the window began Tue 2026-11-10 17:30.
    const window = fixedWeeklyWindow(Date.parse('2026-11-17T14:00:00Z'), parseWeeklyReset('tuesday 17:30'), Detroit);
    assert.equal(new Date(window.startMs).toISOString(), '2026-11-10T22:30:00.000Z');
    assert.equal(new Date(window.resetMs).toISOString(), '2026-11-17T22:30:00.000Z');
  });

  it('converts local wall time to UTC around both DST transitions', () => {
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, Detroit)).toISOString(), '2026-03-08T07:00:00.000Z');
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 3, day: 7, hour: 0, minute: 0 }, Detroit)).toISOString(), '2026-03-07T05:00:00.000Z');
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 7, day: 1, hour: 0, minute: 0 }, Detroit)).toISOString(), '2026-07-01T04:00:00.000Z');
    assert.equal(new Date(wallTimeToInstant({ year: 2026, month: 11, day: 17, hour: 0, minute: 0 }, 'Asia/Kolkata')).toISOString(), '2026-11-16T18:30:00.000Z');
  });
});

describe('Claude quota percentages and configuration', () => {
  const now = new Date('2026-11-17T12:00:00Z');

  it('flags usage over the limit without capping the number', () => {
    const quota = estimateClaudeQuota([entry('2026-11-17T11:00:00Z', 12)], { quotaConfig: quotaConfig(), now });
    assert.equal(quota.session.percent, 120);
    assert.equal(quota.session.overLimit, true);
    assert.equal(quota.weekly.overLimit, false);
  });

  it('uses the tokens metric when chosen, and leaves a window without a limit unscored', () => {
    const config = loadClaudeQuotaConfig({ CLAUDE_QUOTA_METRIC: 'tokens', CLAUDE_WEEKLY_LIMIT_TOKENS: '1e6' });
    const quota = estimateClaudeQuota([entry('2026-11-17T11:00:00Z', 5, 250_000)], { quotaConfig: config, now });
    assert.equal(quota.configured, true);
    assert.equal(quota.metric, 'tokens');
    assert.equal(quota.weekly.percent, 25);
    assert.equal(quota.session.limit, null);
    assert.equal(quota.session.percent, null);
    assert.equal(quota.session.overLimit, false);
    assert.equal(quota.session.used.tokens, 250_000);
  });

  it('is "not configured", with instructions, when no limit is set for the chosen metric', () => {
    const quota = estimateClaudeQuota([entry('2026-11-17T11:00:00Z', 2)], { quotaConfig: loadClaudeQuotaConfig({}), now });
    assert.equal(quota.estimate, true);
    assert.equal(quota.configured, false);
    assert.match(quota.howToConfigure, /CLAUDE_SESSION_LIMIT_USD/);
    assert.equal(quota.session.used.usd, 2, 'usage is still measured for calibration');
    assert.equal(quota.session.percent, null);
    const mismatched = estimateClaudeQuota([], { quotaConfig: loadClaudeQuotaConfig({ CLAUDE_SESSION_LIMIT_TOKENS: '5000' }), now });
    assert.equal(mismatched.configured, false);
    assert.match(mismatched.howToConfigure, /CLAUDE_QUOTA_METRIC=tokens/);
  });

  it('counts tokens but no dollars for unknown models, and skips synthetic messages', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    const base = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, timestamp: '2026-11-17T11:00:00Z' };
    const entries = quotaEntries([
      { ...base, model: 'claude-haiku-5-5' }, { ...base, model: 'claude-mystery-9' }, { ...base, model: '<synthetic>' },
    ], pricingTable);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].usd, null);
    const quota = estimateClaudeQuota(entries, { quotaConfig: quotaConfig(), now });
    assert.equal(quota.session.used.tokens, 2_000_000);
    assert.equal(quota.session.used.messages, 2);
    assert.equal(quota.session.used.unpricedMessages, 1);
    assert.equal(quota.session.used.usd, entries[0].usd);
  });

  it('validates the quota and auto-refresh environment', () => {
    assert.deepEqual(loadConfig({}).claudeQuota, {
      metric: 'usd', limits: { session: { tokens: null, usd: null }, weekly: { tokens: null, usd: null } }, weeklyReset: { mode: 'rolling', label: 'rolling 7 days' },
    });
    assert.throws(() => loadConfig({ CLAUDE_SESSION_LIMIT_USD: '0' }), /CLAUDE_SESSION_LIMIT_USD must be a positive number/);
    assert.throws(() => loadConfig({ CLAUDE_WEEKLY_LIMIT_TOKENS: 'lots' }), /CLAUDE_WEEKLY_LIMIT_TOKENS/);
    assert.throws(() => loadConfig({ CLAUDE_QUOTA_METRIC: 'messages' }), /CLAUDE_QUOTA_METRIC/);
    assert.deepEqual(parseWeeklyReset('Thursday 7:05'), { mode: 'fixed', dayOfWeek: 4, hour: 7, minute: 5, label: 'thu 07:05' });
    assert.equal(parseWeeklyReset(' ROLLING ').mode, 'rolling');
    for (const bad of ['funday 01:00', 'mo 00:00', 'mon 24:00', 'mon 00:60', 'mon', 'mon 0000']) {
      assert.throws(() => parseWeeklyReset(bad), /CLAUDE_WEEKLY_RESET/, bad);
    }
  });
});

describe('Claude provider quota payload', () => {
  it('puts the estimate on the summary and the recent windows in the detail', async () => {
    const record = {
      model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, sessionId: 's1', projectDir: '-home-testuser-repos',
    };
    const usageRecords = [{ ...record, messageId: 'm1', timestamp: '2026-11-17T10:30:00Z' }, { ...record, messageId: 'm2', timestamp: '2026-11-17T11:30:00Z' }];
    const provider = createClaudeProvider({
      pricingFilePath: PricingPath, adminKey: '', timeZone: Detroit, quotaConfig: loadClaudeQuotaConfig({ CLAUDE_SESSION_LIMIT_TOKENS: '800', CLAUDE_QUOTA_METRIC: 'tokens' }),
    });
    const { summary, detail } = await provider.collect({ now: new Date('2026-11-17T12:00:00Z'), reason: 'refresh', getTranscripts: async () => ({ usageRecords, stats: {} }) });
    assert.equal(summary.quota.estimate, true);
    assert.equal(summary.quota.session.percent, 50);
    assert.equal(summary.quota.session.resetAt, '2026-11-17T15:00:00.000Z');
    assert.equal(summary.quota.recentBlocks, undefined, 'the tile payload stays small');
    assert.equal(detail.quota.recentBlocks.length, 1);
    assert.equal(summary.warnings.length, 0);
  });

  it('defaults to an unconfigured estimate when no quota config is passed', async () => {
    const provider = createClaudeProvider({ pricingFilePath: PricingPath, adminKey: '', timeZone: 'UTC' });
    const { summary } = await provider.collect({ now: new Date(), reason: 'refresh', getTranscripts: async () => ({ usageRecords: [], stats: {} }) });
    assert.equal(summary.quota.configured, false);
  });
});
