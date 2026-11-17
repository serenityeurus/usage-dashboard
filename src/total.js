// "All platforms" roll-up across every provider's normalized windows and
// per-day series. Spend is split by cost kind because the numbers are not the
// same sort of money:
//   actual          what was (or will be) billed, e.g. a self-hosted $0
//   api-equivalent  what subscription usage would cost at API list prices
//   estimated       count × list price, not confirmed by the vendor
import { roundUsd } from './util.js';
import { WindowIds } from './windows.js';

export const CostKinds = ['actual', 'api-equivalent', 'estimated'];
const CountMetrics = ['tokens', 'searches', 'messages'];

function emptyTotalWindow() {
  return {
    costUsd: 0,
    costByKind: Object.fromEntries(CostKinds.map((kind) => [kind, 0])),
    tokens: 0,
    searches: 0,
    messages: 0,
  };
}

export function computeTotal(entries) {
  const windows = Object.fromEntries(WindowIds.map((windowId) => [windowId, emptyTotalWindow()]));
  const providers = [];
  const dayMap = new Map();

  for (const entry of entries) {
    const summary = entry.summary || {};
    const costKind = CostKinds.includes(summary.costKind) ? summary.costKind : 'estimated';
    if (summary.windows) {
      for (const windowId of WindowIds) {
        const source = summary.windows[windowId] || {};
        const target = windows[windowId];
        const cost = Number(source.costUsd) || 0;
        target.costUsd += cost;
        target.costByKind[costKind] += cost;
        for (const metric of CountMetrics) target[metric] += Number(source[metric]) || 0;
      }
    }
    providers.push({
      id: summary.id,
      name: summary.name,
      costKind,
      costLabel: summary.costLabel,
      active: summary.active,
      ok: entry.ok,
      metrics: summary.windows?.metrics || [],
      windows: summary.windows ? Object.fromEntries(WindowIds.map((windowId) => [windowId, summary.windows[windowId]])) : null,
    });
    for (const row of entry.timeSeries?.byDay || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) continue;
      if (!dayMap.has(row.day)) dayMap.set(row.day, {});
      dayMap.get(row.day)[summary.id] = {
        costUsd: roundUsd(Number(row.costUsd) || 0),
        searches: Number(row.searches) || 0,
        tokens: Number(row.tokens) || 0,
      };
    }
  }

  for (const windowId of WindowIds) {
    const window = windows[windowId];
    window.costUsd = roundUsd(window.costUsd);
    for (const kind of CostKinds) window.costByKind[kind] = roundUsd(window.costByKind[kind]);
  }

  const byDay = [...dayMap.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([day, byProvider]) => ({
      day,
      costUsd: roundUsd(Object.values(byProvider).reduce((sum, row) => sum + row.costUsd, 0)),
      searches: Object.values(byProvider).reduce((sum, row) => sum + row.searches, 0),
      byProvider,
    }));

  return {
    summary: {
      id: 'total',
      name: 'All platforms',
      providerCount: entries.length,
      windows,
    },
    detail: { byDay, providers },
  };
}
