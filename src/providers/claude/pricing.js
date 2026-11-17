// API-equivalent cost calculation for Claude usage records.
import fs from 'node:fs/promises';

const RateFields = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];

export async function loadPricingTable(pricingFilePath) {
  const pricingText = await fs.readFile(pricingFilePath, 'utf8');
  return validatePricingTable(JSON.parse(pricingText));
}

export function validatePricingTable(pricingTable) {
  if (!pricingTable || typeof pricingTable.models !== 'object') {
    throw new Error('pricing table must have a "models" object');
  }
  for (const [modelId, rates] of Object.entries(pricingTable.models)) {
    for (const field of RateFields) {
      if (typeof rates[field] !== 'number' || rates[field] < 0) {
        throw new Error(`pricing for ${modelId} is missing a non-negative number for "${field}"`);
      }
    }
    if (rates.longContext) {
      if (typeof rates.longContext.thresholdTokens !== 'number') {
        throw new Error(`pricing for ${modelId}.longContext needs thresholdTokens`);
      }
      for (const field of RateFields) {
        if (typeof rates.longContext[field] !== 'number') {
          throw new Error(`pricing for ${modelId}.longContext is missing "${field}"`);
        }
      }
    }
  }
  return pricingTable;
}

// Exact id, or exact id + "-YYYYMMDD". Deliberately strict: a loose prefix
// match would silently price an unreleased "claude-opus-4-9" as "claude-opus-4".
export function findModelRates(pricingTable, modelId) {
  if (pricingTable.models[modelId]) return pricingTable.models[modelId];
  const datedMatch = typeof modelId === 'string' ? modelId.match(/^(.*)-(\d{8})$/) : null;
  if (datedMatch && pricingTable.models[datedMatch[1]]) return pricingTable.models[datedMatch[1]];
  return null;
}

export function isUnpricedModel(pricingTable, modelId) {
  return (pricingTable.unpricedModels || []).includes(modelId);
}

// Returns { status: 'priced'|'unknown'|'unpriced', costUsd, costByTokenType }.
export function priceUsageRecord(pricingTable, usageRecord) {
  if (isUnpricedModel(pricingTable, usageRecord.model)) {
    return { status: 'unpriced', costUsd: 0, costByTokenType: null };
  }
  const baseRates = findModelRates(pricingTable, usageRecord.model);
  if (!baseRates) return { status: 'unknown', costUsd: null, costByTokenType: null };

  const promptTokens = usageRecord.inputTokens + usageRecord.cacheWrite5mTokens
    + usageRecord.cacheWrite1hTokens + usageRecord.cacheReadTokens;
  const rates = baseRates.longContext && promptTokens > baseRates.longContext.thresholdTokens
    ? baseRates.longContext
    : baseRates;

  const perToken = (tokens, ratePerMillion) => (tokens * ratePerMillion) / 1e6;
  const costByTokenType = {
    input: perToken(usageRecord.inputTokens, rates.input),
    cacheWrite: perToken(usageRecord.cacheWrite5mTokens, rates.cacheWrite5m)
      + perToken(usageRecord.cacheWrite1hTokens, rates.cacheWrite1h),
    cacheRead: perToken(usageRecord.cacheReadTokens, rates.cacheRead),
    output: perToken(usageRecord.outputTokens, rates.output),
    serverWebSearch: (usageRecord.serverWebSearchRequests || 0)
      * ((pricingTable.serverTools?.webSearchPer1k ?? 0) / 1000),
  };
  const costUsd = Object.values(costByTokenType).reduce((sum, value) => sum + value, 0);
  return { status: 'priced', costUsd, costByTokenType };
}
