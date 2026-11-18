// Decides which search backend served each OpenClaw web_search call.
//
// Primary signal (recorded): OpenClaw's web_search tool result is a JSON
// document with a top-level "provider" field ("brave", "searxng", ...). The
// transcript scanner copies it onto the call as `recordedProvider`.
//
// Fallback (cutover history): calls whose result is missing or unparseable
// (errors, interrupted sessions, truncated output) are attributed by time
// using WEB_SEARCH_PROVIDER_HISTORY, a comma-separated list of
// `<provider>@<ISO-8601 timestamp>` entries meaning "this provider was active
// from this instant". Calls before the first entry, or with no timestamp,
// go to `fallbackProvider` (brave: every search before v0.2 was Brave).

export const WebSearchProviderIds = ['brave', 'searxng'];

export function parseProviderHistory(rawValue) {
  const entries = [];
  for (const part of String(rawValue || '').split(',').map((piece) => piece.trim()).filter(Boolean)) {
    const separatorIndex = part.indexOf('@');
    if (separatorIndex < 1) throw new Error(`WEB_SEARCH_PROVIDER_HISTORY entry "${part}" must look like provider@2026-11-17T21:00:00Z`);
    const provider = part.slice(0, separatorIndex).trim().toLowerCase();
    const startText = part.slice(separatorIndex + 1).trim();
    const startMs = Date.parse(startText);
    if (!WebSearchProviderIds.includes(provider)) {
      throw new Error(`WEB_SEARCH_PROVIDER_HISTORY provider "${provider}" must be one of ${WebSearchProviderIds.join('|')}`);
    }
    if (!/\d{4}-\d{2}-\d{2}T/.test(startText) || Number.isNaN(startMs)) {
      throw new Error(`WEB_SEARCH_PROVIDER_HISTORY timestamp "${startText}" must be ISO-8601 with a time and offset`);
    }
    entries.push({ provider, startAt: new Date(startMs).toISOString(), startMs });
  }
  return entries.sort((left, right) => left.startMs - right.startMs);
}

export function attributeWebSearchCall(call, { history = [], fallbackProvider = 'brave' } = {}) {
  if (call.recordedProvider) return { provider: call.recordedProvider, attributedBy: 'recorded' };
  const callMs = call.timestamp ? Date.parse(call.timestamp) : Number.NaN;
  if (!Number.isNaN(callMs)) {
    let active = null;
    for (const entry of history) {
      if (entry.startMs <= callMs) active = entry;
      else break;
    }
    if (active) return { provider: active.provider, attributedBy: 'cutover' };
  }
  return { provider: fallbackProvider, attributedBy: 'fallback' };
}

// Which backend is active now, for the badge and the Brave auto-probe policy.
//   WEB_SEARCH_PROVIDER set   -> { id, source: 'configured' }
//   unset, some call recorded -> the provider of the latest recorded call,
//                                source 'transcripts' (a guess: never spend on it)
//   unset, nothing recorded   -> { id: null, source: 'unknown' }
// Cutover/fallback attribution is deliberately not used here: the fallback is
// "brave", which would recreate the implicit-brave default this replaces.
export function resolveActiveWebSearchProvider(configuredProvider, webSearchCalls = []) {
  if (configuredProvider) return { id: configuredProvider, source: 'configured', at: null };
  let latest = null;
  let latestMs = -Infinity;
  for (const call of webSearchCalls) {
    if (!call.recordedProvider || !call.timestamp) continue;
    const callMs = Date.parse(call.timestamp);
    if (Number.isNaN(callMs) || callMs < latestMs) continue;
    latest = call;
    latestMs = callMs;
  }
  if (!latest) return { id: null, source: 'unknown', at: null };
  return { id: latest.recordedProvider, source: 'transcripts', at: latest.timestamp };
}

export function describeActiveProvider(activeProvider) {
  if (activeProvider.source === 'configured') return `${activeProvider.id} (WEB_SEARCH_PROVIDER)`;
  if (activeProvider.source === 'transcripts') return `${activeProvider.id} (last recorded; WEB_SEARCH_PROVIDER unset)`;
  return 'unknown (WEB_SEARCH_PROVIDER unset, none recorded)';
}

// Secondary metric shown on the search tiles only when the active backend is inferred.
export function activeProviderMetrics(activeProvider) {
  if (activeProvider.source === 'configured') return [];
  return [{ label: 'Active web_search backend', value: describeActiveProvider(activeProvider) }];
}

// Returns the calls attributed to `providerId` plus counts of how they were attributed.
// `providerId` may be a predicate, e.g. to collect providers this dashboard does not model.
export function selectCallsForProvider(webSearchCalls, providerId, options) {
  const matches = typeof providerId === 'function' ? providerId : (provider) => provider === providerId;
  const calls = [];
  const attribution = { recorded: 0, cutover: 0, fallback: 0 };
  for (const call of webSearchCalls) {
    const { provider, attributedBy } = attributeWebSearchCall(call, options);
    if (!matches(provider)) continue;
    calls.push(call);
    attribution[attributedBy] += 1;
  }
  return { calls, attribution };
}
