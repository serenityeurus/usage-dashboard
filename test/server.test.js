import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDashboardState } from '../src/dashboard-state.js';
import { createHostPolicy } from '../src/http-guard.js';
import { createRequestHandler } from '../src/server.js';
import { friendlyProjectName } from '../src/util.js';
import { fetchAdminUsage, summarizeCostBuckets } from '../src/providers/claude/admin-api.js';

const PublicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

describe('friendlyProjectName', () => {
  it('derives agent names from encoded project dirs', () => {
    assert.equal(friendlyProjectName('-Users-testuser--openclaw-workspace-droid'), 'droid');
    assert.equal(friendlyProjectName('-Users-testuser--openclaw-workspace-release-manager'), 'release-manager');
    assert.equal(friendlyProjectName('-Users-testuser--openclaw'), 'openclaw');
    assert.equal(friendlyProjectName('-home-testuser-repos'), 'repos');
    assert.equal(friendlyProjectName(''), 'unknown');
  });
});

describe('dashboard state and HTTP API', () => {
  let server;
  let baseUrl;
  let port;
  let collectCount = 0;
  let scanCount = 0;

  before(async () => {
    const transcriptScanner = { scan: async () => { scanCount += 1; return { usageRecords: [], webSearchCalls: [], stats: {} }; } };
    const providers = [
      {
        id: 'good', name: 'Good',
        async collect(context) {
          collectCount += 1;
          await context.getTranscripts();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { summary: { id: 'good', name: 'Good', costUsd: collectCount }, detail: { collectCount } };
        },
      },
      { id: 'bad', name: 'Bad', async collect(context) { await context.getTranscripts(); throw new Error('boom'); } },
    ];
    const dashboardState = createDashboardState({ providers, transcriptScanner });
    await dashboardState.refresh('startup');
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    // The policy needs the real port, which only exists after listen().
    const hostPolicy = createHostPolicy({ ports: [port], extraHosts: ['dashboard.lan'] });
    server.on('request', createRequestHandler({ dashboardState, publicDir: PublicDir, hostPolicy }));
    baseUrl = `http://127.0.0.1:${port}`;
  });

  // fetch() cannot override Host, so raw requests go through node:http.
  function rawRequest({ method = 'GET', path: requestPath, headers = {} }) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers, setHost: !('host' in headers) }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      request.on('error', reject);
      request.end();
    });
  }

  it('rejects requests whose Host header is not allowed (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `localhost.evil.example:${port}`, '', 'localhost:99999', 'a b']) {
      const response = await rawRequest({ path: '/api/summary', headers: { host } });
      assert.equal(response.status, 403, `host "${host}"`);
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost', `LOCALHOST.:${port}`, `dashboard.lan:${port}`]) {
      const response = await rawRequest({ path: '/healthz', headers: { host } });
      assert.equal(response.status, 200, `host "${host}"`);
    }
  });

  it('rejects a POST with a foreign or opaque Origin, allows same-origin and no Origin', async () => {
    const before = collectCount;
    for (const origin of ['https://evil.example', `http://evil.example:${port}`, 'null', 'not a url', `file://localhost:${port}`]) {
      const response = await rawRequest({ method: 'POST', path: '/api/refresh', headers: { origin } });
      assert.equal(response.status, 403, `origin "${origin}"`);
    }
    assert.equal(collectCount, before, 'a rejected POST must not trigger a refresh');
    const sameOrigin = await rawRequest({ method: 'POST', path: '/api/refresh', headers: { origin: `http://localhost:${port}` } });
    assert.equal(sameOrigin.status, 200);
    const noOrigin = await rawRequest({ method: 'POST', path: '/api/refresh' });
    assert.equal(noOrigin.status, 200);
    // GETs are not state-changing: a cross-origin Origin header alone does not block them.
    assert.equal((await rawRequest({ path: '/healthz', headers: { origin: 'https://evil.example' } })).status, 200);
  });

  it('returns 400, not 500, for malformed percent-encoding in the path', async () => {
    for (const badPath of ['/%E0%A4%A', '/%', '/%zz', '/app.js%']) {
      const response = await rawRequest({ path: badPath });
      assert.equal(response.status, 400, badPath);
      assert.match(response.body, /malformed/);
    }
    assert.equal((await rawRequest({ path: '/%00' })).status, 400);
    assert.equal((await rawRequest({ path: '/app%2Ejs' })).status, 200); // valid encoding still works
  });

  it('serves the all-platforms total', async () => {
    const summary = await (await fetch(`${baseUrl}/api/summary`)).json();
    assert.equal(summary.total.id, 'total');
    assert.ok(summary.total.windows.allTime);
    const total = await (await fetch(`${baseUrl}/api/total`)).json();
    assert.ok(Array.isArray(total.detail.byDay));
  });

  after(() => server.close());

  it('shares one transcript scan between providers per refresh', () => {
    assert.equal(scanCount, collectCount); // two providers, one scan per refresh
  });

  it('serves cached summaries without re-collecting', async () => {
    const collectsBefore = collectCount;
    const body = await (await fetch(`${baseUrl}/api/summary`)).json();
    assert.equal(collectCount, collectsBefore);
    assert.equal(body.providers.find((row) => row.id === 'good').costUsd, collectCount);
    const badProvider = body.providers.find((row) => row.id === 'bad');
    assert.equal(badProvider.ok, false);
    assert.equal(badProvider.error, 'boom');
  });

  it('re-collects on POST /api/refresh and coalesces concurrent refreshes', async () => {
    const collectsBefore = collectCount;
    const scansBefore = scanCount;
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/refresh`, { method: 'POST' }),
      fetch(`${baseUrl}/api/refresh`, { method: 'POST' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(collectCount - collectsBefore, 1);
    assert.equal(scanCount - scansBefore, 1);
  });

  it('rejects GET on the refresh endpoint', async () => {
    assert.equal((await fetch(`${baseUrl}/api/refresh`)).status, 405);
  });

  it('returns provider detail and 404 for unknown providers', async () => {
    const detail = await (await fetch(`${baseUrl}/api/providers/good`)).json();
    assert.equal(detail.detail.collectCount, collectCount);
    const missing = await fetch(`${baseUrl}/api/providers/nope`);
    assert.equal(missing.status, 404);
  });

  it('serves the UI and blocks path traversal', async () => {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const traversal = await fetch(`${baseUrl}/..%2fpackage.json`);
    assert.ok([403, 404].includes(traversal.status));
  });

  it('reports health', async () => {
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(health.status, 'ok');
    assert.ok(health.refreshedAt);
  });
});

describe('Anthropic Admin API client', () => {
  it('reports not configured without a key', async () => {
    assert.deepEqual(await fetchAdminUsage({ adminKey: '' }), { configured: false });
  });

  it('converts cent strings to dollars', () => {
    const cost = summarizeCostBuckets([
      { starting_at: '2026-11-01T00:00:00Z', results: [{ amount: '150.5' }, { amount: '49.5' }] },
      { starting_at: '2026-11-02T00:00:00Z', results: [{ amount: 'bad' }] },
    ]);
    assert.equal(cost.totalCostUsd, 2);
  });

  it('follows pagination and surfaces HTTP errors', async () => {
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(String(url));
      const isCost = String(url).includes('cost_report');
      const isSecondPage = String(url).includes('page=p2');
      const body = isCost
        ? { data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ amount: '100' }] }], has_more: false }
        : {
          data: [{ starting_at: '2026-11-01T00:00:00Z', results: [{ model: 'm', uncached_input_tokens: 5, output_tokens: 1 }] }],
          has_more: !isSecondPage, next_page: isSecondPage ? null : 'p2',
        };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const result = await fetchAdminUsage({ adminKey: 'k', fetchImpl, now: new Date('2026-11-17T00:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.usage.totals.inputTokens, 10);
    assert.equal(result.cost.totalCostUsd, 1);
    assert.equal(requestedUrls.filter((url) => url.includes('usage_report')).length, 2);

    const failing = await fetchAdminUsage({ adminKey: 'k', fetchImpl: async () => new Response('denied', { status: 403 }) });
    assert.equal(failing.ok, false);
    assert.match(failing.error, /403/);
  });
});
