import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRequest, createHostPolicy, parseHostHeader } from '../src/http-guard.js';
import { createBraveProvider, decideQuotaProbe } from '../src/providers/brave/index.js';
import { checkSearxngHealth } from '../src/providers/searxng/health.js';
import { createSearxngProvider } from '../src/providers/searxng/index.js';

const now = new Date('2026-11-17T23:00:00Z');
const calls = [
  { toolUseId: 'b1', recordedProvider: 'brave', timestamp: '2026-11-17T15:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-alpha' },
  { toolUseId: 'b2', recordedProvider: 'brave', timestamp: '2026-11-10T15:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-alpha' },
  { toolUseId: 'x1', recordedProvider: 'searxng', timestamp: '2026-11-17T21:30:00Z', projectDir: '-Users-testuser--openclaw-workspace-beta' },
  { toolUseId: 'x2', recordedProvider: null, timestamp: '2026-11-17T22:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-beta' },
];
const attributionOptions = { history: [{ provider: 'searxng', startAt: '2026-11-17T21:00:00.000Z', startMs: Date.parse('2026-11-17T21:00:00Z') }] };
const context = (overrides = {}) => ({
  now, reason: 'refresh', probes: new Set(), getTranscripts: async () => ({ webSearchCalls: calls, stats: {} }), ...overrides,
});

function fakeFetch(routes) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    const route = routes.find(([pattern]) => pattern.test(String(url)));
    if (!route) throw new Error('ECONNREFUSED');
    const [, status, body] = route;
    return new Response(body, { status });
  };
  return { fetchImpl, requested };
}

describe('http-guard', () => {
  it('parses Host headers strictly', () => {
    assert.deepEqual(parseHostHeader('LocalHost:8787'), { hostname: 'localhost', port: 8787 });
    assert.deepEqual(parseHostHeader('[::1]:8787'), { hostname: '[::1]', port: 8787 });
    assert.deepEqual(parseHostHeader('example.com.'), { hostname: 'example.com', port: null });
    for (const bad of [undefined, '', ':8787', 'a:b', 'a:0', 'a:70000', '::1', '[::1', '[::1]x', 'a@b', 'a/b']) {
      assert.equal(parseHostHeader(bad), null, String(bad));
    }
  });

  it('allows default hosts only on configured ports, ALLOWED_HOSTS entries as written', () => {
    const policy = createHostPolicy({ ports: [8787, 9000], extraHosts: ['dash.lan', 'proxy.lan:443', 'garbage:x'] });
    assert.ok(policy.isAllowedHost('localhost:8787'));
    assert.ok(policy.isAllowedHost('127.0.0.1:9000'));
    assert.ok(policy.isAllowedHost('[::1]'));
    assert.ok(policy.isAllowedHost('dash.lan:8787'));
    assert.ok(policy.isAllowedHost('proxy.lan:443'));
    assert.ok(!policy.isAllowedHost('localhost:22'));
    assert.ok(!policy.isAllowedHost('dash.lan:22'));
    assert.ok(!policy.isAllowedHost('proxy.lan'));
    assert.ok(!policy.isAllowedHost('rebind.attacker.example:8787'));
    assert.ok(policy.isAllowedOrigin('http://localhost:8787'));
    assert.ok(!policy.isAllowedOrigin('http://localhost:8787.evil.example'));
  });

  it('only checks Origin on state-changing methods', () => {
    const policy = createHostPolicy({ ports: [8787] });
    const request = (method, origin) => ({ method, headers: { host: 'localhost:8787', ...(origin ? { origin } : {}) } });
    assert.equal(checkRequest(request('GET', 'https://evil.example'), policy), null);
    assert.equal(checkRequest(request('POST'), policy), null);
    assert.equal(checkRequest(request('POST', 'https://evil.example'), policy).status, 403);
    assert.equal(checkRequest(request('DELETE', 'null'), policy).status, 403);
    assert.equal(checkRequest({ method: 'GET', headers: {} }, policy).status, 403);
  });
});

describe('SearXNG health check', () => {
  it('reports not configured without a base URL and never calls the network', async () => {
    const { fetchImpl, requested } = fakeFetch([]);
    assert.deepEqual(await checkSearxngHealth({ baseUrl: '', fetchImpl }), { configured: false });
    assert.equal(requested.length, 0);
  });

  it('uses /healthz when available', async () => {
    const { fetchImpl, requested } = fakeFetch([[/\/healthz$/, 200, 'OK']]);
    const health = await checkSearxngHealth({ baseUrl: 'http://searx:8888', fetchImpl });
    assert.equal(health.ok, true);
    assert.equal(health.method, 'healthz');
    assert.deepEqual(requested, ['http://searx:8888/healthz']);
    assert.ok(health.latencyMs >= 0);
  });

  it('falls back to a JSON search probe when /healthz is missing, keeping a base path', async () => {
    const { fetchImpl, requested } = fakeFetch([[/\/healthz$/, 404, 'nope'], [/\/search\?/, 200, '{"results":[]}']]);
    const health = await checkSearxngHealth({ baseUrl: 'https://proxy.lan/searx', fetchImpl });
    assert.equal(health.ok, true);
    assert.equal(health.method, 'search');
    assert.match(requested[1], /^https:\/\/proxy\.lan\/searx\/search\?q=.*&format=json$/);
  });

  it('is unhealthy when both fail, or when search returns non-JSON (format=json disabled)', async () => {
    const down = await checkSearxngHealth({ baseUrl: 'http://searx:8888', fetchImpl: fakeFetch([]).fetchImpl });
    assert.equal(down.ok, false);
    assert.match(down.error, /healthz: ECONNREFUSED; search: ECONNREFUSED/);
    const html = await checkSearxngHealth({ baseUrl: 'http://searx:8888', fetchImpl: fakeFetch([[/\/healthz$/, 500, ''], [/\/search/, 200, '<html>']]).fetchImpl });
    assert.equal(html.ok, false);
    assert.match(html.error, /format=json/);
  });
});

describe('SearXNG provider', () => {
  it('counts only SearXNG-attributed searches at $0 actual, with health and active badge', async () => {
    const provider = createSearxngProvider({
      baseUrl: 'http://searx:8888', timeZone: 'America/Detroit', active: true, attributionOptions,
      fetchImpl: fakeFetch([[/healthz/, 200, 'OK']]).fetchImpl,
    });
    const { summary, detail, timeSeries } = await provider.collect(context());
    assert.equal(summary.active, true);
    assert.equal(summary.costKind, 'actual');
    assert.equal(summary.costUsd, 0);
    assert.equal(summary.primaryMetric.value, 2);
    assert.match(summary.secondaryMetrics.find((metric) => metric.label === 'Instance health').value, /^up \(\d+ ms\)$/);
    assert.deepEqual(detail.attribution, { recorded: 1, cutover: 1, fallback: 0 });
    assert.deepEqual(detail.byAgent.map((row) => [row.agent, row.count]), [['beta', 2]]);
    assert.deepEqual(timeSeries.byDay, [{ day: '2026-11-17', costUsd: 0, searches: 2 }]);
  });

  it('warns when the instance is down or not configured', async () => {
    const down = await createSearxngProvider({ baseUrl: 'http://searx:8888', timeZone: 'UTC', fetchImpl: fakeFetch([]).fetchImpl }).collect(context());
    assert.match(down.summary.warnings[0], /unhealthy/);
    const unset = await createSearxngProvider({ baseUrl: '', timeZone: 'UTC' }).collect(context());
    assert.match(unset.summary.warnings[0], /SEARXNG_BASE_URL/);
  });
});

describe('Brave provider with SearXNG active', () => {
  function braveWithCountingFetch(options) {
    const { fetchImpl, requested } = fakeFetch([[/search\.brave\.com/, 200, '{}']]);
    const provider = createBraveProvider({
      apiKey: 'test-key', costPer1k: 5, monthlyCreditUsd: 5, timeZone: 'America/Detroit', fetchImpl, quotaMinIntervalSeconds: 0, attributionOptions, ...options,
    });
    return { provider, requested };
  }

  it('stops counting searches that SearXNG served', async () => {
    const { provider } = braveWithCountingFetch({ active: false });
    const { summary, detail } = await provider.collect(context());
    assert.equal(summary.primaryMetric.value, 2);
    assert.equal(summary.costKind, 'estimated');
    assert.equal(summary.active, false);
    assert.deepEqual(detail.attribution, { recorded: 2, cutover: 0, fallback: 0 });
  });

  it('skips the paid probe while inactive unless explicitly requested', async () => {
    const { provider, requested } = braveWithCountingFetch({ active: false, quotaProbeMode: 'auto' });
    const plain = await provider.collect(context());
    assert.equal(requested.length, 0);
    assert.equal(plain.detail.quotaProbe.ranThisRefresh, false);
    await provider.collect(context({ probes: new Set(['brave']) }));
    assert.equal(requested.length, 1);
  });

  it('probes on refresh while active, and never when BRAVE_QUOTA_PROBE=false', async () => {
    const active = braveWithCountingFetch({ active: true });
    await active.provider.collect(context());
    assert.equal(active.requested.length, 1);
    const disabled = braveWithCountingFetch({ active: true, quotaProbeMode: 'false' });
    await disabled.provider.collect(context({ probes: new Set(['brave']) }));
    assert.equal(disabled.requested.length, 0);
  });

  it('decides probes from mode, active flag and startup setting', () => {
    const base = { mode: 'auto', active: true, probeOnStartup: true, reason: 'refresh', explicitlyRequested: false };
    assert.equal(decideQuotaProbe(base).probe, true);
    assert.equal(decideQuotaProbe({ ...base, reason: 'startup', probeOnStartup: false }).probe, false);
    assert.equal(decideQuotaProbe({ ...base, active: false }).probe, false);
    assert.equal(decideQuotaProbe({ ...base, mode: 'true', active: false }).probe, true);
    assert.equal(decideQuotaProbe({ ...base, active: false, explicitlyRequested: true }).probe, true);
    assert.equal(decideQuotaProbe({ ...base, mode: 'false', explicitlyRequested: true }).probe, false);
  });
});
