import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDashboardState } from '../src/dashboard-state.js';
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
    server = http.createServer(createRequestHandler({ dashboardState, publicDir: PublicDir }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('shares one transcript scan between providers per refresh', () => {
    assert.equal(scanCount, 1);
  });

  it('serves cached summaries without re-collecting', async () => {
    const body = await (await fetch(`${baseUrl}/api/summary`)).json();
    assert.equal(collectCount, 1);
    assert.equal(body.providers.find((row) => row.id === 'good').costUsd, 1);
    const badProvider = body.providers.find((row) => row.id === 'bad');
    assert.equal(badProvider.ok, false);
    assert.equal(badProvider.error, 'boom');
  });

  it('re-collects on POST /api/refresh and coalesces concurrent refreshes', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/refresh`, { method: 'POST' }),
      fetch(`${baseUrl}/api/refresh`, { method: 'POST' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(collectCount, 2);
    assert.equal(scanCount, 2);
  });

  it('rejects GET on the refresh endpoint', async () => {
    assert.equal((await fetch(`${baseUrl}/api/refresh`)).status, 405);
  });

  it('returns provider detail and 404 for unknown providers', async () => {
    const detail = await (await fetch(`${baseUrl}/api/providers/good`)).json();
    assert.equal(detail.detail.collectCount, 2);
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
