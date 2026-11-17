import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createDashboardState } from '../src/dashboard-state.js';
import { computeTotal } from '../src/total.js';
import { computeWindows, shiftDay } from '../src/windows.js';

// 2026-11-17T03:30Z is still 2026-11-16 in Detroit (UTC-5): day boundaries are local.
const now = new Date('2026-11-17T03:30:00Z');

describe('computeWindows', () => {
  const timeSeries = {
    metrics: ['costUsd', 'searches'],
    byDay: [
      { day: '2026-11-16', costUsd: 1.1, searches: 2 },
      { day: '2026-11-10', costUsd: 2, searches: 3 }, // exactly 6 days before: inside 7d
      { day: '2026-11-09', costUsd: 4, searches: 5 }, // 7 days before: outside
      { day: '2026-11-17', costUsd: 8, searches: 7 }, // "tomorrow" locally: all-time only
      { day: 'unknown', costUsd: 16, searches: 11 },
    ],
  };

  it('buckets today, last 7 days and all time in the local time zone', () => {
    const windows = computeWindows(timeSeries, { now, timeZone: 'America/Detroit' });
    assert.deepEqual(windows.range, { today: '2026-11-16', weekStart: '2026-11-10' });
    assert.deepEqual(windows.today, { costUsd: 1.1, searches: 2 });
    assert.deepEqual(windows.last7Days, { costUsd: 3.1, searches: 5 });
    assert.deepEqual(windows.allTime, { costUsd: 31.1, searches: 28 });
  });

  it('uses UTC day boundaries when asked', () => {
    const windows = computeWindows(timeSeries, { now, timeZone: 'UTC' });
    assert.equal(windows.range.today, '2026-11-17');
    assert.deepEqual(windows.today, { costUsd: 8, searches: 7 });
  });

  it('returns zeroed windows for an empty series and ignores unknown metrics', () => {
    const windows = computeWindows({ metrics: ['searches', 'bogus'], byDay: [] }, { now, timeZone: 'UTC' });
    assert.deepEqual(windows.metrics, ['searches']);
    assert.deepEqual(windows.allTime, { searches: 0 });
  });

  it('shifts days across month and DST boundaries', () => {
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('2026-11-03', -6), '2026-10-28');
  });
});

describe('computeTotal', () => {
  const entries = [
    {
      ok: true,
      summary: { id: 'claude', name: 'Claude', costKind: 'api-equivalent', windows: { today: { costUsd: 10, tokens: 100, messages: 2 }, last7Days: { costUsd: 20, tokens: 200, messages: 4 }, allTime: { costUsd: 30, tokens: 300, messages: 6 } } },
      timeSeries: { byDay: [{ day: '2026-11-16', costUsd: 10, tokens: 100 }] },
    },
    {
      ok: true,
      summary: { id: 'brave', name: 'Brave', costKind: 'estimated', active: false, windows: { today: { costUsd: 0.01, searches: 2 }, last7Days: { costUsd: 0.02, searches: 4 }, allTime: { costUsd: 0.1, searches: 20 } } },
      timeSeries: { byDay: [{ day: '2026-11-15', costUsd: 0.01, searches: 2 }, { day: 'unknown', costUsd: 1, searches: 1 }] },
    },
    {
      ok: true,
      summary: { id: 'searxng', name: 'SearXNG', costKind: 'actual', active: true, windows: { today: { costUsd: 0, searches: 3 }, last7Days: { costUsd: 0, searches: 3 }, allTime: { costUsd: 0, searches: 3 } } },
      timeSeries: { byDay: [{ day: '2026-11-16', costUsd: 0, searches: 3 }] },
    },
    { ok: false, summary: { id: 'broken', name: 'Broken' }, timeSeries: null },
  ];

  it('sums spend by cost kind and counts across providers', () => {
    const total = computeTotal(entries);
    assert.deepEqual(total.summary.windows.allTime, {
      costUsd: 30.1, costByKind: { actual: 0, 'api-equivalent': 30, estimated: 0.1 }, tokens: 300, searches: 23, messages: 6,
    });
    assert.equal(total.summary.windows.today.searches, 5);
    assert.equal(total.summary.providerCount, 4);
  });

  it('builds a per-day, per-provider breakdown without undated rows', () => {
    const total = computeTotal(entries);
    assert.deepEqual(total.detail.byDay.map((row) => [row.day, row.costUsd, row.searches, Object.keys(row.byProvider)]), [
      ['2026-11-15', 0.01, 2, ['brave']],
      ['2026-11-16', 10, 3, ['claude', 'searxng']],
    ]);
    assert.deepEqual(total.detail.providers.map((row) => [row.id, row.costKind, row.active]), [
      ['claude', 'api-equivalent', undefined], ['brave', 'estimated', false], ['searxng', 'actual', true], ['broken', 'estimated', undefined],
    ]);
  });
});

describe('dashboard state windows and probes', () => {
  it('attaches windows to summaries and a total to the snapshot', async () => {
    const provider = {
      id: 'p', name: 'P',
      async collect() {
        return { summary: { id: 'p', name: 'P', costKind: 'actual', costUsd: 1 }, detail: {}, timeSeries: { metrics: ['costUsd'], byDay: [{ day: '2026-11-16', costUsd: 1 }] } };
      },
    };
    const state = createDashboardState({ providers: [provider], transcriptScanner: { scan: async () => ({}) }, clock: () => now, timeZone: 'America/Detroit' });
    const snapshot = await state.refresh('startup');
    assert.deepEqual(snapshot.providers.p.summary.windows.today, { costUsd: 1 });
    assert.equal(snapshot.total.summary.windows.allTime.costByKind.actual, 1);
  });

  it('never drops an explicit probe request that arrives during a plain refresh', async () => {
    const seenProbes = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const provider = {
      id: 'p', name: 'P',
      async collect(context) {
        seenProbes.push([...context.probes]);
        if (seenProbes.length === 1) await gate;
        return { summary: { id: 'p', name: 'P' }, detail: {} };
      },
    };
    const state = createDashboardState({ providers: [provider], transcriptScanner: { scan: async () => ({}) } });
    const plain = state.refresh('refresh');
    const plainAgain = state.refresh('refresh'); // coalesces
    const probing = state.refresh('refresh', { probes: ['brave'] }); // must run its own pass
    release();
    await Promise.all([plain, plainAgain, probing]);
    assert.deepEqual(seenProbes, [[], ['brave']]);
  });
});

describe('loadConfig', () => {
  it('defaults the time zone to America/Detroit and the provider to brave', () => {
    const config = loadConfig({});
    assert.equal(config.timeZone, 'America/Detroit');
    assert.equal(config.webSearchProvider, 'brave');
    assert.equal(config.braveQuotaProbe, 'auto');
    assert.deepEqual(config.allowedHosts, []);
  });

  it('reads the provider flag, cutover history, hosts and SearXNG URL', () => {
    const config = loadConfig({
      TZ: 'UTC', WEB_SEARCH_PROVIDER: 'SearXNG', WEB_SEARCH_PROVIDER_HISTORY: 'searxng@2026-11-17T21:00:00Z',
      ALLOWED_HOSTS: 'dash.lan, 10.0.0.5:8787', SEARXNG_BASE_URL: 'http://host.docker.internal:8888/', HOST_PORT: '9000', BRAVE_QUOTA_PROBE: 'false',
    });
    assert.equal(config.timeZone, 'UTC');
    assert.equal(config.webSearchProvider, 'searxng');
    assert.equal(config.webSearchProviderHistory[0].provider, 'searxng');
    assert.deepEqual(config.allowedHosts, ['dash.lan', '10.0.0.5:8787']);
    assert.equal(config.searxngBaseUrl, 'http://host.docker.internal:8888');
    assert.equal(config.hostPort, 9000);
    assert.equal(config.braveQuotaProbe, 'false');
  });

  it('rejects invalid values instead of guessing', () => {
    assert.throws(() => loadConfig({ WEB_SEARCH_PROVIDER: 'google' }), /WEB_SEARCH_PROVIDER/);
    assert.throws(() => loadConfig({ BRAVE_QUOTA_PROBE: 'yes' }), /BRAVE_QUOTA_PROBE/);
    assert.throws(() => loadConfig({ SEARXNG_BASE_URL: 'ftp://x' }), /SEARXNG_BASE_URL/);
    assert.throws(() => loadConfig({ TZ: 'Mars/Olympus' }), /time zone/);
  });
});
