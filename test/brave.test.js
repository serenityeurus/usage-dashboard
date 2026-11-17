import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateWebSearchCalls } from '../src/providers/brave/history.js';
import { createQuotaProbe, parseRateLimitHeaders } from '../src/providers/brave/quota.js';

const headerGetter = (headers) => (name) => headers[name] ?? null;
const now = new Date('2026-11-17T12:00:00Z');

describe('parseRateLimitHeaders', () => {
  it('parses the documented two-window format', () => {
    const quota = parseRateLimitHeaders(headerGetter({
      'x-ratelimit-limit': '1, 15000',
      'x-ratelimit-policy': '1;w=1, 15000;w=2592000',
      'x-ratelimit-remaining': '1, 1000',
      'x-ratelimit-reset': '1, 1419704',
    }), now);
    assert.equal(quota.perSecond.limit, 1);
    assert.equal(quota.monthly.limit, 15000);
    assert.equal(quota.monthly.remaining, 1000);
    assert.equal(quota.monthlyUsed, 14000);
    assert.equal(quota.monthly.resetAt, new Date(now.getTime() + 1419704000).toISOString());
  });

  it('treats a monthly limit of 0 as unlimited', () => {
    const quota = parseRateLimitHeaders(headerGetter({
      'x-ratelimit-limit': '50, 0', 'x-ratelimit-policy': '50;w=1, 0;w=2592000', 'x-ratelimit-remaining': '49, 0', 'x-ratelimit-reset': '1, 100',
    }), now);
    assert.equal(quota.monthly.unlimited, true);
    assert.equal(quota.monthlyUsed, null);
  });

  it('falls back to header order when the policy header is absent', () => {
    const quota = parseRateLimitHeaders(headerGetter({ 'x-ratelimit-limit': '20,2000', 'x-ratelimit-remaining': '19,1500' }), now);
    assert.equal(quota.monthly.limit, 2000);
    assert.equal(quota.monthlyUsed, 500);
    assert.equal(quota.monthly.resetAt, null);
  });

  it('returns null when no rate-limit headers are present', () => {
    assert.equal(parseRateLimitHeaders(headerGetter({}), now), null);
  });
});

describe('createQuotaProbe', () => {
  function fakeFetch(status = 200) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), token: options.headers['X-Subscription-Token'] });
      return new Response('{}', { status, headers: { 'X-RateLimit-Limit': '1, 100', 'X-RateLimit-Remaining': '0, 40' } });
    };
    return { fetchImpl, calls };
  }

  it('reports not configured and never calls the network without a key', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const result = await createQuotaProbe({ apiKey: '', fetchImpl }).probe(now);
    assert.equal(result.configured, false);
    assert.equal(calls.length, 0);
  });

  it('throttles repeated probes inside the minimum interval', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const quotaProbe = createQuotaProbe({ apiKey: 'test-key', fetchImpl, minIntervalSeconds: 60 });
    const first = await quotaProbe.probe(now);
    assert.equal(first.quota.monthlyUsed, 60);
    const second = await quotaProbe.probe(new Date(now.getTime() + 10_000));
    assert.equal(second.throttled, true);
    await quotaProbe.probe(new Date(now.getTime() + 61_000));
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /count=1/);
  });

  it('coalesces concurrent probes into one request', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const quotaProbe = createQuotaProbe({ apiKey: 'test-key', fetchImpl, minIntervalSeconds: 0 });
    await Promise.all([quotaProbe.probe(now), quotaProbe.probe(now)]);
    assert.equal(calls.length, 1);
  });

  it('surfaces HTTP errors and network failures without throwing', async () => {
    const { fetchImpl } = fakeFetch(401);
    const unauthorized = await createQuotaProbe({ apiKey: 'bad', fetchImpl }).probe(now);
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.error, /401/);
    const failing = await createQuotaProbe({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } }).probe(now);
    assert.equal(failing.ok, false);
    assert.equal(failing.error, 'ECONNRESET');
  });
});

describe('aggregateWebSearchCalls', () => {
  const calls = [
    { toolUseId: 't1', timestamp: '2026-10-31T12:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-alpha' },
    { toolUseId: 't2', timestamp: '2026-11-01T12:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-alpha' },
    { toolUseId: 't3', timestamp: '2026-11-02T04:00:00Z', projectDir: '-Users-testuser-repos' },
    { toolUseId: 't4', timestamp: null, projectDir: '-Users-testuser-repos' },
  ];

  it('counts per day, agent and month with estimated spend', () => {
    const history = aggregateWebSearchCalls(calls, { timeZone: 'America/Detroit', costPer1k: 5, monthlyCreditUsd: 5, now });
    assert.equal(history.totalCount, 4);
    assert.equal(history.totalGrossUsd, 0.02);
    assert.deepEqual(history.byAgent.map((row) => [row.agent, row.count]), [['alpha', 2], ['repos', 2]]);
    assert.deepEqual(history.byDay.map((row) => row.day), ['2026-10-31', '2026-11-01', 'unknown']);
    assert.equal(history.monthToDate.count, 2);
    assert.equal(history.monthToDate.netUsd, 0); // within the free credit
  });

  it('bills only spend beyond the monthly credit', () => {
    const manyCalls = Array.from({ length: 1500 }, (_, index) => ({
      toolUseId: `t${index}`, timestamp: '2026-11-05T12:00:00Z', projectDir: 'x',
    }));
    const history = aggregateWebSearchCalls(manyCalls, { timeZone: 'UTC', costPer1k: 5, monthlyCreditUsd: 5, now });
    assert.equal(history.monthToDate.grossUsd, 7.5);
    assert.equal(history.monthToDate.netUsd, 2.5);
  });
});
