// SearXNG provider adapter: self-hosted, key-free web_search backend.
// Spend is always $0 (actual); the tile shows search volume and instance health.
import { activeProviderMetrics, resolveActiveWebSearchProvider, selectCallsForProvider } from '../../web-search-attribution.js';
import { aggregateWebSearchCalls, searchTimeSeries } from '../../web-search-history.js';
import { checkSearxngHealth } from './health.js';

export function createSearxngProvider({ baseUrl, timeZone, fetchImpl, timeoutSeconds = 5, webSearchProvider = null, attributionOptions = {} }) {
  return {
    id: 'searxng',
    name: 'SearXNG',
    async collect(context) {
      const [transcripts, health] = await Promise.all([
        context.getTranscripts(),
        checkSearxngHealth({ baseUrl, fetchImpl, timeoutSeconds }),
      ]);
      const { calls, attribution } = selectCallsForProvider(transcripts.webSearchCalls, 'searxng', attributionOptions);
      const activeProvider = resolveActiveWebSearchProvider(webSearchProvider, transcripts.webSearchCalls);
      const active = activeProvider.id === 'searxng';
      const history = aggregateWebSearchCalls(calls, { timeZone, costPer1k: 0, monthlyCreditUsd: 0, now: context.now });

      let healthLabel = 'not configured';
      if (health.configured) healthLabel = health.ok ? `up (${health.latencyMs} ms)` : 'down';
      const warnings = [];
      if (!health.configured) warnings.push('SEARXNG_BASE_URL not set: instance health unavailable');
      else if (!health.ok) warnings.push(`Instance unhealthy: ${health.error}`);

      return {
        summary: {
          id: 'searxng',
          name: 'SearXNG',
          active,
          activeProvider,
          costKind: 'actual',
          costLabel: 'Spend (self-hosted, free)',
          costUsd: 0,
          primaryMetric: { label: 'Searches (from transcripts)', value: history.totalCount },
          secondaryMetrics: [
            { label: `Searches ${history.monthToDate.month}`, value: history.monthToDate.count },
            { label: 'Instance health', value: healthLabel },
            ...activeProviderMetrics(activeProvider),
          ],
          warnings,
        },
        timeSeries: searchTimeSeries(history),
        detail: {
          costLabel: 'Spend (self-hosted, free)',
          costNote: 'SearXNG is self-hosted and key-free, so searches cost $0. Counts are OpenClaw web_search calls '
            + 'in local Claude Code transcripts whose result reports provider "searxng" (or, when the result is '
            + 'missing, that fall after a searxng entry in WEB_SEARCH_PROVIDER_HISTORY).',
          active,
          activeProvider,
          attribution,
          ...history,
          health,
          scan: transcripts.stats,
        },
      };
    },
  };
}
