// Brave Search quota probe. Brave has no usage API; the only live signal is the
// rate-limit headers on a real search response (docs:
// https://api-dashboard.search.brave.com/documentation/guides/rate-limiting):
//   X-RateLimit-Limit:     "1, 15000"           per-window limits (0 = unlimited)
//   X-RateLimit-Policy:    "1;w=1, 15000;w=2592000"  window sizes in seconds
//   X-RateLimit-Remaining: "1, 1000"
//   X-RateLimit-Reset:     "1, 1419704"         seconds until each window resets
// Each probe is a billable search, so callers must only probe on explicit
// refresh/startup, and we enforce a minimum interval on top of that.

const BraveSearchUrl = 'https://api.search.brave.com/res/v1/web/search';

function parseNumberList(headerValue) {
  if (headerValue == null || headerValue === '') return [];
  return String(headerValue).split(',').map((part) => Number.parseInt(part.trim(), 10));
}

function parsePolicyWindows(policyHeader) {
  if (!policyHeader) return [];
  return String(policyHeader).split(',').map((part) => {
    const windowMatch = part.match(/w=(\d+)/);
    return windowMatch ? Number.parseInt(windowMatch[1], 10) : null;
  });
}

export function parseRateLimitHeaders(getHeader, now = new Date()) {
  const limits = parseNumberList(getHeader('x-ratelimit-limit'));
  if (limits.length === 0) return null;
  const remaining = parseNumberList(getHeader('x-ratelimit-remaining'));
  const resets = parseNumberList(getHeader('x-ratelimit-reset'));
  const windows = parsePolicyWindows(getHeader('x-ratelimit-policy'));

  const windowRows = limits.map((limit, index) => {
    const resetSeconds = Number.isFinite(resets[index]) ? resets[index] : null;
    return {
      limit: Number.isFinite(limit) ? limit : null,
      unlimited: limit === 0,
      remaining: Number.isFinite(remaining[index]) ? remaining[index] : null,
      windowSeconds: windows[index] ?? null,
      resetSeconds,
      resetAt: resetSeconds == null ? null : new Date(now.getTime() + resetSeconds * 1000).toISOString(),
    };
  });

  // Without a policy header assume the documented order: [per-second, per-month].
  const byWindowSize = [...windowRows].sort((left, right) => (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0));
  const hasWindows = windowRows.every((row) => row.windowSeconds != null);
  const perSecond = hasWindows ? byWindowSize[0] : windowRows[0];
  const monthly = windowRows.length > 1 ? (hasWindows ? byWindowSize[byWindowSize.length - 1] : windowRows[windowRows.length - 1]) : null;
  const monthlyUsed = monthly && !monthly.unlimited && monthly.limit != null && monthly.remaining != null
    ? monthly.limit - monthly.remaining
    : null;

  return { windows: windowRows, perSecond, monthly, monthlyUsed };
}

export function createQuotaProbe({ apiKey, fetchImpl = fetch, minIntervalSeconds = 60 }) {
  let lastResult = apiKey ? { configured: true, probed: false } : { configured: false };
  let lastProbeAt = 0;
  let inFlight = null;

  async function probe(now = new Date()) {
    if (!apiKey) return lastResult;
    if (inFlight) return inFlight;
    if (lastProbeAt && now.getTime() - lastProbeAt < minIntervalSeconds * 1000) {
      return { ...lastResult, throttled: true };
    }
    lastProbeAt = now.getTime();
    inFlight = (async () => {
      try {
        const url = new URL(BraveSearchUrl);
        url.searchParams.set('q', 'usage dashboard quota probe');
        url.searchParams.set('count', '1');
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
          signal: AbortSignal.timeout(15000),
        });
        await response.arrayBuffer().catch(() => null); // drain body
        const quota = parseRateLimitHeaders((name) => response.headers.get(name), now);
        lastResult = {
          configured: true,
          probed: true,
          ok: response.ok,
          httpStatus: response.status,
          quota,
          probedAt: now.toISOString(),
          error: response.ok ? null : `Brave returned HTTP ${response.status}`,
        };
      } catch (error) {
        lastResult = { configured: true, probed: true, ok: false, error: error.message, probedAt: now.toISOString() };
      } finally {
        inFlight = null;
      }
      return lastResult;
    })();
    return inFlight;
  }

  return { probe, getLast: () => lastResult };
}
