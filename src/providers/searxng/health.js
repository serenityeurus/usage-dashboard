// SearXNG instance health check. SearXNG serves GET /healthz ("OK") on recent
// versions; older or reverse-proxied instances may not expose it, so we fall
// back to a minimal JSON search (format=json must be enabled in settings.yml,
// which OpenClaw's searxng plugin needs anyway). Both are free: self-hosted.

export async function checkSearxngHealth({ baseUrl, fetchImpl = fetch, timeoutSeconds = 5, now = () => Date.now() }) {
  if (!baseUrl) return { configured: false };
  const checkedAt = new Date(now()).toISOString();
  const attempts = [];

  async function timedGet(method, url) {
    const startedAt = now();
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: method === 'search' ? 'application/json' : 'text/plain, */*' },
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
      const bodyText = await response.text().catch(() => '');
      const latencyMs = Math.max(0, now() - startedAt);
      let ok = response.ok;
      if (ok && method === 'search') {
        try {
          ok = Array.isArray(JSON.parse(bodyText)?.results);
        } catch {
          ok = false;
        }
      }
      const attempt = {
        method, ok, httpStatus: response.status, latencyMs,
        error: ok ? null : (response.ok ? 'response was not SearXNG JSON (is format=json enabled?)' : `HTTP ${response.status}`),
      };
      attempts.push(attempt);
      return attempt;
    } catch (error) {
      const attempt = { method, ok: false, httpStatus: null, latencyMs: Math.max(0, now() - startedAt), error: error.message };
      attempts.push(attempt);
      return attempt;
    }
  }

  const healthz = await timedGet('healthz', new URL('healthz', `${baseUrl}/`));
  const result = healthz.ok ? healthz : await timedGet('search', (() => {
    const url = new URL('search', `${baseUrl}/`);
    url.searchParams.set('q', 'usage dashboard health');
    url.searchParams.set('format', 'json');
    return url;
  })());
  return {
    configured: true,
    baseUrl,
    ok: result.ok,
    method: result.method,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    error: result.ok ? null : attempts.map((attempt) => `${attempt.method}: ${attempt.error}`).join('; '),
    attempts,
    checkedAt,
  };
}
