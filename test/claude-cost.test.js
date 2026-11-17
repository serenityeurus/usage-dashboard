import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateClaudeUsage } from '../src/providers/claude/aggregate.js';
import { findModelRates, loadPricingTable, priceUsageRecord, validatePricingTable } from '../src/providers/claude/pricing.js';
import { createClaudeProvider } from '../src/providers/claude/index.js';
import { TranscriptScanner } from '../src/transcript-scanner.js';
import { computeWindows } from '../src/windows.js';

const TestDir = path.dirname(fileURLToPath(import.meta.url));
const PricingPath = path.join(TestDir, '..', 'config', 'pricing.json');
const FixtureRoot = path.join(TestDir, 'fixtures', 'claude-projects');

const baseRecord = {
  model: 'claude-opus-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
};
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

describe('pricing table', () => {
  it('ships a valid table that covers the current Claude 5 family', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    for (const modelId of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']) {
      assert.ok(findModelRates(pricingTable, modelId), modelId);
    }
  });

  it('rejects a table with a missing rate', () => {
    assert.throws(() => validatePricingTable({ models: { m: { input: 1 } } }), /cacheWrite5m/);
  });

  it('matches dated ids strictly and never by loose prefix', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    assert.ok(findModelRates(pricingTable, 'claude-opus-4-5-20251101'));
    assert.equal(findModelRates(pricingTable, 'claude-opus-4-9'), null);
    assert.equal(findModelRates(pricingTable, 'claude-opus-5-5-preview'), null);
    assert.equal(findModelRates(pricingTable, undefined), null);
  });
});

describe('priceUsageRecord', () => {
  it('prices every token type at its own rate, 1h cache writes included', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    const priced = priceUsageRecord(pricingTable, {
      ...baseRecord, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 1_000_000, cacheWrite1hTokens: 200_000,
    });
    assert.equal(priced.status, 'priced');
    closeTo(priced.costByTokenType.input, 0.004);
    closeTo(priced.costByTokenType.output, 0.04);
    closeTo(priced.costByTokenType.cacheRead, 0.2);
    closeTo(priced.costByTokenType.cacheWrite, 1.6);
    closeTo(priced.costUsd, 1.844);
  });

  it('switches to long-context rates above the threshold (boundary is exclusive)', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    const atThreshold = priceUsageRecord(pricingTable, { ...baseRecord, model: 'claude-haiku-5-5', inputTokens: 100_000 });
    closeTo(atThreshold.costUsd, 0.01);
    const overThreshold = priceUsageRecord(pricingTable, { ...baseRecord, model: 'claude-haiku-5-5', inputTokens: 100_001 });
    closeTo(overThreshold.costUsd, (100_001 * 0.5) / 1e6);
  });

  it('marks unknown models without inventing a cost and skips synthetic ones', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    assert.deepEqual(priceUsageRecord(pricingTable, { ...baseRecord, model: 'claude-opus-9-9' }).status, 'unknown');
    assert.equal(priceUsageRecord(pricingTable, { ...baseRecord, model: 'claude-opus-9-9' }).costUsd, null);
    assert.equal(priceUsageRecord(pricingTable, { ...baseRecord, model: '<synthetic>' }).status, 'unpriced');
  });

  it('adds Anthropic server-side web search requests', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    const priced = priceUsageRecord(pricingTable, { ...baseRecord, serverWebSearchRequests: 3 });
    closeTo(priced.costUsd, 0.03);
  });
});

describe('aggregateClaudeUsage on fixtures', () => {
  async function aggregateFixtures(timeZone) {
    const pricingTable = await loadPricingTable(PricingPath);
    const { usageRecords } = await new TranscriptScanner({ rootDir: FixtureRoot }).scan();
    return aggregateClaudeUsage(usageRecords, { pricingTable, timeZone, now: new Date('2026-11-17T12:00:00Z') });
  }

  it('totals cost across models and excludes unknown-model cost', async () => {
    const aggregate = await aggregateFixtures('America/Detroit');
    // opus a1 1.844 + sonnet a2 3.0 + haiku b1 long-context 0.0775
    closeTo(aggregate.totals.costUsd, 4.9215);
    assert.equal(aggregate.totals.messageCount, 4);
    assert.equal(aggregate.totals.unknownCostMessageCount, 1);
    assert.equal(aggregate.syntheticMessageCount, 1);
    assert.deepEqual(aggregate.unknownModels, [{ model: 'claude-opus-9-9', messageCount: 1 }]);
    assert.equal(aggregate.monthToDate.month, '2026-11');
    closeTo(aggregate.monthToDate.costUsd, 4.9215);
  });

  it('buckets days in the configured time zone', async () => {
    const detroitDays = (await aggregateFixtures('America/Detroit')).byDay.map((row) => row.day);
    assert.deepEqual(detroitDays, ['2026-11-01', '2026-11-02', '2026-11-03']);
    const utcDays = (await aggregateFixtures('UTC')).byDay;
    assert.equal(utcDays.find((row) => row.day === '2026-11-02').messageCount, 2);
  });

  it('groups by friendly project name and ranks sessions by cost', async () => {
    const aggregate = await aggregateFixtures('UTC');
    assert.deepEqual(aggregate.byProject.map((row) => row.project), ['alpha', 'repos']);
    assert.equal(aggregate.topSessions[0].sessionId, 'session-a');
    assert.equal(aggregate.topSessions[0].project, 'alpha');
    assert.equal(aggregate.sessionCount, 2);
    const tokenTypeCost = Object.values(aggregate.tokenTypes).reduce((sum, row) => sum + row.costUsd, 0);
    closeTo(tokenTypeCost, aggregate.totals.costUsd);
  });

  it('feeds unrounded per-day cost into the windows so they match the all-time total', async () => {
    // Haiku input is $0.10/Mtok, so 3 tokens cost $0.0000003: rounding each day to
    // 6 dp first gives 0 per day, while the true 3-day sum rounds to $0.000001.
    const usageRecords = ['2026-11-14', '2026-11-15', '2026-11-16'].map((day, index) => ({
      ...baseRecord, model: 'claude-haiku-5-5', inputTokens: 3, timestamp: `${day}T12:00:00Z`, sessionId: `s${index}`, projectDir: '-home-testuser-repos',
    }));
    const provider = createClaudeProvider({ pricingFilePath: PricingPath, adminKey: '', timeZone: 'UTC' });
    const now = new Date('2026-11-16T18:00:00Z');
    const { summary, timeSeries, detail } = await provider.collect({ now, reason: 'refresh', getTranscripts: async () => ({ usageRecords, stats: {} }) });
    assert.equal(summary.costUsd, 0.000001);
    const windows = computeWindows(timeSeries, { now, timeZone: 'UTC' });
    assert.equal(windows.allTime.costUsd, summary.costUsd);
    assert.equal(windows.last7Days.costUsd, summary.costUsd);
    assert.deepEqual(detail.byDay.map((row) => row.costUsd), [0, 0, 0], 'detail rows stay rounded for display');
    assert.equal(detail.byDayUnroundedCostUsd, undefined, 'internal helper must not leak into the API payload');
  });

  it('handles zero records', async () => {
    const pricingTable = await loadPricingTable(PricingPath);
    const aggregate = aggregateClaudeUsage([], { pricingTable, timeZone: 'UTC' });
    assert.equal(aggregate.totals.costUsd, 0);
    assert.deepEqual(aggregate.byDay, []);
    assert.deepEqual(aggregate.topSessions, []);
  });
});
