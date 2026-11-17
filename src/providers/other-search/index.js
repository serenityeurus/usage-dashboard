// "Other web search": OpenClaw web_search calls whose result records a backend
// this dashboard does not model (anything outside WebSearchProviderIds, e.g.
// "perplexity"). Without this adapter they would vanish from every count.
//
// Only searches are reported. The price of an unknown backend is unknown, so
// the time series has no costUsd metric and this provider adds nothing to any
// spend figure; it only adds to "Searches (all providers)".
import { selectCallsForProvider, WebSearchProviderIds } from '../../web-search-attribution.js';
import { aggregateWebSearchCalls } from '../../web-search-history.js';

const isUnmodelledProvider = (provider) => !WebSearchProviderIds.includes(provider);

export function createOtherWebSearchProvider({ timeZone, attributionOptions = {} }) {
  return {
    id: 'other-search',
    name: 'Other web search',
    async collect(context) {
      const transcripts = await context.getTranscripts();
      const { calls, attribution } = selectCallsForProvider(transcripts.webSearchCalls, isUnmodelledProvider, attributionOptions);
      const history = aggregateWebSearchCalls(calls, { timeZone, costPer1k: 0, monthlyCreditUsd: 0, now: context.now });
      const byProvider = new Map();
      for (const call of calls) byProvider.set(call.recordedProvider, (byProvider.get(call.recordedProvider) || 0) + 1);
      const providerRows = [...byProvider.entries()]
        .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
        .map(([provider, count]) => ({ provider, count }));

      return {
        summary: {
          id: 'other-search',
          name: 'Other web search',
          hidden: calls.length === 0, // no tile until such a call exists; still part of the total
          active: false,
          costKind: 'estimated',
          costLabel: 'Spend unknown (backend not modelled)',
          costUsd: null,
          primaryMetric: { label: 'Searches (from transcripts)', value: history.totalCount },
          secondaryMetrics: [
            { label: 'Backends', value: providerRows.map((row) => row.provider).join(', ') || '—' },
          ],
          warnings: [],
        },
        timeSeries: {
          metrics: ['searches'],
          byDay: history.byDay.map((row) => ({ day: row.day, searches: row.count })),
        },
        detail: {
          costLabel: 'Spend unknown',
          costNote: 'OpenClaw web_search calls whose result names a backend other than Brave or SearXNG. '
            + 'They count toward total searches; no spend is estimated because the price is unknown.',
          attribution,
          byProvider: providerRows,
          totalCount: history.totalCount,
          monthToDate: history.monthToDate,
          byDay: history.byDay,
          byAgent: history.byAgent,
          byMonth: history.byMonth,
          scan: transcripts.stats,
        },
      };
    },
  };
}
