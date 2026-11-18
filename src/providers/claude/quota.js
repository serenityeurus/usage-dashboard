// Claude subscription quota *estimates*. Anthropic publishes no token or
// dollar figures for plan limits, only that there is a rolling 5-hour session
// limit and a weekly limit. So the user supplies the limits
// (CLAUDE_SESSION_LIMIT_* / CLAUDE_WEEKLY_LIMIT_*), calibrated against Claude
// Code's /usage, and this module measures local transcript usage against them.
//
// Session window ("block") rules, as implemented here:
// - A window opens at the first message sent after the previous window
//   expired and lasts 5 hours. It is a fixed block, not a trailing 5 hours:
//   activity at 10:10 and 14:50 is one window (resets 15:00), and a message at
//   15:05 opens the next one even with no gap in between.
// - The start is floored to the top of the (UTC) hour, matching the on-the-hour
//   reset times Claude shows and the community ccusage tool. In time zones with
//   a :30/:45 offset the reset therefore lands on the half hour locally.
// - If the latest window has expired, there is no current session: usage is 0
//   and the next message opens a new window.
// Weekly window: "rolling" = the trailing 7 days; "fixed" = from the most recent
// <weekday> HH:MM in the dashboard time zone to the same wall time 7 days later
// (so a week spanning a DST change is 167 or 169 hours).
//
// Usage is the same deduplicated transcript data as the rest of the Claude tile,
// so it misses claude.ai chat and other machines, which also count against the
// real limits. That is why every figure here is labelled an estimate.
import { roundUsd } from '../../util.js';

export const SessionWindowHours = 5;
const HourMs = 3600_000;
const DayMs = 24 * HourMs;
const SessionWindowMs = SessionWindowHours * HourMs;

export const CalibrationNote = 'Estimate only: Anthropic does not publish plan limits in tokens or dollars. '
  + 'Calibrate by comparing with Claude Code\'s /usage: if /usage shows P% and this shows U used, '
  + 'set the limit to U ÷ (P/100). Usage outside these transcripts (claude.ai, other machines) is not counted.';

const MetricEnvSuffix = { usd: 'USD', tokens: 'TOKENS' };

const zonedFormatterCache = new Map();
function zonedParts(instantMs, timeZone) {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    zonedFormatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// Offset of timeZone from UTC at the given instant, in ms (Detroit EST = -5h).
function zoneOffsetMs(instantMs, timeZone) {
  const parts = zonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (Math.floor(instantMs / 1000) * 1000);
}

// Local wall time -> UTC instant. Two passes settle DST: the offset at the
// first guess can differ from the offset at the answer near a transition.
// A wall time inside a spring-forward gap resolves to the instant just after it.
export function wallTimeToInstant({ year, month, day, hour, minute }, timeZone) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  const secondOffset = zoneOffsetMs(firstGuess, timeZone);
  return naiveUtc - secondOffset;
}

function addCalendarDays({ year, month, day }, deltaDays) {
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// The fixed weekly window containing nowMs: [start, reset).
export function fixedWeeklyWindow(nowMs, { dayOfWeek, hour, minute }, timeZone) {
  const today = zonedParts(nowMs, timeZone);
  const todayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
  let startDate = addCalendarDays(today, -((todayWeekday - dayOfWeek + 7) % 7));
  let startMs = wallTimeToInstant({ ...startDate, hour, minute }, timeZone);
  if (startMs > nowMs) {
    startDate = addCalendarDays(startDate, -7);
    startMs = wallTimeToInstant({ ...startDate, hour, minute }, timeZone);
  }
  const resetMs = wallTimeToInstant({ ...addCalendarDays(startDate, 7), hour, minute }, timeZone);
  return { startMs, resetMs };
}

function emptyUsage() {
  return { tokens: 0, usd: 0, messages: 0, unpricedMessages: 0 };
}

function addUsage(usage, entry) {
  usage.tokens += entry.tokens;
  usage.messages += 1;
  if (entry.usd == null) usage.unpricedMessages += 1;
  else usage.usd += entry.usd;
}

function finishUsage(usage) {
  return { ...usage, usd: roundUsd(usage.usd) };
}

// entries: [{ timestamp, tokens, usd|null }] -> blocks sorted by start.
export function computeSessionBlocks(entries) {
  const timedEntries = entries
    .map((entry) => ({ ...entry, atMs: Date.parse(entry.timestamp) }))
    .filter((entry) => Number.isFinite(entry.atMs))
    .sort((left, right) => left.atMs - right.atMs);
  const blocks = [];
  let currentBlock = null;
  for (const entry of timedEntries) {
    if (!currentBlock || entry.atMs >= currentBlock.endMs) {
      const startMs = Math.floor(entry.atMs / HourMs) * HourMs;
      currentBlock = { startMs, endMs: startMs + SessionWindowMs, firstMs: entry.atMs, lastMs: entry.atMs, usage: emptyUsage() };
      blocks.push(currentBlock);
    }
    currentBlock.lastMs = entry.atMs;
    addUsage(currentBlock.usage, entry);
  }
  return blocks;
}

function percentOf(used, limit) {
  if (limit == null) return null;
  return Math.round((used / limit) * 1000) / 10;
}

function windowLimitFields(usage, limit, metric) {
  const percent = percentOf(usage[metric], limit);
  return { limit, percent, overLimit: percent != null && percent > 100 };
}

function howToConfigure(metric, limits) {
  const suffix = MetricEnvSuffix[metric];
  const otherMetric = metric === 'usd' ? 'tokens' : 'usd';
  const otherSet = limits.session[otherMetric] != null || limits.weekly[otherMetric] != null;
  const mismatch = otherSet
    ? ` Limits are set for ${otherMetric}, but CLAUDE_QUOTA_METRIC=${metric}; set CLAUDE_QUOTA_METRIC=${otherMetric} or add the ${suffix} limits.`
    : '';
  return `Set CLAUDE_SESSION_LIMIT_${suffix} and/or CLAUDE_WEEKLY_LIMIT_${suffix} in usage-dashboard.env `
    + `(${metric === 'usd' ? 'API-equivalent USD' : 'tokens, cache reads included'}), then restart. `
    + `CLAUDE_QUOTA_METRIC picks usd (default) or tokens; CLAUDE_WEEKLY_RESET is "rolling" or e.g. "mon 00:00".${mismatch}`;
}

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// quotaConfig: { metric, limits: { session: {tokens, usd}, weekly: {tokens, usd} }, weeklyReset }
export function estimateClaudeQuota(entries, { quotaConfig, now = new Date(), timeZone = 'UTC', recentBlockLimit = 10 }) {
  const { metric, limits, weeklyReset } = quotaConfig;
  const nowMs = now.getTime();
  const blocks = computeSessionBlocks(entries);
  const latestBlock = blocks[blocks.length - 1];
  const activeBlock = latestBlock && latestBlock.startMs <= nowMs && nowMs < latestBlock.endMs ? latestBlock : null;
  const sessionUsage = activeBlock ? activeBlock.usage : emptyUsage();

  let weeklyStartMs;
  let weeklyResetMs = null;
  if (weeklyReset.mode === 'fixed') {
    ({ startMs: weeklyStartMs, resetMs: weeklyResetMs } = fixedWeeklyWindow(nowMs, weeklyReset, timeZone));
  } else {
    weeklyStartMs = nowMs - 7 * DayMs;
  }
  const weeklyUsage = emptyUsage();
  let oldestInWeekMs = null;
  for (const entry of entries) {
    const atMs = Date.parse(entry.timestamp);
    // Rolling: (now - 7d, now]. Fixed: [start, reset).
    const inWindow = weeklyReset.mode === 'fixed'
      ? atMs >= weeklyStartMs && atMs < weeklyResetMs
      : atMs > weeklyStartMs && atMs <= nowMs;
    if (!inWindow) continue;
    addUsage(weeklyUsage, entry);
    if (oldestInWeekMs == null || atMs < oldestInWeekMs) oldestInWeekMs = atMs;
  }

  const configured = limits.session[metric] != null || limits.weekly[metric] != null;
  return {
    estimate: true,
    configured,
    metric,
    computedAt: now.toISOString(),
    howToConfigure: configured ? null : howToConfigure(metric, limits),
    calibrationNote: CalibrationNote,
    session: {
      windowHours: SessionWindowHours,
      active: Boolean(activeBlock),
      startAt: toIso(activeBlock?.startMs),
      resetAt: toIso(activeBlock?.endMs),
      firstMessageAt: toIso(activeBlock?.firstMs),
      used: finishUsage(sessionUsage),
      ...windowLimitFields(sessionUsage, limits.session[metric], metric),
    },
    weekly: {
      mode: weeklyReset.mode,
      label: weeklyReset.label,
      startAt: toIso(weeklyStartMs),
      // Rolling windows never reset as a whole; nextDropAt is when the oldest
      // counted message ages out.
      resetAt: toIso(weeklyResetMs),
      nextDropAt: weeklyReset.mode === 'rolling' && oldestInWeekMs != null ? toIso(oldestInWeekMs + 7 * DayMs) : null,
      used: finishUsage(weeklyUsage),
      ...windowLimitFields(weeklyUsage, limits.weekly[metric], metric),
    },
    recentBlocks: blocks.slice(-recentBlockLimit).reverse().map((block) => ({
      startAt: toIso(block.startMs),
      resetAt: toIso(block.endMs),
      firstMessageAt: toIso(block.firstMs),
      lastMessageAt: toIso(block.lastMs),
      active: block === activeBlock,
      used: finishUsage(block.usage),
      percent: percentOf(block.usage[metric], limits.session[metric]),
    })),
  };
}
