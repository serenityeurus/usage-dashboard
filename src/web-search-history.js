// Aggregates OpenClaw web_search tool calls (found in Claude Code transcripts)
// into a usage history (by day, agent, month) with estimated spend. Shared by
// every search backend; self-hosted ones pass costPer1k = 0.
import { friendlyProjectName, localDay, localMonth, roundUsd } from './util.js';

export function aggregateWebSearchCalls(webSearchCalls, { timeZone, costPer1k, monthlyCreditUsd, now = new Date() }) {
  const byDay = new Map();
  const byAgent = new Map();
  const byMonth = new Map();
  const currentMonth = localMonth(now.toISOString(), timeZone);

  for (const call of webSearchCalls) {
    const day = localDay(call.timestamp, timeZone) || 'unknown';
    const agent = friendlyProjectName(call.projectDir);
    byDay.set(day, (byDay.get(day) || 0) + 1);
    byAgent.set(agent, (byAgent.get(agent) || 0) + 1);
    const month = day === 'unknown' ? 'unknown' : day.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + 1);
  }

  const estimateUsd = (count) => roundUsd((count * costPer1k) / 1000);
  // Brave grants a monthly credit; spend beyond it is what actually gets billed.
  const monthRow = (month, count) => {
    const grossUsd = estimateUsd(count);
    return { month, count, grossUsd, netUsd: roundUsd(Math.max(0, grossUsd - monthlyCreditUsd)) };
  };

  const totalCount = webSearchCalls.length;
  const monthToDateCount = byMonth.get(currentMonth) || 0;
  return {
    totalCount,
    totalGrossUsd: estimateUsd(totalCount),
    monthToDate: monthRow(currentMonth, monthToDateCount),
    byDay: [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([day, count]) => ({ day, count, estimatedUsd: estimateUsd(count) })),
    byAgent: [...byAgent.entries()].sort(([, left], [, right]) => right - left)
      .map(([agent, count]) => ({ agent, count, estimatedUsd: estimateUsd(count) })),
    byMonth: [...byMonth.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([month, count]) => monthRow(month, count)),
  };
}

// Normalized per-day series for time windows and the all-platforms total.
export function searchTimeSeries(history) {
  return {
    metrics: ['costUsd', 'searches'],
    byDay: history.byDay.map((row) => ({ day: row.day, costUsd: row.estimatedUsd, searches: row.count })),
  };
}
