// Holds the latest snapshot of every provider and coordinates refreshes.
//
// Provider adapter contract (add new providers by implementing this):
//   { id: string, name: string, collect(context) -> Promise<{ summary, detail }> }
//   context.getTranscripts() -> memoized transcript scan shared by all
//     providers within one refresh (each file is read at most once).
//   context.now    -> Date of this refresh
//   context.reason -> 'startup' | 'refresh'
// summary: { id, name, costUsd, costLabel, primaryMetric{label,value},
//            secondaryMetrics[{label,value,unit?}], warnings[] }
// detail:  provider-specific breakdown rendered by the provider's UI view.

export function createDashboardState({ providers, transcriptScanner, clock = () => new Date() }) {
  let snapshot = { refreshedAt: null, durationMs: null, providers: {} };
  let refreshInFlight = null;

  async function runRefresh(reason) {
    const startedAt = Date.now();
    const now = clock();
    let transcriptsPromise = null;
    const context = {
      now,
      reason,
      getTranscripts: () => {
        transcriptsPromise ||= transcriptScanner.scan();
        return transcriptsPromise;
      },
    };

    const results = await Promise.all(providers.map(async (provider) => {
      try {
        const { summary, detail } = await provider.collect(context);
        return [provider.id, { ok: true, summary, detail }];
      } catch (error) {
        // One broken provider must not take down the dashboard.
        const previous = snapshot.providers[provider.id];
        return [provider.id, {
          ok: false,
          error: error.message,
          summary: previous?.summary ?? { id: provider.id, name: provider.name, warnings: [] },
          detail: previous?.detail ?? null,
          stale: Boolean(previous?.summary),
        }];
      }
    }));

    snapshot = {
      refreshedAt: now.toISOString(),
      refreshReason: reason,
      durationMs: Date.now() - startedAt,
      providers: Object.fromEntries(results),
    };
    return snapshot;
  }

  return {
    // Concurrent refresh requests share one in-flight run instead of stacking.
    refresh(reason = 'refresh') {
      refreshInFlight ||= runRefresh(reason).finally(() => { refreshInFlight = null; });
      return refreshInFlight;
    },
    getSnapshot: () => snapshot,
    isRefreshing: () => Boolean(refreshInFlight),
    providerIds: () => providers.map((provider) => provider.id),
  };
}
