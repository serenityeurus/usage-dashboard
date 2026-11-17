// Optional: real organization usage/cost from the Anthropic Admin API.
// Docs: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
//   GET /v1/organizations/usage_report/messages  (bucket_width=1d, group_by[]=model)
//   GET /v1/organizations/cost_report            (daily only; amount is a decimal
//                                                 string in cents, USD)
// Both paginate with has_more/next_page -> page=<token>. Only works with an
// Admin API key (sk-ant-admin01-...); claude.ai subscriptions have no Admin API.

const AnthropicApiBase = 'https://api.anthropic.com';
// Version header used in the Usage and Cost API docs examples (Nov 2026).
// Untested against a live Admin key; override with ANTHROPIC_VERSION if needed.
const AnthropicVersion = process.env.ANTHROPIC_VERSION || '2026-10-21';
const MaxPages = 20;

async function fetchAllPages({ fetchImpl, adminKey, pathName, params }) {
  const allBuckets = [];
  let pageToken = null;
  for (let pageNumber = 0; pageNumber < MaxPages; pageNumber += 1) {
    const url = new URL(pathName, AnthropicApiBase);
    for (const [key, value] of params) url.searchParams.append(key, value);
    if (pageToken) url.searchParams.set('page', pageToken);
    const response = await fetchImpl(url, {
      headers: { 'x-api-key': adminKey, 'anthropic-version': AnthropicVersion },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const bodyText = (await response.text()).slice(0, 300);
      throw new Error(`${pathName} returned HTTP ${response.status}: ${bodyText}`);
    }
    const body = await response.json();
    allBuckets.push(...(body.data || []));
    if (!body.has_more || !body.next_page) break;
    pageToken = body.next_page;
  }
  return allBuckets;
}

export function summarizeUsageBuckets(usageBuckets) {
  const byModel = new Map();
  const byDay = new Map();
  const totals = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
  for (const bucket of usageBuckets) {
    const day = String(bucket.starting_at || '').slice(0, 10);
    for (const result of bucket.results || []) {
      const cacheWriteTokens = Number(result.cache_creation?.ephemeral_5m_input_tokens || 0)
        + Number(result.cache_creation?.ephemeral_1h_input_tokens || 0);
      const row = {
        inputTokens: Number(result.uncached_input_tokens || 0),
        outputTokens: Number(result.output_tokens || 0),
        cacheWriteTokens,
        cacheReadTokens: Number(result.cache_read_input_tokens || 0),
      };
      const modelKey = result.model || 'all';
      const modelRow = byModel.get(modelKey) || { model: modelKey, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      const dayRow = byDay.get(day) || { day, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
      for (const field of Object.keys(totals)) {
        totals[field] += row[field];
        modelRow[field] += row[field];
        dayRow[field] += row[field];
      }
      byModel.set(modelKey, modelRow);
      byDay.set(day, dayRow);
    }
  }
  return {
    totals,
    byModel: [...byModel.values()],
    byDay: [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day)),
  };
}

export function summarizeCostBuckets(costBuckets) {
  let totalCents = 0;
  const byDay = new Map();
  for (const bucket of costBuckets) {
    const day = String(bucket.starting_at || '').slice(0, 10);
    for (const result of bucket.results || []) {
      const cents = Number.parseFloat(result.amount);
      if (!Number.isFinite(cents)) continue;
      totalCents += cents;
      byDay.set(day, (byDay.get(day) || 0) + cents);
    }
  }
  return {
    totalCostUsd: Math.round(totalCents) / 100,
    byDay: [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([day, cents]) => ({ day, costUsd: Math.round(cents) / 100 })),
  };
}

export async function fetchAdminUsage({ adminKey, lookbackDays = 30, fetchImpl = fetch, now = new Date() }) {
  if (!adminKey) return { configured: false };
  const startingAt = new Date(now.getTime() - lookbackDays * 86400000);
  startingAt.setUTCHours(0, 0, 0, 0);
  const startingAtIso = startingAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const [usageBuckets, costBuckets] = await Promise.all([
      fetchAllPages({
        fetchImpl, adminKey, pathName: '/v1/organizations/usage_report/messages',
        params: [['starting_at', startingAtIso], ['bucket_width', '1d'], ['group_by[]', 'model'], ['limit', '31']],
      }),
      fetchAllPages({
        fetchImpl, adminKey, pathName: '/v1/organizations/cost_report',
        params: [['starting_at', startingAtIso], ['limit', '31']],
      }),
    ]);
    return {
      configured: true,
      ok: true,
      lookbackDays,
      startingAt: startingAtIso,
      usage: summarizeUsageBuckets(usageBuckets),
      cost: summarizeCostBuckets(costBuckets),
      fetchedAt: now.toISOString(),
    };
  } catch (error) {
    return { configured: true, ok: false, error: error.message, fetchedAt: now.toISOString() };
  }
}
