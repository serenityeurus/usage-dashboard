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
import { createOtherWebSearchProvider } from './providers/other-search/index.js';
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
  SEARXNG_BASE_URL, SEARXNG_TIMEOUT_SECONDS,
  AUTO_REFRESH_SECONDS (default 300, 0 disables; auto refreshes never probe Brave),
  CLAUDE_QUOTA_METRIC, CLAUDE_SESSION_LIMIT_USD, CLAUDE_WEEKLY_LIMIT_USD,
  CLAUDE_SESSION_LIMIT_TOKENS, CLAUDE_WEEKLY_LIMIT_TOKENS, CLAUDE_WEEKLY_RESET

Endpoints:
  GET  /healthz                 liveness + last refresh time
  GET  /api/summary             cached tile summaries for all providers
  GET  /api/providers/:id       cached detail payload for one provider
  GET  /api/total               cached "All platforms" roll-up and per-day breakdown
                                (GET routes also answer HEAD; other methods get 405)
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

function summaryView(snapshot, autoRefreshSeconds) {
  return {
    refreshedAt: snapshot.refreshedAt,
    autoRefreshSeconds,
    refreshReason: snapshot.refreshReason,
    durationMs: snapshot.durationMs,
    timeZone: snapshot.timeZone,
    range: snapshot.range,
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

// Runs dashboardState.refresh('auto') every intervalSeconds. A tick that finds
// a refresh already running (startup, a manual Refresh, a slow previous tick)
// is skipped rather than queued, so ticks never pile up behind a slow scan.
// The timer is unref'd: it never keeps the process alive on its own.
export function startAutoRefresh({
  dashboardState, intervalSeconds, logger = console, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
}) {
  if (!intervalSeconds) return { stop() {}, tick: async () => 'disabled' };
  async function tick() {
    if (dashboardState.isRefreshing()) {
      logger.log('auto refresh skipped: a refresh is already in flight');
      return 'skipped';
    }
    try {
      const snapshot = await dashboardState.refresh('auto');
      logger.log(`auto refresh done in ${snapshot.durationMs}ms`);
      return 'ran';
    } catch (error) {
      logger.error('auto refresh failed', error);
      return 'failed';
    }
  }
  const timer = setIntervalImpl(tick, intervalSeconds * 1000);
  timer?.unref?.();
  return { stop: () => clearIntervalImpl(timer), tick };
}

export function createRequestHandler({
  dashboardState, publicDir, hostPolicy = createHostPolicy(), startedAt = new Date(), autoRefreshSeconds = 0,
}) {
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
    // HEAD is answered wherever GET is (RFC 9110 9.3.2; Node drops the body),
    // matching the static files. Every other method on a known route gets 405
    // with an Allow header; OPTIONS included, since there is no CORS to
    // negotiate and answering preflights would only advertise cross-origin use.
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const methodNotAllowed = (allow) => {
      response.setHeader('Allow', allow);
      sendJson(response, 405, { error: `method not allowed, use ${allow}` });
    };
    try {
      if (url.pathname === '/healthz') {
        if (!isRead) return methodNotAllowed('GET, HEAD');
        sendJson(response, 200, {
          status: 'ok', startedAt: startedAt.toISOString(), refreshedAt: dashboardState.getRefreshedAt(), refreshing: dashboardState.isRefreshing(),
        });
        return;
      }
      if (url.pathname === '/api/summary') {
        if (!isRead) return methodNotAllowed('GET, HEAD');
        sendJson(response, 200, summaryView(dashboardState.getSnapshot(), autoRefreshSeconds));
        return;
      }
      if (url.pathname === '/api/refresh') {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        const probes = url.searchParams.getAll('probe').flatMap((value) => value.split(',')).filter(Boolean);
        const snapshot = await dashboardState.refresh('refresh', { probes });
        sendJson(response, 200, summaryView(snapshot, autoRefreshSeconds));
        return;
      }
      if (url.pathname === '/api/total') {
        if (!isRead) return methodNotAllowed('GET, HEAD');
        const snapshot = dashboardState.getSnapshot();
        sendJson(response, 200, {
          refreshedAt: snapshot.refreshedAt, autoRefreshSeconds, timeZone: snapshot.timeZone, range: snapshot.range, summary: snapshot.total?.summary ?? null, detail: snapshot.total?.detail ?? null,
        });
        return;
      }
      const providerMatch = url.pathname.match(/^\/api\/providers\/([a-z0-9-]+)$/);
      if (providerMatch) {
        if (!isRead) return methodNotAllowed('GET, HEAD');
        const snapshot = dashboardState.getSnapshot();
        const entry = snapshot.providers[providerMatch[1]];
        if (!entry) {
          sendJson(response, 404, { error: `unknown provider "${providerMatch[1]}"`, known: dashboardState.providerIds() });
          return;
        }
        sendJson(response, 200, {
          refreshedAt: snapshot.refreshedAt, autoRefreshSeconds, timeZone: snapshot.timeZone, range: snapshot.range, ok: entry.ok, error: entry.error, summary: entry.summary, detail: entry.detail,
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not found' });
        return;
      }
      if (!isRead) return methodNotAllowed('GET, HEAD');
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
      pricingFilePath: config.pricingFilePath, adminKey: config.anthropicAdminKey, timeZone: config.timeZone, quotaConfig: config.claudeQuota,
    }),
    createBraveProvider({
      apiKey: config.braveApiKey,
      costPer1k: config.braveCostPer1k,
      monthlyCreditUsd: config.braveMonthlyCreditUsd,
      timeZone: config.timeZone,
      quotaMinIntervalSeconds: config.braveQuotaMinIntervalSeconds,
      probeOnStartup: config.probeBraveOnStartup,
      quotaProbeMode: config.braveQuotaProbe,
      webSearchProvider: config.webSearchProvider,
      attributionOptions,
    }),
    createSearxngProvider({
      baseUrl: config.searxngBaseUrl,
      timeZone: config.timeZone,
      timeoutSeconds: config.searxngTimeoutSeconds,
      webSearchProvider: config.webSearchProvider,
      attributionOptions,
    }),
    createOtherWebSearchProvider({ timeZone: config.timeZone, attributionOptions }),
  ];
  const dashboardState = createDashboardState({ providers, transcriptScanner, timeZone: config.timeZone });
  const hostPolicy = createHostPolicy({ extraHosts: config.allowedHosts, ports: [config.port, config.hostPort] });
  const server = http.createServer(createRequestHandler({
    dashboardState, publicDir: config.publicDir, hostPolicy, autoRefreshSeconds: config.autoRefreshSeconds,
  }));

  server.listen(config.port, config.listenHost, () => {
    console.log(`usage-dashboard listening on http://${config.listenHost}:${config.port} (tz ${config.timeZone}, `
      + `web_search provider ${config.webSearchProvider ?? 'unset (inferred from transcripts, no auto Brave probe)'}, allowed hosts ${JSON.stringify(hostPolicy.describe())}, `
      + `auto refresh ${config.autoRefreshSeconds ? `every ${config.autoRefreshSeconds}s (never probes Brave)` : 'disabled'})`);
  });
  const snapshot = await dashboardState.refresh('startup');
  const scanStats = snapshot.providers.claude?.detail?.scan;
  console.log(`initial refresh done in ${snapshot.durationMs}ms`, scanStats
    ? `(${scanStats.fileCount} transcript files, ${(scanStats.totalBytes / 1e6).toFixed(1)} MB)` : '');
  // Started after the startup refresh so the first tick is a full interval later.
  const autoRefresh = startAutoRefresh({ dashboardState, intervalSeconds: config.autoRefreshSeconds });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    autoRefresh.stop();
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
