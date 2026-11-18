// Claude's official plan-limit percentages, as captured by
// scripts/claude-statusline.mjs from Claude Code's status line input
// (rate_limits.five_hour / seven_day / ...: used_percentage 0-100, resets_at in
// Unix seconds). These are the numbers /usage shows.
//
// Per window, the official figure replaces the v0.3 estimate while the
// window's resets_at is still in the future. Staleness policy:
// - A capture is only refreshed while an interactive Claude Code session is
//   running (the status line does not run for `claude -p`, so OpenClaw's
//   claude-cli runs never refresh it, though they do consume quota).
// - Within one window the percentage can only grow, so an old capture taken
//   before resets_at is still a valid *lower bound*. Discarding it for a guess
//   would throw away the only real number we have. We keep it, flag it
//   stale after CLAUDE_STATUSLINE_MAX_AGE_SECONDS (default 900), and label it
//   "as of <time>, at least".
// - Once resets_at passes the capture says nothing about the new window, so
//   that window falls back to the estimate.
// Rate-limit blocks come from transcripts (assistant lines carrying
// apiErrorParams.rate_limit_info with status "rejected", which Claude Code
// writes on a 429 usage_limit_reached). A block counts until its resetsAt,
// unless a real (non-synthetic) API response arrived after it.
import fs from 'node:fs/promises';

export const DefaultStatuslineMaxAgeSeconds = 900;
export const WindowMapping = { five_hour: 'session', seven_day: 'weekly' };
const WindowKeyPattern = /^[a-z0-9_]{1,40}$/i;

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// -> { status: 'ok'|'missing'|'invalid', capture?, error? }. Never throws.
export async function readStatuslineState(stateFile, fileSystem = fs) {
  if (!stateFile) return { status: 'missing' };
  let text;
  try {
    text = await fileSystem.readFile(stateFile, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid', error: `unreadable (${error.code || error.message})` };
  }
  try {
    const capture = JSON.parse(text);
    if (!capture || typeof capture !== 'object' || Number.isNaN(Date.parse(capture.capturedAt))
      || !capture.rate_limits || typeof capture.rate_limits !== 'object') {
      return { status: 'invalid', error: 'unexpected shape' };
    }
    return { status: 'ok', capture };
  } catch {
    return { status: 'invalid', error: 'not JSON' };
  }
}

function describeAge(ageSeconds) {
  if (ageSeconds < 90) return `${Math.max(0, Math.round(ageSeconds))} s`;
  if (ageSeconds < 5400) return `${Math.round(ageSeconds / 60)} min`;
  if (ageSeconds < 172_800) return `${Math.round(ageSeconds / 3600)} h`;
  return `${Math.round(ageSeconds / 86_400)} d`;
}

// Validated, unexpired windows of a capture, keyed like rate_limits.
export function officialWindows(capture, { now, maxAgeSeconds = DefaultStatuslineMaxAgeSeconds }) {
  const nowMs = now.getTime();
  const capturedMs = Date.parse(capture.capturedAt);
  const ageSeconds = Math.max(0, (nowMs - capturedMs) / 1000);
  const stale = ageSeconds > maxAgeSeconds;
  const windows = {};
  const expired = [];
  for (const [windowKey, raw] of Object.entries(capture.rate_limits)) {
    if (!WindowKeyPattern.test(windowKey) || !raw || typeof raw !== 'object') continue;
    const usedPercent = Number(raw.used_percentage);
    if (typeof raw.used_percentage !== 'number' || !Number.isFinite(usedPercent)) continue;
    const resetsAtMs = typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at) ? raw.resets_at * 1000 : null;
    if (resetsAtMs != null && resetsAtMs <= nowMs) {
      expired.push(windowKey);
      continue;
    }
    const window = {
      key: windowKey,
      usedPercent: Math.round(usedPercent * 10) / 10,
      resetsAt: toIso(resetsAtMs),
      capturedAt: toIso(capturedMs),
      ageSeconds: Math.round(ageSeconds),
      stale,
      sourceLabel: stale
        ? `Claude Code /usage (status line), as of ${toIso(capturedMs)}: a lower bound, usage since then is not reflected`
        : `Claude Code /usage (status line, captured ${describeAge(ageSeconds)} ago)`,
    };
    // spend_limit (Claude apps gateway) extras, passed through when numeric/string.
    for (const extraKey of ['used_usd', 'limit_usd']) if (typeof raw[extraKey] === 'number') window[extraKey.replace('_usd', 'Usd')] = raw[extraKey];
    if (typeof raw.period === 'string') window.period = raw.period.slice(0, 16);
    windows[windowKey] = window;
  }
  return { windows, expired, ageSeconds: Math.round(ageSeconds), stale };
}

// Latest rate-limit rejection still in force, or null.
// events: [{ timestamp, status, resetsAt (unix s), rateLimitType }]
// lastResponseAt: ISO time of the latest real API response (any session).
export function currentBlock(events, { now, lastResponseAt = null }) {
  const nowMs = now.getTime();
  const lastResponseMs = lastResponseAt ? Date.parse(lastResponseAt) : null;
  let latest = null;
  for (const event of events || []) {
    if (event?.status !== 'rejected' || typeof event.resetsAt !== 'number') continue;
    const atMs = Date.parse(event.timestamp);
    if (!Number.isFinite(atMs)) continue;
    if (!latest || atMs > latest.atMs) latest = { ...event, atMs };
  }
  if (!latest) return null;
  const untilMs = latest.resetsAt * 1000;
  if (untilMs <= nowMs) return null;
  if (lastResponseMs != null && lastResponseMs > latest.atMs) return null; // a later call succeeded
  return {
    blocked: true,
    until: toIso(untilMs),
    since: toIso(latest.atMs),
    rateLimitType: typeof latest.rateLimitType === 'string' ? latest.rateLimitType : null,
    source: 'Claude Code transcript (429 usage_limit_reached)',
  };
}

// Adds per-window `source` ('official'|'estimate'), `sourceLabel` and
// `official` to an estimateClaudeQuota() result. Estimate fields are left
// untouched so API consumers of v0.3 keep working.
export function applyOfficialQuota(quota, stateResult, { now, maxAgeSeconds = DefaultStatuslineMaxAgeSeconds, block = null }) {
  const estimateLabel = 'Estimate from local transcripts (v0.3 calibration)';
  const official = {
    status: stateResult.status,
    error: stateResult.error || null,
    maxAgeSeconds,
    capturedAt: null,
    ageSeconds: null,
    stale: null,
    expiredWindows: [],
    windows: {},
    note: 'Captured by scripts/claude-statusline.mjs; refreshes only while an interactive Claude Code session is running.',
  };
  if (stateResult.status === 'ok') {
    const result = officialWindows(stateResult.capture, { now, maxAgeSeconds });
    Object.assign(official, {
      capturedAt: toIso(Date.parse(stateResult.capture.capturedAt)),
      ageSeconds: result.ageSeconds,
      stale: result.stale,
      expiredWindows: result.expired,
      windows: result.windows,
    });
  }
  const withSource = (windowName, window) => {
    const rateLimitKey = Object.keys(WindowMapping).find((key) => WindowMapping[key] === windowName);
    const officialWindow = official.windows[rateLimitKey] || null;
    return officialWindow
      ? { ...window, source: 'official', sourceLabel: officialWindow.sourceLabel, official: officialWindow }
      : { ...window, source: 'estimate', sourceLabel: estimateLabel, official: null };
  };
  const session = withSource('session', quota.session);
  const weekly = withSource('weekly', quota.weekly);
  return {
    ...quota,
    // true while any shown window is still an estimate.
    estimate: session.source === 'estimate' || weekly.source === 'estimate',
    session,
    weekly,
    // Windows other than five_hour/seven_day (spend_limit, any future per-model window).
    extraWindows: Object.values(official.windows).filter((window) => !(window.key in WindowMapping)),
    official,
    block,
  };
}
