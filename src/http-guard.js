// Request guards against DNS rebinding and cross-site requests.
//
// The dashboard has no auth and binds to loopback by default. A malicious web
// page can still reach it through DNS rebinding (attacker.example resolves to
// 127.0.0.1, so the browser sends "Host: attacker.example:8787") or by POSTing
// cross-site to /api/refresh, which burns a paid Brave quota query. So we:
//   1. reject any request whose Host header is not on an allowlist, and
//   2. reject state-changing requests whose Origin header is present and does
//      not name an allowed host. A missing Origin is allowed (curl, healthchecks
//      and same-origin GETs do not always send one).
//
// Allowlist rules:
//   - An entry without a port ("localhost", "dashboard.lan") matches that host
//     bare or on any of the configured ports (PORT and HOST_PORT).
//   - An entry with a port ("dashboard.lan:443") matches exactly.
//   - Matching is case-insensitive and ignores one trailing dot.
//   - Malformed entries ("http://dash.lan", "dash.lan/", unbracketed "fe80::1")
//     throw: a silently ignored entry looks configured but locks users out.
//
// Origin vs Host: a Host header without a port is accepted (browsers omit the
// default port, and the Host check only defends against DNS rebinding). An
// Origin is different: WHATWG URL drops default ports, so "http://localhost"
// really means localhost:80, a different web origin than the dashboard. The
// Origin check therefore compares the effective port (explicit, else 80/443).
// Behind a TLS proxy on 443, list the host with its port ("dash.lan:443").

export const DefaultAllowedHosts = ['localhost', '127.0.0.1', '[::1]'];

// Splits "host", "host:port", "[v6]" or "[v6]:port". Returns null when malformed.
export function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
  let hostname;
  let portText = null;
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing < 0) return null;
    hostname = trimmed.slice(0, closing + 1);
    const rest = trimmed.slice(closing + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const parts = trimmed.split(':');
    if (parts.length > 2) return null; // bare IPv6 without brackets is not a valid Host
    [hostname, portText = null] = parts;
  }
  hostname = hostname.replace(/\.$/, '');
  if (!hostname) return null;
  if (portText != null) {
    if (!/^\d{1,5}$/.test(portText)) return null;
    const port = Number(portText);
    if (port < 1 || port > 65535) return null;
    return { hostname, port };
  }
  return { hostname, port: null };
}

export function createHostPolicy({ allowedHosts = DefaultAllowedHosts, extraHosts = [], ports = [] } = {}) {
  const portSet = new Set(ports.filter((port) => Number.isInteger(port) && port > 0).map(Number));
  const anyPortHosts = new Set();
  const exactHosts = new Set();
  for (const entry of [...allowedHosts, ...extraHosts]) {
    const parsed = parseHostHeader(String(entry));
    if (!parsed) {
      throw new Error(`ALLOWED_HOSTS entry "${entry}" is not a host name: use host, host:port, [ipv6] or [ipv6]:port, without scheme or path`);
    }
    if (parsed.port == null) anyPortHosts.add(parsed.hostname);
    else exactHosts.add(`${parsed.hostname}:${parsed.port}`);
  }

  function isAllowedHost(hostHeader) {
    const parsed = parseHostHeader(hostHeader);
    if (!parsed) return false;
    if (parsed.port != null && exactHosts.has(`${parsed.hostname}:${parsed.port}`)) return true;
    if (!anyPortHosts.has(parsed.hostname)) return false;
    return parsed.port == null || portSet.has(parsed.port);
  }

  function isAllowedOrigin(originHeader) {
    if (typeof originHeader !== 'string' || originHeader === 'null') return false;
    let originUrl;
    try {
      originUrl = new URL(originHeader);
    } catch {
      return false;
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
    // URL.hostname keeps IPv6 brackets; reuse the Host parser to normalize case and a trailing dot.
    const parsed = parseHostHeader(originUrl.hostname);
    if (!parsed) return false;
    const effectivePort = originUrl.port ? Number(originUrl.port) : (originUrl.protocol === 'https:' ? 443 : 80);
    if (exactHosts.has(`${parsed.hostname}:${effectivePort}`)) return true;
    return anyPortHosts.has(parsed.hostname) && portSet.has(effectivePort);
  }

  return {
    isAllowedHost,
    isAllowedOrigin,
    describe: () => ({ hosts: [...anyPortHosts, ...exactHosts], ports: [...portSet] }),
  };
}

// Returns null when the request may proceed, else { status, error }.
export function checkRequest(request, hostPolicy) {
  if (!hostPolicy.isAllowedHost(request.headers.host)) {
    return { status: 403, error: 'host not allowed (set ALLOWED_HOSTS to add one)' };
  }
  const isSafeMethod = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
  const origin = request.headers.origin;
  if (!isSafeMethod && origin != null && !hostPolicy.isAllowedOrigin(origin)) {
    return { status: 403, error: 'cross-origin request rejected' };
  }
  return null;
}
