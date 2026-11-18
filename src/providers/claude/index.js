// Claude provider adapter: local transcripts (API-equivalent cost) + optional
// Anthropic Admin API (real org usage/cost).
import { aggregateClaudeUsage } from './aggregate.js';
import { fetchAdminUsage } from './admin-api.js';
import { loadPricingTable, priceUsageRecord } from './pricing.js';
import { estimateClaudeQuota } from './quota.js';
import { loadClaudeQuotaConfig } from '../../config.js';

// Per-message quota inputs. Synthetic (unpriced) messages are not API calls and
// never count; unknown models count their tokens but have no USD (usd: null).
export function quotaEntries(usageRecords, pricingTable) {
  const entries = [];
  for (const usageRecord of usageRecords) {
    const priced = priceUsageRecord(pricingTable, usageRecord);
    if (priced.status === 'unpriced') continue;
    entries.push({
      timestamp: usageRecord.timestamp,
      tokens: usageRecord.inputTokens + usageRecord.outputTokens + usageRecord.cacheWrite5mTokens
        + usageRecord.cacheWrite1hTokens + usageRecord.cacheReadTokens,
      usd: priced.status === 'priced' ? priced.costUsd : null,
    });
  }
  return entries;
}

export function createClaudeProvider({
  pricingFilePath, adminKey, timeZone, fetchImpl, quotaConfig = loadClaudeQuotaConfig({}),
}) {
  let cachedAdminUsage = { configured: Boolean(adminKey), pending: true };

  return {
    id: 'claude',
    name: 'Claude',
    async collect(context) {
      const pricingTable = await loadPricingTable(pricingFilePath); // re-read so edits apply on refresh
      const transcripts = await context.getTranscripts();
      const { byDayUnroundedCostUsd, ...aggregate } = aggregateClaudeUsage(transcripts.usageRecords, { pricingTable, timeZone, now: context.now });
      const quota = estimateClaudeQuota(quotaEntries(transcripts.usageRecords, pricingTable), {
        quotaConfig, now: context.now, timeZone,
      });
      const { recentBlocks, ...quotaSummary } = quota;

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
        // Estimated plan-limit usage; see quota.js. Detail adds recent session blocks.
        quota: quotaSummary,
      };
      if (quota.session.overLimit || quota.weekly.overLimit) {
        summary.warnings.push('Estimated Claude usage is over a configured limit; recalibrate against /usage if Claude is not limiting you.');
      }
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
            day: row.day, costUsd: byDayUnroundedCostUsd[row.day], tokens: row.totalTokens, messages: row.messageCount,
          })),
        },
        detail: {
          costLabel: 'API-equivalent cost (subscription)',
          costNote: 'Computed from local Claude Code transcript token counts × the editable pricing table '
            + `(${pricingTable.source}, as of ${pricingTable.asOf}). This is what the same tokens would cost on the API; `
            + 'it is not your subscription bill.',
          ...aggregate,
          quota: { ...quotaSummary, recentBlocks },
          scan: transcripts.stats,
          adminApi: cachedAdminUsage,
        },
      };
    },
  };
}
