// Reads configuration from environment variables (see usage-dashboard.example.env).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostPolicy } from './http-guard.js';
import { parseProviderHistory, WebSearchProviderIds } from './web-search-attribution.js';

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DefaultTimeZone = 'America/Detroit';

function numberFromEnv(environment, key, fallback) {
  const rawValue = environment[key];
  if (rawValue == null || rawValue === '') return fallback;
  const numberValue = Number(rawValue);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`${key} must be a non-negative number, got "${rawValue}"`);
  }
  return numberValue;
}

function enumFromEnv(environment, key, allowedValues, fallback) {
  const rawValue = (environment[key] ?? '').trim().toLowerCase();
  if (!rawValue) return fallback;
  if (!allowedValues.includes(rawValue)) {
    throw new Error(`${key} must be one of ${allowedValues.join('|')}, got "${environment[key]}"`);
  }
  return rawValue;
}

function listFromEnv(environment, key) {
  return (environment[key] || '').split(',').map((part) => part.trim()).filter(Boolean);
}

export function loadConfig(environment = process.env) {
  const rawTimeZone = environment.DASHBOARD_TIME_ZONE || environment.TZ || DefaultTimeZone;
  // POSIX allows a leading ":" (TZ=:America/Detroit) meaning "implementation-defined
  // zone name"; glibc and macOS read it as an IANA name. Intl does not, so strip it.
  const timeZone = rawTimeZone.replace(/^:/, '');
  try {
    if (!timeZone) throw new Error('empty');
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`DASHBOARD_TIME_ZONE/TZ "${rawTimeZone}" is not a valid IANA time zone`);
  }
  const port = numberFromEnv(environment, 'PORT', 8787);
  // HOST_PORT is the host-side published port (compose); the browser's Host
  // header carries that one, not the container's PORT.
  const hostPort = numberFromEnv(environment, 'HOST_PORT', null);
  const searxngBaseUrl = (environment.SEARXNG_BASE_URL || '').trim().replace(/\/+$/, '');
  if (searxngBaseUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(searxngBaseUrl);
    } catch {
      throw new Error(`SEARXNG_BASE_URL must be an http(s) URL, got "${searxngBaseUrl}"`);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`SEARXNG_BASE_URL must be an http(s) URL, got "${searxngBaseUrl}"`);
    }
  }
  const allowedHosts = listFromEnv(environment, 'ALLOWED_HOSTS');
  createHostPolicy({ extraHosts: allowedHosts }); // throws on a malformed entry, at startup
  return {
    port,
    hostPort,
    listenHost: environment.LISTEN_HOST || '127.0.0.1', // containers set 0.0.0.0 explicitly
    allowedHosts,
    claudeProjectsDir: environment.CLAUDE_PROJECTS_DIR || path.join(process.env.HOME || '/', '.claude', 'projects'),
    pricingFilePath: environment.PRICING_FILE || path.join(RepoRoot, 'config', 'pricing.json'),
    publicDir: path.join(RepoRoot, 'public'),
    timeZone,
    anthropicAdminKey: environment.ANTHROPIC_ADMIN_KEY || '',
    // null = unset: the active badge is inferred from transcripts and
    // BRAVE_QUOTA_PROBE=auto never probes (see README, "Active provider").
    webSearchProvider: enumFromEnv(environment, 'WEB_SEARCH_PROVIDER', WebSearchProviderIds, null),
    webSearchProviderHistory: parseProviderHistory(environment.WEB_SEARCH_PROVIDER_HISTORY || ''),
    braveApiKey: environment.BRAVE_API_KEY || '',
    braveCostPer1k: numberFromEnv(environment, 'BRAVE_COST_PER_1K', 5),
    braveMonthlyCreditUsd: numberFromEnv(environment, 'BRAVE_MONTHLY_CREDIT_USD', 5),
    braveQuotaMinIntervalSeconds: numberFromEnv(environment, 'BRAVE_QUOTA_MIN_INTERVAL_SECONDS', 60),
    braveQuotaProbe: enumFromEnv(environment, 'BRAVE_QUOTA_PROBE', ['auto', 'true', 'false'], 'auto'),
    probeBraveOnStartup: environment.BRAVE_PROBE_ON_STARTUP !== 'false',
    searxngBaseUrl,
    searxngTimeoutSeconds: numberFromEnv(environment, 'SEARXNG_TIMEOUT_SECONDS', 5),
  };
}
