#!/usr/bin/env node
// HTTP server: JSON API + static UI. No runtime dependencies.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createDashboardState } from './dashboard-state.js';
import { createBraveProvider } from './providers/brave/index.js';
import { createClaudeProvider } from './providers/claude/index.js';
import { TranscriptScanner } from './transcript-scanner.js';

const HelpText = `usage-dashboard server

Usage: node src/server.js [--help]

Serves the usage dashboard UI and JSON API. Configuration comes from
environment variables (see usage-dashboard.example.env):
  PORT, LISTEN_HOST, CLAUDE_PROJECTS_DIR, PRICING_FILE, DASHBOARD_TIME_ZONE,
  ANTHROPIC_ADMIN_KEY, BRAVE_API_KEY, BRAVE_COST_PER_1K,
  BRAVE_MONTHLY_CREDIT_USD, BRAVE_QUOTA_MIN_INTERVAL_SECONDS,
  BRAVE_PROBE_ON_STARTUP

Endpoints:
  GET  /healthz                 liveness + last refresh time
  GET  /api/summary             cached tile summaries for all providers
  GET  /api/providers/:id       cached detail payload for one provider
  POST /api/refresh             re-read all sources, then return the summary
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
    providers: Object.values(snapshot.providers).map((entry) => ({
      ...entry.summary, ok: entry.ok, error: entry.error, stale: entry.stale,
    })),
  };
}

async function serveStatic(publicDir, urlPath, response) {
  const relativePath = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
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

export function createRequestHandler({ dashboardState, publicDir, startedAt = new Date() }) {
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
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
        const snapshot = await dashboardState.refresh('refresh');
        sendJson(response, 200, summaryView(snapshot));
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
    }),
  ];
  const dashboardState = createDashboardState({ providers, transcriptScanner });
  const server = http.createServer(createRequestHandler({ dashboardState, publicDir: config.publicDir }));

  server.listen(config.port, config.listenHost, () => {
    console.log(`usage-dashboard listening on http://${config.listenHost}:${config.port} (tz ${config.timeZone})`);
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
