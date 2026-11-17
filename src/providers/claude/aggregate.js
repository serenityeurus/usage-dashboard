// Turns deduplicated usage records into the Claude summary + detail payloads.
import { friendlyProjectName, localDay, localMonth, roundUsd } from '../../util.js';
import { priceUsageRecord } from './pricing.js';

function emptyBucket() {
  return {
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unknownCostMessageCount: 0,
  };
}

function addToBucket(bucket, usageRecord, priced) {
  const cacheWriteTokens = usageRecord.cacheWrite5mTokens + usageRecord.cacheWrite1hTokens;
  bucket.messageCount += 1;
  bucket.inputTokens += usageRecord.inputTokens;
  bucket.outputTokens += usageRecord.outputTokens;
  bucket.cacheWriteTokens += cacheWriteTokens;
  bucket.cacheReadTokens += usageRecord.cacheReadTokens;
  bucket.totalTokens += usageRecord.inputTokens + usageRecord.outputTokens
    + cacheWriteTokens + usageRecord.cacheReadTokens;
  if (priced.status === 'unknown') bucket.unknownCostMessageCount += 1;
  else bucket.costUsd += priced.costUsd;
}

function finalizeBucket(bucket) {
  return { ...bucket, costUsd: roundUsd(bucket.costUsd) };
}

function bucketInto(map, key, usageRecord, priced) {
  if (!map.has(key)) map.set(key, emptyBucket());
  addToBucket(map.get(key), usageRecord, priced);
  return map.get(key);
}

export function aggregateClaudeUsage(usageRecords, { pricingTable, timeZone, now = new Date(), topSessionLimit = 15 }) {
  const totals = emptyBucket();
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map();
  const bySession = new Map();
  const sessionMeta = new Map();
  const unknownModels = new Map();
  const costByTokenType = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, serverWebSearch: 0 };
  let syntheticMessageCount = 0;
  const currentMonth = localMonth(now.toISOString(), timeZone);
  const monthToDate = emptyBucket();

  for (const usageRecord of usageRecords) {
    const priced = priceUsageRecord(pricingTable, usageRecord);
    if (priced.status === 'unpriced') {
      syntheticMessageCount += 1;
      continue;
    }
    if (priced.status === 'unknown') {
      unknownModels.set(usageRecord.model, (unknownModels.get(usageRecord.model) || 0) + 1);
    } else {
      for (const tokenType of Object.keys(costByTokenType)) {
        costByTokenType[tokenType] += priced.costByTokenType[tokenType];
      }
    }

    addToBucket(totals, usageRecord, priced);
    const day = localDay(usageRecord.timestamp, timeZone) || 'unknown';
    bucketInto(byDay, day, usageRecord, priced);
    if (day.slice(0, 7) === currentMonth) addToBucket(monthToDate, usageRecord, priced);
    bucketInto(byModel, usageRecord.model, usageRecord, priced);
    const projectName = friendlyProjectName(usageRecord.projectDir);
    bucketInto(byProject, projectName, usageRecord, priced);
    bucketInto(bySession, usageRecord.sessionId, usageRecord, priced);

    const meta = sessionMeta.get(usageRecord.sessionId) || {
      project: projectName, firstAt: usageRecord.timestamp, lastAt: usageRecord.timestamp, models: new Set(),
    };
    if (usageRecord.timestamp && (!meta.firstAt || usageRecord.timestamp < meta.firstAt)) meta.firstAt = usageRecord.timestamp;
    if (usageRecord.timestamp && (!meta.lastAt || usageRecord.timestamp > meta.lastAt)) meta.lastAt = usageRecord.timestamp;
    meta.models.add(usageRecord.model);
    sessionMeta.set(usageRecord.sessionId, meta);
  }

  const toRows = (map, keyName) => [...map.entries()].map(([key, bucket]) => ({ [keyName]: key, ...finalizeBucket(bucket) }));

  const topSessions = toRows(bySession, 'sessionId')
    .sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens)
    .slice(0, topSessionLimit)
    .map((row) => {
      const meta = sessionMeta.get(row.sessionId);
      return { ...row, project: meta.project, firstAt: meta.firstAt, lastAt: meta.lastAt, models: [...meta.models].sort() };
    });

  const tokenTypeTotals = {
    input: { tokens: totals.inputTokens, costUsd: roundUsd(costByTokenType.input) },
    output: { tokens: totals.outputTokens, costUsd: roundUsd(costByTokenType.output) },
    cacheWrite: { tokens: totals.cacheWriteTokens, costUsd: roundUsd(costByTokenType.cacheWrite) },
    cacheRead: { tokens: totals.cacheReadTokens, costUsd: roundUsd(costByTokenType.cacheRead) },
  };
  if (costByTokenType.serverWebSearch > 0) {
    tokenTypeTotals.serverWebSearch = { tokens: 0, costUsd: roundUsd(costByTokenType.serverWebSearch) };
  }

  return {
    totals: finalizeBucket(totals),
    monthToDate: { month: currentMonth, ...finalizeBucket(monthToDate) },
    byDay: toRows(byDay, 'day').sort((left, right) => left.day.localeCompare(right.day)),
    byModel: toRows(byModel, 'model').sort((left, right) => right.costUsd - left.costUsd),
    byProject: toRows(byProject, 'project').sort((left, right) => right.costUsd - left.costUsd),
    tokenTypes: tokenTypeTotals,
    topSessions,
    sessionCount: bySession.size,
    unknownModels: [...unknownModels.entries()].map(([model, messageCount]) => ({ model, messageCount })),
    syntheticMessageCount,
  };
}
