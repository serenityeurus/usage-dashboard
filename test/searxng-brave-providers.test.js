import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRequest, createHostPolicy, parseHostHeader } from '../src/http-guard.js';
import { createBraveProvider, decideQuotaProbe } from '../src/providers/brave/index.js';
import { createOtherWebSearchProvider } from '../src/providers/other-search/index.js';
import { resolveActiveWebSearchProvider } from '../src/web-search-attribution.js';
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
    const policy = createHostPolicy({ ports: [8787, 9000], extraHosts: ['dash.lan', 'proxy.lan:443'] });
    assert.ok(policy.isAllowedHost('localhost:8787'));
    assert.ok(policy.isAllowedHost('127.0.0.1:9000'));
    assert.ok(policy.isAllowedHost('[::1]'));
    assert.ok(policy.isAllowedHost('dash.lan:8787'));
    assert.ok(policy.isAllowedHost('proxy.lan:443'));
    assert.ok(!policy.isAllowedHost('localhost:22'));
    assert.ok(!policy.isAllowedHost('dash.lan:22'));
    // A bare Host matches a host:443 entry, since clients omit default ports (reverse proxy case).
    assert.ok(policy.isAllowedHost('proxy.lan'));
    assert.ok(!policy.isAllowedHost('proxy.lan:8443'));
    assert.ok(!policy.isAllowedHost('rebind.attacker.example:8787'));
    assert.ok(policy.isAllowedOrigin('http://localhost:8787'));
    assert.ok(!policy.isAllowedOrigin('http://localhost:8787.evil.example'));
  });

  it('compares the effective Origin port, so default ports 80/443 do not slip through', () => {
    const policy = createHostPolicy({ ports: [8787], extraHosts: ['proxy.lan:443', 'dash.lan'] });
    // URL drops default ports: these used to reach isAllowedHost as a bare host and pass.
    for (const origin of ['http://localhost', 'https://localhost', 'http://127.0.0.1:80', 'https://127.0.0.1:443', 'http://[::1]', 'http://dash.lan']) {
      assert.ok(!policy.isAllowedOrigin(origin), origin);
    }
    for (const origin of ['http://localhost:8787', 'http://LOCALHOST.:8787', 'http://[::1]:8787', 'https://proxy.lan', 'https://proxy.lan:443', 'http://dash.lan:8787']) {
      assert.ok(policy.isAllowedOrigin(origin), origin);
    }
    assert.ok(!policy.isAllowedOrigin('http://proxy.lan')); // effective port 80, entry says 443
  });

  it('throws on malformed allowlist entries instead of dropping them', () => {
    for (const entry of ['http://dash.lan', 'dash.lan/', 'fe80::1', 'garbage:x', 'a b']) {
      assert.throws(() => createHostPolicy({ extraHosts: [entry] }), /ALLOWED_HOSTS entry/, entry);
    }
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
      baseUrl: 'http://searx:8888', timeZone: 'America/Detroit', webSearchProvider: 'searxng', attributionOptions,
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

describe('active web_search provider when WEB_SEARCH_PROVIDER is unset', () => {
  const braveFetch = () => fakeFetch([[/search\.brave\.com/, 200, '{}']]);

  it('falls back to the most recently recorded provider and never auto-probes', async () => {
    const { fetchImpl, requested } = braveFetch();
    const brave = createBraveProvider({
      apiKey: 'test-key', costPer1k: 5, monthlyCreditUsd: 5, timeZone: 'UTC', fetchImpl, quotaMinIntervalSeconds: 0,
      quotaProbeMode: 'auto', webSearchProvider: null, attributionOptions,
    });
    const searxng = createSearxngProvider({ baseUrl: '', timeZone: 'UTC', webSearchProvider: null, attributionOptions });
    // Calls are out of order on purpose: x1 (searxng, 21:30Z) is the latest recorded one; x2 has no recorded provider.
    const shuffled = [calls[2], calls[0], calls[3], calls[1]];
    const shuffledContext = context({ getTranscripts: async () => ({ webSearchCalls: shuffled, stats: {} }) });
    const braveResult = await brave.collect(shuffledContext);
    const searxngResult = await searxng.collect(shuffledContext);
    assert.equal(requested.length, 0, 'auto must not spend a query while the active provider is only inferred');
    assert.equal(braveResult.summary.active, false);
    assert.equal(searxngResult.summary.active, true);
    assert.deepEqual(searxngResult.summary.activeProvider, { id: 'searxng', source: 'transcripts', at: '2026-11-17T21:30:00Z' });
    assert.match(braveResult.detail.quotaProbe.reason, /WEB_SEARCH_PROVIDER is unset/);
  });

  it('does not auto-probe even when Brave is the latest recorded provider; explicit probes still run', async () => {
    const { fetchImpl, requested } = braveFetch();
    const brave = createBraveProvider({
      apiKey: 'test-key', costPer1k: 5, monthlyCreditUsd: 5, timeZone: 'UTC', fetchImpl, quotaMinIntervalSeconds: 0,
      quotaProbeMode: 'auto', webSearchProvider: null, attributionOptions,
    });
    const braveOnly = context({ getTranscripts: async () => ({ webSearchCalls: [calls[0], calls[1]], stats: {} }) });
    const result = await brave.collect(braveOnly);
    assert.equal(result.summary.active, true);
    assert.equal(requested.length, 0);
    await brave.collect({ ...braveOnly, probes: new Set(['brave']) });
    assert.equal(requested.length, 1);
  });

  it('reports unknown when no call recorded a provider', () => {
    assert.deepEqual(resolveActiveWebSearchProvider(null, [calls[3]]), { id: null, source: 'unknown', at: null });
    assert.deepEqual(resolveActiveWebSearchProvider(null, []), { id: null, source: 'unknown', at: null });
    assert.deepEqual(resolveActiveWebSearchProvider('brave', [calls[2]]), { id: 'brave', source: 'configured', at: null });
  });

  it('shows the unknown state on the tiles', async () => {
    const searxng = createSearxngProvider({ baseUrl: '', timeZone: 'UTC', webSearchProvider: null, attributionOptions });
    const { summary } = await searxng.collect(context({ getTranscripts: async () => ({ webSearchCalls: [], stats: {} }) }));
    assert.equal(summary.active, false);
    assert.equal(summary.secondaryMetrics.find((metric) => metric.label === 'Active web_search backend').value, 'unknown (WEB_SEARCH_PROVIDER unset, none recorded)');
  });
});

describe('unrecognised web_search providers', () => {
  it('counts them as "other" searches with no spend', async () => {
    const otherCalls = [
      ...calls,
      { toolUseId: 'p1', recordedProvider: 'perplexity', timestamp: '2026-11-17T22:30:00Z', projectDir: '-Users-testuser--openclaw-workspace-beta' },
      { toolUseId: 'p2', recordedProvider: 'tavily', timestamp: '2026-11-16T12:00:00Z', projectDir: '-Users-testuser--openclaw-workspace-alpha' },
    ];
    const provider = createOtherWebSearchProvider({ timeZone: 'UTC', attributionOptions });
    const { summary, detail, timeSeries } = await provider.collect(context({ getTranscripts: async () => ({ webSearchCalls: otherCalls, stats: {} }) }));
    assert.equal(summary.id, 'other-search');
    assert.equal(summary.costUsd, null);
    assert.equal(summary.hidden, false);
    assert.deepEqual(timeSeries.metrics, ['searches'], 'no costUsd metric: unknown backends add searches, never spend');
    assert.deepEqual(timeSeries.byDay, [{ day: '2026-11-16', searches: 1 }, { day: '2026-11-17', searches: 1 }]);
    assert.deepEqual(detail.byProvider, [{ provider: 'perplexity', count: 1 }, { provider: 'tavily', count: 1 }]);
    const empty = await provider.collect(context());
    assert.equal(empty.summary.hidden, true);
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
    const { provider } = braveWithCountingFetch({ webSearchProvider: 'searxng' });
    const { summary, detail } = await provider.collect(context());
    assert.equal(summary.primaryMetric.value, 2);
    assert.equal(summary.costKind, 'estimated');
    assert.equal(summary.active, false);
    assert.deepEqual(detail.attribution, { recorded: 2, cutover: 0, fallback: 0 });
  });

  it('skips the paid probe while inactive unless explicitly requested', async () => {
    const { provider, requested } = braveWithCountingFetch({ webSearchProvider: 'searxng', quotaProbeMode: 'auto' });
    const plain = await provider.collect(context());
    assert.equal(requested.length, 0);
    assert.equal(plain.detail.quotaProbe.ranThisRefresh, false);
    await provider.collect(context({ probes: new Set(['brave']) }));
    assert.equal(requested.length, 1);
  });

  it('probes on refresh while active, and never when BRAVE_QUOTA_PROBE=false', async () => {
    const active = braveWithCountingFetch({ webSearchProvider: 'brave' });
    await active.provider.collect(context());
    assert.equal(active.requested.length, 1);
    const disabled = braveWithCountingFetch({ webSearchProvider: 'brave', quotaProbeMode: 'false' });
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
    assert.equal(decideQuotaProbe({ ...base, activeSource: 'transcripts' }).probe, false);
    assert.equal(decideQuotaProbe({ ...base, activeSource: 'unknown', mode: 'true' }).probe, true);
  });
});
