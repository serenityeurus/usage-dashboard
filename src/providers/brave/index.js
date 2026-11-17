// Brave Search provider adapter: live quota headers + transcript-derived history.
import { aggregateWebSearchCalls } from './history.js';
import { createQuotaProbe } from './quota.js';

export function createBraveProvider({ apiKey, costPer1k, monthlyCreditUsd, timeZone, fetchImpl, quotaMinIntervalSeconds, probeOnStartup = true }) {
  const quotaProbe = createQuotaProbe({ apiKey, fetchImpl, minIntervalSeconds: quotaMinIntervalSeconds });

  return {
    id: 'brave',
    name: 'Brave Search',
    async collect(context) {
      const transcripts = await context.getTranscripts();
      const history = aggregateWebSearchCalls(transcripts.webSearchCalls, {
        timeZone, costPer1k, monthlyCreditUsd, now: context.now,
      });
      // Probing costs one billable query; only startup and explicit refresh call collect().
      const skipProbe = context.reason === 'startup' && !probeOnStartup;
      const quotaResult = skipProbe ? quotaProbe.getLast() : await quotaProbe.probe(context.now);
      const monthly = quotaResult.quota?.monthly;

      const secondaryMetrics = [
        { label: `Searches ${history.monthToDate.month}`, value: history.monthToDate.count },
        { label: `Est. billed ${history.monthToDate.month} (after credit)`, value: history.monthToDate.netUsd, unit: 'usd' },
      ];
      if (monthly && !monthly.unlimited && monthly.remaining != null) {
        secondaryMetrics.push({ label: 'Quota remaining (Brave)', value: `${monthly.remaining} / ${monthly.limit}` });
      } else if (monthly?.unlimited) {
        secondaryMetrics.push({ label: 'Monthly quota (Brave)', value: 'unlimited (pay as you go)' });
      }

      const warnings = [];
      if (!quotaResult.configured) warnings.push('BRAVE_API_KEY not set: live quota unavailable');
      else if (quotaResult.probed && !quotaResult.ok) warnings.push(`Quota probe failed: ${quotaResult.error}`);

      return {
        summary: {
          id: 'brave',
          name: 'Brave Search',
          costLabel: 'Estimated spend (all-time, before credit)',
          costUsd: history.totalGrossUsd,
          primaryMetric: { label: 'Searches (from transcripts)', value: history.totalCount },
          secondaryMetrics,
          warnings,
        },
        detail: {
          costLabel: 'Estimated spend',
          costNote: `Search count × $${costPer1k} per 1,000 requests, minus a $${monthlyCreditUsd} monthly credit `
            + '(https://api-dashboard.search.brave.com/documentation/pricing). Counts are web_search tool calls '
            + 'found in local Claude Code transcripts; searches made outside those transcripts are not counted. '
            + 'The quota probe itself uses one query per refresh.',
          pricing: { costPer1k, monthlyCreditUsd },
          ...history,
          quota: quotaResult,
          scan: transcripts.stats,
        },
      };
    },
  };
}
