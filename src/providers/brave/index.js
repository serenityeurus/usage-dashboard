// Brave Search provider adapter: live quota headers + transcript-derived history.
import { selectCallsForProvider } from '../../web-search-attribution.js';
import { aggregateWebSearchCalls, searchTimeSeries } from '../../web-search-history.js';
import { createQuotaProbe } from './quota.js';

// Each quota probe is a billable Brave query, so decide carefully:
//   BRAVE_QUOTA_PROBE=false -> never probe
//   BRAVE_QUOTA_PROBE=true  -> probe on every refresh (startup per BRAVE_PROBE_ON_STARTUP)
//   BRAVE_QUOTA_PROBE=auto  -> like true while Brave is the active web_search
//                              provider; otherwise only when explicitly requested
//                              (POST /api/refresh?probe=brave, the "Probe quota" button)
export function decideQuotaProbe({ mode, active, probeOnStartup, reason, explicitlyRequested }) {
  if (mode === 'false') return { probe: false, why: 'disabled by BRAVE_QUOTA_PROBE=false' };
  if (explicitlyRequested) return { probe: true, why: 'explicitly requested' };
  if (mode === 'auto' && !active) return { probe: false, why: 'Brave is not the active web_search provider; probe on request only' };
  if (reason === 'startup' && !probeOnStartup) return { probe: false, why: 'skipped at startup (BRAVE_PROBE_ON_STARTUP=false)' };
  return { probe: true, why: reason };
}

export function createBraveProvider({
  apiKey, costPer1k, monthlyCreditUsd, timeZone, fetchImpl, quotaMinIntervalSeconds, probeOnStartup = true,
  quotaProbeMode = 'auto', active = true, attributionOptions = {},
}) {
  const quotaProbe = createQuotaProbe({ apiKey, fetchImpl, minIntervalSeconds: quotaMinIntervalSeconds });

  return {
    id: 'brave',
    name: 'Brave Search',
    async collect(context) {
      const transcripts = await context.getTranscripts();
      // Only calls attributed to Brave: SearXNG-served searches must not be billed here.
      const { calls, attribution } = selectCallsForProvider(transcripts.webSearchCalls, 'brave', attributionOptions);
      const history = aggregateWebSearchCalls(calls, {
        timeZone, costPer1k, monthlyCreditUsd, now: context.now,
      });
      const probeDecision = decideQuotaProbe({
        mode: quotaProbeMode,
        active,
        probeOnStartup,
        reason: context.reason,
        explicitlyRequested: Boolean(context.probes?.has('brave')),
      });
      const quotaResult = probeDecision.probe ? await quotaProbe.probe(context.now) : quotaProbe.getLast();
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
          active,
          costKind: 'estimated',
          costLabel: 'Estimated spend (all-time, before credit)',
          costUsd: history.totalGrossUsd,
          primaryMetric: { label: 'Searches (from transcripts)', value: history.totalCount },
          secondaryMetrics,
          warnings,
        },
        timeSeries: searchTimeSeries(history),
        detail: {
          costLabel: 'Estimated spend',
          costNote: `Search count × $${costPer1k} per 1,000 requests, minus a $${monthlyCreditUsd} monthly credit `
            + '(https://api-dashboard.search.brave.com/documentation/pricing). Counts are web_search tool calls '
            + 'found in local Claude Code transcripts that Brave served (searches answered by SearXNG are excluded); '
            + 'searches made outside those transcripts are not counted. The quota probe itself uses one query.',
          pricing: { costPer1k, monthlyCreditUsd },
          active,
          attribution,
          ...history,
          quota: quotaResult,
          quotaProbe: { mode: quotaProbeMode, ranThisRefresh: probeDecision.probe, reason: probeDecision.why },
          scan: transcripts.stats,
        },
      };
    },
  };
}
