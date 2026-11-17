// Normalized time windows (today / last 7 days / all time) computed from a
// provider's per-day series. Providers return
//   timeSeries: { metrics: ['costUsd', 'tokens', 'searches', 'messages'], byDay: [{ day, ...metrics }] }
// and dashboard-state attaches `summary.windows` automatically, so every new
// provider gets windows and a slot in the "All platforms" total for free.
//
// Days are YYYY-MM-DD in the dashboard time zone. "last7Days" is today plus
// the six previous calendar days. Rows with day "unknown" (no timestamp) only
// count toward allTime.
import { localDay, roundUsd } from './util.js';

export const WindowMetrics = ['costUsd', 'tokens', 'searches', 'messages'];
export const WindowIds = ['today', 'last7Days', 'allTime'];

// Calendar arithmetic on day strings; UTC math avoids DST off-by-one errors.
export function shiftDay(day, deltaDays) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function emptyWindow(metrics) {
  return Object.fromEntries(metrics.map((metric) => [metric, 0]));
}

function roundWindow(window) {
  if (window.costUsd != null) window.costUsd = roundUsd(window.costUsd);
  return window;
}

export function computeWindows(timeSeries, { now, timeZone }) {
  const metrics = (timeSeries?.metrics || []).filter((metric) => WindowMetrics.includes(metric));
  const today = localDay(now.toISOString(), timeZone);
  const weekStart = shiftDay(today, -6);
  const windows = {
    today: emptyWindow(metrics), last7Days: emptyWindow(metrics), allTime: emptyWindow(metrics),
  };
  for (const row of timeSeries?.byDay || []) {
    const isDated = /^\d{4}-\d{2}-\d{2}$/.test(row.day);
    const targets = [windows.allTime];
    if (isDated && row.day === today) targets.push(windows.today);
    if (isDated && row.day >= weekStart && row.day <= today) targets.push(windows.last7Days);
    for (const metric of metrics) {
      const value = Number(row[metric]) || 0;
      for (const target of targets) target[metric] += value;
    }
  }
  for (const windowId of WindowIds) roundWindow(windows[windowId]);
  return { range: { today, weekStart }, metrics, ...windows };
}
