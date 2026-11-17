// Claude provider adapter: local transcripts (API-equivalent cost) + optional
// Anthropic Admin API (real org usage/cost).
import { aggregateClaudeUsage } from './aggregate.js';
import { fetchAdminUsage } from './admin-api.js';
import { loadPricingTable } from './pricing.js';

export function createClaudeProvider({ pricingFilePath, adminKey, timeZone, fetchImpl }) {
  let cachedAdminUsage = { configured: Boolean(adminKey), pending: true };

  return {
    id: 'claude',
    name: 'Claude',
    async collect(context) {
      const pricingTable = await loadPricingTable(pricingFilePath); // re-read so edits apply on refresh
      const transcripts = await context.getTranscripts();
      const aggregate = aggregateClaudeUsage(transcripts.usageRecords, { pricingTable, timeZone, now: context.now });

      if (!adminKey) cachedAdminUsage = { configured: false };
      else if (context.reason !== 'page-load') {
        cachedAdminUsage = await fetchAdminUsage({ adminKey, fetchImpl, now: context.now });
      }

      const summary = {
        id: 'claude',
        name: 'Claude',
        costKind: 'api-equivalent',
        costLabel: 'API-equivalent cost (subscription)',
        costUsd: aggregate.totals.costUsd,
        primaryMetric: { label: 'Total tokens', value: aggregate.totals.totalTokens },
        secondaryMetrics: [
          { label: 'Messages', value: aggregate.totals.messageCount },
          { label: 'Sessions', value: aggregate.sessionCount },
          { label: `Cost ${aggregate.monthToDate.month}`, value: aggregate.monthToDate.costUsd, unit: 'usd' },
        ],
        warnings: aggregate.unknownModels.length
          ? [`Unpriced models: ${aggregate.unknownModels.map((row) => row.model).join(', ')}`]
          : [],
      };
      if (cachedAdminUsage.configured && cachedAdminUsage.ok) {
        summary.secondaryMetrics.push({
          label: `Org billed, last ${cachedAdminUsage.lookbackDays}d`, value: cachedAdminUsage.cost.totalCostUsd, unit: 'usd',
        });
      }

      return {
        summary,
        timeSeries: {
          metrics: ['costUsd', 'tokens', 'messages'],
          byDay: aggregate.byDay.map((row) => ({
            day: row.day, costUsd: row.costUsd, tokens: row.totalTokens, messages: row.messageCount,
          })),
        },
        detail: {
          costLabel: 'API-equivalent cost (subscription)',
          costNote: 'Computed from local Claude Code transcript token counts × the editable pricing table '
            + `(${pricingTable.source}, as of ${pricingTable.asOf}). This is what the same tokens would cost on the API; `
            + 'it is not your subscription bill.',
          ...aggregate,
          scan: transcripts.stats,
          adminApi: cachedAdminUsage,
        },
      };
    },
  };
}
