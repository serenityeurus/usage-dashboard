// Reads configuration from environment variables (see usage-dashboard.example.env).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function numberFromEnv(environment, key, fallback) {
  const rawValue = environment[key];
  if (rawValue == null || rawValue === '') return fallback;
  const numberValue = Number(rawValue);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`${key} must be a non-negative number, got "${rawValue}"`);
  }
  return numberValue;
}

export function loadConfig(environment = process.env) {
  const timeZone = environment.DASHBOARD_TIME_ZONE || environment.TZ || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`DASHBOARD_TIME_ZONE/TZ "${timeZone}" is not a valid IANA time zone`);
  }
  return {
    port: numberFromEnv(environment, 'PORT', 8787),
    listenHost: environment.LISTEN_HOST || '0.0.0.0',
    claudeProjectsDir: environment.CLAUDE_PROJECTS_DIR || path.join(process.env.HOME || '/', '.claude', 'projects'),
    pricingFilePath: environment.PRICING_FILE || path.join(RepoRoot, 'config', 'pricing.json'),
    publicDir: path.join(RepoRoot, 'public'),
    timeZone,
    anthropicAdminKey: environment.ANTHROPIC_ADMIN_KEY || '',
    braveApiKey: environment.BRAVE_API_KEY || '',
    braveCostPer1k: numberFromEnv(environment, 'BRAVE_COST_PER_1K', 5),
    braveMonthlyCreditUsd: numberFromEnv(environment, 'BRAVE_MONTHLY_CREDIT_USD', 5),
    braveQuotaMinIntervalSeconds: numberFromEnv(environment, 'BRAVE_QUOTA_MIN_INTERVAL_SECONDS', 60),
    probeBraveOnStartup: environment.BRAVE_PROBE_ON_STARTUP !== 'false',
  };
}
