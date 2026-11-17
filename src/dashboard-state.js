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
//            active?, primaryMetric{label,value}, secondaryMetrics[{label,value,unit?}], warnings[] }
// timeSeries: { metrics: ['costUsd','tokens','searches','messages'], byDay: [{ day, ...metrics }] }
//   When present, summary.windows (today / last7Days / allTime) is computed
//   here and the provider is included in the "All platforms" total.
// detail:  provider-specific breakdown rendered by the provider's UI view.
import { computeTotal } from './total.js';
import { computeWindows } from './windows.js';

export function createDashboardState({ providers, transcriptScanner, clock = () => new Date(), timeZone = 'UTC' }) {
  let snapshot = { refreshedAt: null, durationMs: null, providers: {}, total: null };
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
        const windows = timeSeries ? computeWindows(timeSeries, { now, timeZone }) : undefined;
        return [provider.id, {
          ok: true, summary: windows ? { ...summary, windows } : summary, detail, timeSeries,
        }];
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

    const providerEntries = Object.fromEntries(results);
    snapshot = {
      refreshedAt: now.toISOString(),
      refreshReason: reason,
      durationMs: Date.now() - startedAt,
      timeZone,
      providers: providerEntries,
      total: computeTotal(Object.values(providerEntries)),
    };
    return snapshot;
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
    getSnapshot: () => snapshot,
    isRefreshing: () => Boolean(refreshInFlight),
    providerIds: () => providers.map((provider) => provider.id),
  };
}
