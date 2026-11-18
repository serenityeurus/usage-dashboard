// Holds the latest snapshot of every provider and coordinates refreshes.
//
// Provider adapter contract (add new providers by implementing this):
//   { id: string, name: string, collect(context) -> Promise<{ summary, detail, timeSeries? }> }
//   context.getTranscripts() -> memoized transcript scan shared by all
//     providers within one refresh (each file is read at most once).
//   context.now    -> Date of this refresh
//   context.reason -> 'startup' | 'refresh'
//   context.probes -> Set of explicitly requested paid probes (e.g. 'brave')
// summary: { id, name, costUsd, costLabel, costKind ('actual'|'api-equivalent'|'estimated'),
//            active?, activeProvider?{id,source,at}, hidden? (omit the tile, keep it in the total),
//            primaryMetric{label,value}, secondaryMetrics[{label,value,unit?}], warnings[] }
// timeSeries: { metrics: ['costUsd','tokens','searches','messages'], byDay: [{ day, ...metrics }] }
//   When present, summary.windows (today / last7Days / allTime) is computed
//   here and the provider is included in the "All platforms" total.
//
// Windows and the total are derived on every read (getSnapshot), not stored:
// "today" depends on the clock, so values computed at refresh time go stale at
// local midnight, and a failed provider's reused data would otherwise carry
// windows computed against an old "now". The stored snapshot keeps only the
// raw summaries and time series; the derivation is a few hundred additions.
// detail:  provider-specific breakdown rendered by the provider's UI view.
import { computeTotal } from './total.js';
import { computeWindows } from './windows.js';

export function createDashboardState({ providers, transcriptScanner, clock = () => new Date(), timeZone = 'UTC' }) {
  let snapshot = { refreshedAt: null, durationMs: null, providers: {} };
  let refreshInFlight = null;

  async function runRefresh(reason, probes) {
    const startedAt = Date.now();
    const now = clock();
    let transcriptsPromise = null;
    const context = {
      now,
      reason,
      probes,
      getTranscripts: () => {
        transcriptsPromise ||= transcriptScanner.scan();
        return transcriptsPromise;
      },
    };

    const results = await Promise.all(providers.map(async (provider) => {
      try {
        const { summary, detail, timeSeries = null } = await provider.collect(context);
        return [provider.id, { ok: true, summary, detail, timeSeries }];
      } catch (error) {
        // One broken provider must not take down the dashboard.
        const previous = snapshot.providers[provider.id];
        return [provider.id, {
          ok: false,
          error: error.message,
          summary: previous?.summary ?? { id: provider.id, name: provider.name, warnings: [] },
          detail: previous?.detail ?? null,
          timeSeries: previous?.timeSeries ?? null,
          stale: Boolean(previous?.summary),
        }];
      }
    }));

    snapshot = {
      refreshedAt: now.toISOString(),
      refreshReason: reason,
      durationMs: Date.now() - startedAt,
      timeZone,
      providers: Object.fromEntries(results),
    };
    return currentView();
  }

  // The snapshot as of now: windows and total recomputed against clock().
  function currentView() {
    const now = clock();
    const range = computeWindows(null, { now, timeZone }).range;
    const providerEntries = Object.fromEntries(Object.entries(snapshot.providers).map(([providerId, entry]) => {
      if (!entry.timeSeries) return [providerId, entry];
      const windows = computeWindows(entry.timeSeries, { now, timeZone });
      return [providerId, { ...entry, summary: { ...entry.summary, windows } }];
    }));
    let total = null;
    if (snapshot.refreshedAt) {
      total = computeTotal(Object.values(providerEntries));
      total.summary.range = range;
    }
    return {
      ...snapshot, timeZone, range, providers: providerEntries, total,
    };
  }

  return {
    // Concurrent refresh requests share one in-flight run instead of stacking.
    // A request that asks for probes the in-flight run lacks waits for it, then
    // starts its own run, so an explicit probe request is never silently dropped.
    async refresh(reason = 'refresh', { probes = [] } = {}) {
      const requestedProbes = new Set(probes);
      while (refreshInFlight) {
        const inFlight = refreshInFlight;
        if ([...requestedProbes].every((probe) => inFlight.probes.has(probe))) return inFlight.promise;
        await inFlight.promise.catch(() => null);
      }
      const promise = runRefresh(reason, requestedProbes).finally(() => { refreshInFlight = null; });
      refreshInFlight = { promise, probes: requestedProbes };
      return promise;
    },
    getSnapshot: currentView,
    getRefreshedAt: () => snapshot.refreshedAt, // cheap: /healthz does not need windows
    isRefreshing: () => Boolean(refreshInFlight),
    providerIds: () => providers.map((provider) => provider.id),
  };
}
