import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createDashboardState } from '../src/dashboard-state.js';
import { createHostPolicy } from '../src/http-guard.js';
import { createBraveProvider, decideQuotaProbe } from '../src/providers/brave/index.js';
import { createRequestHandler, startAutoRefresh } from '../src/server.js';

const PublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const emptyScanner = { scan: async () => ({ usageRecords: [], webSearchCalls: [], stats: {} }) };

describe('AUTO_REFRESH_SECONDS', () => {
  it('defaults to 300 and accepts 0 (off) or integers >= 30', () => {
    assert.equal(loadConfig({}).autoRefreshSeconds, 300);
    assert.equal(loadConfig({ AUTO_REFRESH_SECONDS: '' }).autoRefreshSeconds, 300);
    assert.equal(loadConfig({ AUTO_REFRESH_SECONDS: '0' }).autoRefreshSeconds, 0);
    assert.equal(loadConfig({ AUTO_REFRESH_SECONDS: '30' }).autoRefreshSeconds, 30);
    assert.equal(loadConfig({ AUTO_REFRESH_SECONDS: ' 600 ' }).autoRefreshSeconds, 600);
  });

  it('rejects anything else with a clear error', () => {
    for (const bad of ['29', '5', '-30', '1.5', '60s', 'abc', '1e3']) {
      assert.throws(() => loadConfig({ AUTO_REFRESH_SECONDS: bad }), /AUTO_REFRESH_SECONDS must be an integer, 0 \(disabled\) or >= 30/, bad);
    }
  });
});

describe('auto refresh never spends a Brave query', () => {
  it('decideQuotaProbe: reason auto never probes, whatever the mode', () => {
    for (const mode of ['auto', 'true', 'false']) {
      for (const explicitlyRequested of [false, true]) {
        const decision = decideQuotaProbe({ mode, active: true, activeSource: 'configured', probeOnStartup: true, reason: 'auto', explicitlyRequested });
        assert.equal(decision.probe, false, `mode=${mode} explicit=${explicitlyRequested}`);
        assert.match(decision.why, /auto refreshes never probe/);
      }
    }
    // Startup and manual refresh are unchanged.
    const base = { mode: 'true', active: true, activeSource: 'configured', probeOnStartup: true, explicitlyRequested: false };
    assert.equal(decideQuotaProbe({ ...base, reason: 'startup' }).probe, true);
    assert.equal(decideQuotaProbe({ ...base, reason: 'refresh' }).probe, true);
  });

  it('the Brave provider makes no network call on an auto refresh, even with BRAVE_QUOTA_PROBE=true', async () => {
    const requested = [];
    const fetchImpl = async (url) => { requested.push(String(url)); return new Response('{}', { status: 200 }); };
    const brave = createBraveProvider({
      apiKey: 'test-key', costPer1k: 5, monthlyCreditUsd: 5, timeZone: 'UTC', fetchImpl, quotaMinIntervalSeconds: 0, quotaProbeMode: 'true', webSearchProvider: 'brave',
    });
    const context = (reason) => ({ now: new Date(), reason, probes: new Set(), getTranscripts: async () => ({ webSearchCalls: [], stats: {} }) });
    const { detail } = await brave.collect(context('auto'));
    assert.equal(requested.length, 0);
    assert.equal(detail.quotaProbe.ranThisRefresh, false);
    await brave.collect(context('refresh'));
    assert.equal(requested.length, 1, 'a manual refresh still probes in this mode');
  });
});

describe('dashboard state refresh coalescing with auto runs', () => {
  function slowState() {
    const reasons = [];
    let release;
    const gate = () => new Promise((resolve) => { release = resolve; });
    const provider = {
      id: 'p', name: 'P',
      async collect(context) { reasons.push(context.reason); await gate(); return { summary: { id: 'p' }, detail: null }; },
    };
    const state = createDashboardState({ providers: [provider], transcriptScanner: emptyScanner });
    return { state, reasons, release: () => release() };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('a manual refresh during an auto run waits for it and then runs its own', async () => {
    const { state, reasons, release } = slowState();
    const autoRun = state.refresh('auto');
    await tick();
    const manualRun = state.refresh('refresh');
    await tick();
    assert.deepEqual(reasons, ['auto']);
    release();
    await autoRun;
    await tick();
    assert.deepEqual(reasons, ['auto', 'refresh']);
    release();
    assert.equal((await manualRun).refreshReason, 'refresh');
  });

  it('an auto refresh during a manual run shares it', async () => {
    const { state, reasons, release } = slowState();
    const manualRun = state.refresh('refresh');
    await tick();
    const autoRun = state.refresh('auto');
    release();
    assert.equal(await autoRun, await manualRun);
    assert.deepEqual(reasons, ['refresh']);
  });
});

describe('startAutoRefresh', () => {
  function fakeTimers() {
    const timers = [];
    return {
      timers,
      setIntervalImpl: (callback, ms) => { const timer = { callback, ms, unrefCalled: false, unref() { this.unrefCalled = true; } }; timers.push(timer); return timer; },
      clearIntervalImpl: (timer) => { timer.cleared = true; },
    };
  }
  const quietLogger = { lines: [], log(line) { this.lines.push(line); }, error(line) { this.lines.push(`ERR ${line}`); } };

  it('schedules an unref\'d interval that runs refresh("auto")', async () => {
    const reasons = [];
    const dashboardState = { isRefreshing: () => false, refresh: async (reason) => { reasons.push(reason); return { durationMs: 1 }; } };
    const { timers, setIntervalImpl, clearIntervalImpl } = fakeTimers();
    const autoRefresh = startAutoRefresh({ dashboardState, intervalSeconds: 300, logger: quietLogger, setIntervalImpl, clearIntervalImpl });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 300_000);
    assert.equal(timers[0].unrefCalled, true);
    assert.equal(await autoRefresh.tick(), 'ran');
    assert.deepEqual(reasons, ['auto']);
    autoRefresh.stop();
    assert.equal(timers[0].cleared, true);
  });

  it('skips a tick while a refresh is in flight, and survives a failing refresh', async () => {
    let refreshing = true;
    let calls = 0;
    const dashboardState = { isRefreshing: () => refreshing, refresh: async () => { calls += 1; throw new Error('scan failed'); } };
    const { setIntervalImpl, clearIntervalImpl } = fakeTimers();
    const autoRefresh = startAutoRefresh({ dashboardState, intervalSeconds: 30, logger: quietLogger, setIntervalImpl, clearIntervalImpl });
    assert.equal(await autoRefresh.tick(), 'skipped');
    assert.equal(calls, 0);
    refreshing = false;
    assert.equal(await autoRefresh.tick(), 'failed');
    assert.equal(calls, 1);
  });

  it('does nothing when disabled (0)', () => {
    const { timers, setIntervalImpl } = fakeTimers();
    startAutoRefresh({ dashboardState: {}, intervalSeconds: 0, setIntervalImpl }).stop();
    assert.equal(timers.length, 0);
  });
});

describe('API exposes the auto-refresh interval', () => {
  it('in /api/summary, /api/total and /api/providers/:id', async () => {
    const provider = { id: 'p', name: 'P', collect: async () => ({ summary: { id: 'p', name: 'P' }, detail: {} }) };
    const dashboardState = createDashboardState({ providers: [provider], transcriptScanner: emptyScanner });
    await dashboardState.refresh('startup');
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    server.on('request', createRequestHandler({
      dashboardState, publicDir: PublicDir, hostPolicy: createHostPolicy({ ports: [port] }), autoRefreshSeconds: 300,
    }));
    try {
      for (const apiPath of ['/api/summary', '/api/total', '/api/providers/p']) {
        const body = await (await fetch(`http://127.0.0.1:${port}${apiPath}`)).json();
        assert.equal(body.autoRefreshSeconds, 300, apiPath);
      }
    } finally {
      server.close();
    }
  });
});
