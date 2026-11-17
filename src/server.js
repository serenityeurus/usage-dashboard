#!/usr/bin/env node
// HTTP server: JSON API + static UI. No runtime dependencies.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDashboardState } from './dashboard-state.js';
import { checkRequest, createHostPolicy } from './http-guard.js';
import { createBraveProvider } from './providers/brave/index.js';
import { createClaudeProvider } from './providers/claude/index.js';
import { createSearxngProvider } from './providers/searxng/index.js';
import { TranscriptScanner } from './transcript-scanner.js';

const HelpText = `usage-dashboard server

Usage: node src/server.js [--help]

Serves the usage dashboard UI and JSON API. Configuration comes from
environment variables (see usage-dashboard.example.env):
  PORT, HOST_PORT, LISTEN_HOST, ALLOWED_HOSTS, CLAUDE_PROJECTS_DIR, PRICING_FILE,
  DASHBOARD_TIME_ZONE (or TZ; default America/Detroit), ANTHROPIC_ADMIN_KEY,
  WEB_SEARCH_PROVIDER, WEB_SEARCH_PROVIDER_HISTORY,
  BRAVE_API_KEY, BRAVE_COST_PER_1K, BRAVE_MONTHLY_CREDIT_USD,
  BRAVE_QUOTA_MIN_INTERVAL_SECONDS, BRAVE_QUOTA_PROBE, BRAVE_PROBE_ON_STARTUP,
  SEARXNG_BASE_URL, SEARXNG_TIMEOUT_SECONDS

Endpoints:
  GET  /healthz                 liveness + last refresh time
  GET  /api/summary             cached tile summaries for all providers
  GET  /api/providers/:id       cached detail payload for one provider
  GET  /api/total               cached "All platforms" roll-up and per-day breakdown
  POST /api/refresh             re-read all sources, then return the summary
                                (?probe=brave also runs the paid Brave quota probe)

Requests must carry an allowed Host header (localhost, 127.0.0.1, [::1] plus
ALLOWED_HOSTS); non-GET requests with a foreign Origin are rejected with 403.
`;

const ContentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function summaryView(snapshot) {
  return {
    refreshedAt: snapshot.refreshedAt,
    refreshReason: snapshot.refreshReason,
    durationMs: snapshot.durationMs,
    timeZone: snapshot.timeZone,
    total: snapshot.total?.summary ?? null,
    providers: Object.values(snapshot.providers).map((entry) => ({
      ...entry.summary, ok: entry.ok, error: entry.error, stale: entry.stale,
    })),
  };
}

class BadRequestError extends Error {}

// Malformed percent-encoding ("/%E0%A4%A") makes decodeURIComponent throw a
// URIError; that is the client's fault, so it maps to 400 instead of 500.
function decodePath(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    throw new BadRequestError('malformed percent-encoding in path');
  }
}

async function serveStatic(publicDir, urlPath, response) {
  const relativePath = urlPath === '/' ? 'index.html' : decodePath(urlPath).replace(/^\/+/, '');
  if (relativePath.includes('\0')) throw new BadRequestError('NUL byte in path');
  const resolvedPath = path.resolve(publicDir, relativePath);
  if (!resolvedPath.startsWith(publicDir + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const fileBuffer = await fs.readFile(resolvedPath);
    response.writeHead(200, {
      'Content-Type': ContentTypes[path.extname(resolvedPath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(fileBuffer);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}

export function createRequestHandler({ dashboardState, publicDir, hostPolicy = createHostPolicy(), startedAt = new Date() }) {
  return async (request, response) => {
    const rejection = checkRequest(request, hostPolicy);
    if (rejection) {
      sendJson(response, rejection.status, { error: rejection.error });
      return;
    }
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      sendJson(response, 400, { error: 'malformed request URL' });
      return;
    }
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') {
        const snapshot = dashboardState.getSnapshot();
        sendJson(response, 200, {
          status: 'ok', startedAt: startedAt.toISOString(), refreshedAt: snapshot.refreshedAt, refreshing: dashboardState.isRefreshing(),
        });
        return;
      }
      if (url.pathname === '/api/summary' && request.method === 'GET') {
        sendJson(response, 200, summaryView(dashboardState.getSnapshot()));
        return;
      }
      if (url.pathname === '/api/refresh') {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'use POST' });
          return;
        }
        const probes = url.searchParams.getAll('probe').flatMap((value) => value.split(',')).filter(Boolean);
        const snapshot = await dashboardState.refresh('refresh', { probes });
        sendJson(response, 200, summaryView(snapshot));
        return;
      }
      if (url.pathname === '/api/total' && request.method === 'GET') {
        const snapshot = dashboardState.getSnapshot();
        sendJson(response, 200, {
          refreshedAt: snapshot.refreshedAt, timeZone: snapshot.timeZone, summary: snapshot.total?.summary ?? null, detail: snapshot.total?.detail ?? null,
        });
        return;
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)$/);
      if (providerMatch && request.method === 'GET') {
        const entry = dashboardState.getSnapshot().providers[providerMatch[1]];
        if (!entry) {
          sendJson(response, 404, { error: `unknown provider "${providerMatch[1]}"`, known: dashboardState.providerIds() });
          return;
        }
        sendJson(response, 200, {
          refreshedAt: dashboardState.getSnapshot().refreshedAt, ok: entry.ok, error: entry.error, summary: entry.summary, detail: entry.detail,
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      await serveStatic(publicDir, url.pathname, response);
    } catch (error) {
      if (error instanceof BadRequestError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      console.error('request failed', url.pathname, error);
      sendJson(response, 500, { error: error.message });
    }
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HelpText);
    return;
  }
  const config = loadConfig();
  const transcriptScanner = new TranscriptScanner({ rootDir: config.claudeProjectsDir });
  const attributionOptions = { history: config.webSearchProviderHistory, fallbackProvider: 'brave' };
  const providers = [
    createClaudeProvider({
      pricingFilePath: config.pricingFilePath, adminKey: config.anthropicAdminKey, timeZone: config.timeZone,
    }),
    createBraveProvider({
      apiKey: config.braveApiKey,
      costPer1k: config.braveCostPer1k,
      monthlyCreditUsd: config.braveMonthlyCreditUsd,
      timeZone: config.timeZone,
      quotaMinIntervalSeconds: config.braveQuotaMinIntervalSeconds,
      probeOnStartup: config.probeBraveOnStartup,
      quotaProbeMode: config.braveQuotaProbe,
      active: config.webSearchProvider === 'brave',
      attributionOptions,
    }),
    createSearxngProvider({
      baseUrl: config.searxngBaseUrl,
      timeZone: config.timeZone,
      timeoutSeconds: config.searxngTimeoutSeconds,
      active: config.webSearchProvider === 'searxng',
      attributionOptions,
    }),
  ];
  const dashboardState = createDashboardState({ providers, transcriptScanner, timeZone: config.timeZone });
  const hostPolicy = createHostPolicy({ extraHosts: config.allowedHosts, ports: [config.port, config.hostPort] });
  const server = http.createServer(createRequestHandler({ dashboardState, publicDir: config.publicDir, hostPolicy }));

  server.listen(config.port, config.listenHost, () => {
    console.log(`usage-dashboard listening on http://${config.listenHost}:${config.port} (tz ${config.timeZone}, `
      + `web_search provider ${config.webSearchProvider}, allowed hosts ${JSON.stringify(hostPolicy.describe())})`);
  });
  const snapshot = await dashboardState.refresh('startup');
  const scanStats = snapshot.providers.claude?.detail?.scan;
  console.log(`initial refresh done in ${snapshot.durationMs}ms`, scanStats
    ? `(${scanStats.fileCount} transcript files, ${(scanStats.totalBytes / 1e6).toFixed(1)} MB)` : '');

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
