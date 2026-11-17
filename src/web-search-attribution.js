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

// Returns the calls attributed to `providerId` plus counts of how they were attributed.
export function selectCallsForProvider(webSearchCalls, providerId, options) {
  const calls = [];
  const attribution = { recorded: 0, cutover: 0, fallback: 0 };
  for (const call of webSearchCalls) {
    const { provider, attributedBy } = attributeWebSearchCall(call, options);
    if (provider !== providerId) continue;
    calls.push(call);
    attribution[attributedBy] += 1;
  }
  return { calls, attribution };
}
