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

// Seconds between server-side auto refreshes: an integer, 0 (off) or >= 30.
// The floor keeps a typo like "5" (meant as minutes) from rescanning
// transcripts every five seconds.
export const MinAutoRefreshSeconds = 30;
function autoRefreshSecondsFromEnv(environment) {
  const rawValue = String(environment.AUTO_REFRESH_SECONDS ?? '').trim();
  if (rawValue === '') return 300;
  const seconds = Number(rawValue);
  if (!/^\d+$/.test(rawValue) || !Number.isSafeInteger(seconds) || (seconds !== 0 && seconds < MinAutoRefreshSeconds)) {
    throw new Error(`AUTO_REFRESH_SECONDS must be an integer, 0 (disabled) or >= ${MinAutoRefreshSeconds}, got "${environment.AUTO_REFRESH_SECONDS}"`);
  }
  return seconds;
}

// A positive limit, or null when unset. 0 is rejected: it would make every
// percentage infinite, and "no limit" is spelled by leaving the key empty.
function limitFromEnv(environment, key) {
  const rawValue = String(environment[key] ?? '').trim();
  if (rawValue === '') return null;
  const numberValue = Number(rawValue);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${key} must be a positive number (or empty for no limit), got "${environment[key]}"`);
  }
  return numberValue;
}

const WeekdayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// CLAUDE_WEEKLY_RESET: "rolling" (trailing 7 days) or "<weekday> HH:MM" in the
// dashboard time zone, e.g. "mon 00:00", "thursday 17:30". Weekdays need at
// least three letters.
export function parseWeeklyReset(rawValue) {
  const value = String(rawValue ?? '').trim().toLowerCase();
  if (value === '' || value === 'rolling') return { mode: 'rolling', label: 'rolling 7 days' };
  const match = value.match(/^([a-z]{3,9})\s+(\d{1,2}):(\d{2})$/);
  const dayOfWeek = match ? WeekdayNames.findIndex((name) => name.startsWith(match[1])) : -1;
  const hour = match ? Number(match[2]) : NaN;
  const minute = match ? Number(match[3]) : NaN;
  if (dayOfWeek < 0 || !(hour <= 23) || !(minute <= 59)) {
    throw new Error(`CLAUDE_WEEKLY_RESET must be "rolling" or "<weekday> HH:MM" (e.g. "mon 00:00"), got "${rawValue}"`);
  }
  const label = `${WeekdayNames[dayOfWeek].slice(0, 3)} ${String(hour).padStart(2, '0')}:${match[3]}`;
  return { mode: 'fixed', dayOfWeek, hour, minute, label };
}

// Seconds after which a status line capture is labelled stale (still shown
// as a lower bound until its windows reset; see official-quota.js).
function positiveIntegerFromEnv(environment, key, fallback) {
  const rawValue = String(environment[key] ?? '').trim();
  if (rawValue === '') return fallback;
  const value = Number(rawValue);
  if (!/^\d+$/.test(rawValue) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer, got "${environment[key]}"`);
  }
  return value;
}

export function defaultStatuslineStateFile(environment = process.env) {
  return path.join(environment.HOME || process.env.HOME || '/', '.claude', 'usage-dashboard', 'rate-limits.json');
}

export function loadClaudeQuotaConfig(environment = {}) {
  return {
    statuslineStateFile: environment.USAGE_DASHBOARD_STATE_FILE || null,
    statuslineMaxAgeSeconds: positiveIntegerFromEnv(environment, 'CLAUDE_STATUSLINE_MAX_AGE_SECONDS', 900),
    metric: enumFromEnv(environment, 'CLAUDE_QUOTA_METRIC', ['usd', 'tokens'], 'usd'),
    limits: {
      session: { tokens: limitFromEnv(environment, 'CLAUDE_SESSION_LIMIT_TOKENS'), usd: limitFromEnv(environment, 'CLAUDE_SESSION_LIMIT_USD') },
      weekly: { tokens: limitFromEnv(environment, 'CLAUDE_WEEKLY_LIMIT_TOKENS'), usd: limitFromEnv(environment, 'CLAUDE_WEEKLY_LIMIT_USD') },
    },
    weeklyReset: parseWeeklyReset(environment.CLAUDE_WEEKLY_RESET),
  };
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
    autoRefreshSeconds: autoRefreshSecondsFromEnv(environment),
    claudeQuota: { ...loadClaudeQuotaConfig(environment), statuslineStateFile: environment.USAGE_DASHBOARD_STATE_FILE || defaultStatuslineStateFile(environment) },
  };
}
