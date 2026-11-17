# usage-dashboard

A self-hosted dashboard for usage and spend across AI and API providers. It currently tracks **Claude**, **Brave Search** and **SearXNG** (self-hosted search).
The main page starts with an **All platforms** tile (combined spend, tokens, searches and messages), followed by one tile per provider. Every tile shows **today**, **the last 7 days** and **all time**. Click a tile to open its breakdown. **Refresh** re-reads every source on the server.

- Stack: Node 22 with no runtime dependencies (`node:http` plus `node:test`) and a vanilla JS/SVG frontend.
- Runs in Docker as a non-root user with a read-only root filesystem, read-only data mounts and a healthcheck.

## Quick start

```sh
cp usage-dashboard.example.env usage-dashboard.env   # then fill in values
ln -s usage-dashboard.env .env                       # compose reads HOST_PORT/BIND_ADDRESS from .env
docker compose up -d --build
open http://127.0.0.1:8787/
```

To run without Docker: `npm start` (honours the same env vars; see `node src/server.js --help`).
To run the tests: `npm test`.

## Configuration (`usage-dashboard.env`)

| Key | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Host interface the port is published on. Use `0.0.0.0` for LAN access (there is no auth). |
| `HOST_PORT` | `8787` | Host port. |
| `ALLOWED_HOSTS` | empty | Extra `Host` names allowed to reach the server (see [Security](#security)). |
| `CLAUDE_PROJECTS_DIR` | `$HOME/.claude/projects` | Claude Code transcript root. Mounted read-only. |
| `DASHBOARD_TIME_ZONE` | `TZ`, else `America/Detroit` | IANA time zone for daily/monthly buckets and the today/7-day windows. |
| `ANTHROPIC_ADMIN_KEY` | empty | Optional Admin API key for real org usage and cost. |
| `WEB_SEARCH_PROVIDER` | `brave` | Which backend OpenClaw's `web_search` uses now (`brave` or `searxng`). Marks that tile **active** and controls the Brave probe. |
| `WEB_SEARCH_PROVIDER_HISTORY` | empty | Cutover history for calls whose result records no provider, e.g. `searxng@2026-11-17T21:00:00Z`. |
| `SEARXNG_BASE_URL` | compose: `http://host.docker.internal:8888` | SearXNG instance for the health check. Outside Docker use `http://127.0.0.1:8888`. |
| `SEARXNG_TIMEOUT_SECONDS` | `5` | Health-check timeout. |
| `BRAVE_API_KEY` | empty | Used only for the quota-header probe. |
| `BRAVE_COST_PER_1K` | `5` | USD per 1,000 Brave requests. |
| `BRAVE_MONTHLY_CREDIT_USD` | `5` | Brave's free monthly credit. |
| `BRAVE_QUOTA_MIN_INTERVAL_SECONDS` | `60` | Minimum gap between quota probes. |
| `BRAVE_PROBE_ON_STARTUP` | `true` | Set to `false` to skip the probe at container start. |
| `BRAVE_QUOTA_PROBE` | `auto` | `auto`: probe while Brave is active, otherwise only on an explicit **Probe quota** click. `true`: every refresh. `false`: never. |

Model prices live in `config/pricing.json`, in USD per million tokens. The file is mounted into the container and re-read on every refresh, so you can edit it without rebuilding.

## How each metric is derived

### Time windows and the All platforms total

Each provider returns a normalized per-day series (`timeSeries` in the adapter contract, see `src/dashboard-state.js`). The server turns it into `summary.windows` for every provider:

- `today`: the current calendar day in the dashboard time zone.
- `last7Days`: today plus the six previous calendar days.
- `allTime`: everything, including calls with no timestamp.

The **All platforms** tile (`total` in `/api/summary`, full payload at `/api/total`) adds the windows of every provider. Spend is labelled by kind, because the numbers are not the same sort of money:

| Kind | Meaning | Provider |
| --- | --- | --- |
| Actual | Billed amount | SearXNG ($0, self-hosted) |
| API-equivalent | What subscription token usage would cost at API list prices; not a bill | Claude |
| Estimated | Request count × list price, unconfirmed by the vendor, before credits | Brave |

The combined breakdown shows spend per day stacked by provider, searches per day stacked by backend (which makes the Brave → SearXNG cutover visible) and a per-provider table.

### Claude: API-equivalent cost (subscription)

- **Source:** Claude Code JSONL transcripts in `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. There is one directory per project; for OpenClaw agents that is one per agent workspace.
- **Tokens:** read from the `message.usage` field of each `type: "assistant"` line: `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`. Cache writes are split into 5-minute and 1-hour writes using `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`. If that split is missing, all writes count as 5-minute writes.
- **Dedupe:** Claude Code writes one line per content block of a streamed message. Each line repeats the same `message.id` and the same `usage`, so records are deduplicated on `message.id`, falling back to `requestId`. Deduplication also applies across files, because resumed sessions can replay messages. `api-request-blob` lines are ignored.
- **Cost:** tokens × the rate for each token type from `config/pricing.json`. Prices come from <https://platform.claude.com/docs/en/about-claude/pricing> as of 2026-11-17.
  - Haiku 5.5 switches to its long-context rates when a request's prompt tokens exceed 100k.
  - Model ids match exactly or with a `-YYYYMMDD` suffix. Unknown models are flagged in the UI and their cost is excluded rather than guessed.
  - `<synthetic>` messages (local errors and interrupts) are not counted.
- **This is not your bill.** On a subscription it shows what the same tokens would cost through the API.
- **Breakdowns:** by day (in the configured time zone), by model, by project/agent, by token type and top sessions.
  - Agent names come from the directory name: `…-openclaw-workspace-droid` → `droid`.
- **Performance:** each file's parse result is cached and keyed by `mtime:size`, so a refresh only re-reads changed files. A cold scan of about 140 MB takes about 0.6 s in the container; an incremental refresh takes about 50 ms.

### Claude: Admin API (optional)

When `ANTHROPIC_ADMIN_KEY` is set, the dashboard calls `GET /v1/organizations/usage_report/messages` (`bucket_width=1d`, `group_by[]=model`) and `GET /v1/organizations/cost_report` for the last 30 days, following `has_more`/`next_page` pagination.
Cost amounts are decimal strings in cents. Docs: <https://platform.claude.com/docs/en/manage-claude/usage-cost-api>.
This only works for Claude Console organizations, not claude.ai subscriptions. When no key is set, the view shows "Not configured".

### Web search attribution (Brave vs SearXNG)

OpenClaw's `web_search` tool can use several backends, selected by the OpenClaw config key `tools.web.search.provider`. Both providers count the same `web_search` tool calls from the transcripts, so each call is attributed to exactly one backend:

1. **Recorded provider (primary).** OpenClaw's tool result is a JSON payload with a top-level `"provider"` field (`"brave"`, `"searxng"`). The transcript scanner matches each `tool_use` with its later `tool_result` (`tool_use_id`) and keeps that field. This was verified on real transcripts: every Brave result before the switch carries `"provider": "brave"`, and the SearXNG plugin writes `"provider": "searxng"`.
2. **Cutover history (fallback).** Calls with no parseable result (errors, interrupted sessions) are attributed by time using `WEB_SEARCH_PROVIDER_HISTORY`, e.g. `searxng@2026-11-17T21:00:00Z`. Calls before the first entry, or with no history, count as Brave, because every search before v0.2 was Brave.

Brave's history and spend therefore no longer include searches that SearXNG served. Each detail view shows how many calls were attributed by each method. Calls recorded for another backend (for example DuckDuckGo) are counted by neither tile.

`WEB_SEARCH_PROVIDER` only labels the active backend and drives the Brave probe policy; it never changes attribution. The dashboard does not read `openclaw.json` (it holds secrets), so keep this env value in sync with the OpenClaw setting by hand.

### SearXNG

- **Spend:** always $0, labelled "self-hosted, free".
- **Searches:** `web_search` calls attributed to `searxng` (see above), by day, agent and month, with today/7-day/all-time windows.
- **Health:** each refresh calls `GET {SEARXNG_BASE_URL}/healthz` and records status and latency. If that fails (older instance or proxy without the route), it falls back to `GET /search?q=…&format=json` and requires a JSON `results` array. Both checks are free. An HTML response means `format=json` is not enabled in SearXNG's `settings.yml`, which OpenClaw also needs.

### Brave Search

Brave has no usage API, so this provider combines two signals:

1. **Live quota.** One minimal search (`count=1`) reads `X-RateLimit-Limit`, `-Policy`, `-Remaining` and `-Reset`.
   - These are comma-separated lists with one entry per window: per-second and monthly. A monthly limit of `0` means unlimited, which is the case on pay-as-you-go plans.
   - Docs: <https://api-dashboard.search.brave.com/documentation/guides/rate-limiting>.
   - **Each probe is a billable query.** Probes never run on page load and are throttled by `BRAVE_QUOTA_MIN_INTERVAL_SECONDS`. With `BRAVE_QUOTA_PROBE=auto` (the default) they run at startup and on Refresh only while Brave is the active provider. While SearXNG is active, they run only when you click **Probe quota now** on the Brave page (`POST /api/refresh?probe=brave`).
2. **Usage history.** The dashboard counts `web_search` tool calls (`mcp__openclaw__web_search`) attributed to Brave in the same Claude Code transcripts, deduplicated by `tool_use.id`, and breaks them down by day, agent and month.
   - OpenClaw's own session store (`~/.openclaw/agents/*/sessions`, plus SQLite under the state directory) was not used. The session directories were empty, and the SQLite databases are guarded against outside readers.

**Estimated spend** = searches × `BRAVE_COST_PER_1K` / 1000. The monthly view subtracts the `BRAVE_MONTHLY_CREDIT_USD` credit.
Pricing is $5 per 1,000 requests with $5 of free credit each month, per Brave's pricing page (<https://api-dashboard.search.brave.com/documentation/pricing>; the page renders client-side, so these figures were confirmed against its search snippet). Check them against your plan.

## Switching web search between SearXNG and Brave

The OpenClaw gateway and the dashboard are configured separately. Change both.

**Switch back to Brave:**

1. OpenClaw: set `tools.web.search.provider` to `"brave"` in `~/.openclaw/openclaw.json` (or run `openclaw configure --section web` and pick Brave), then restart or reload the gateway as you normally do.
2. Dashboard: in `usage-dashboard.env` set `WEB_SEARCH_PROVIDER=brave` and append the cutover to the history, e.g. `WEB_SEARCH_PROVIDER_HISTORY=searxng@2026-11-17T20:56:55Z,brave@<now in ISO-8601>`.
3. `docker compose up -d` (env changes need a container restart, not a rebuild).

**Switch to SearXNG:** the same steps with `"searxng"` / `WEB_SEARCH_PROVIDER=searxng`, appending `searxng@<now>` to the history. OpenClaw also needs the SearXNG URL (`plugins.entries.searxng.config.webSearch.baseUrl` or `SEARXNG_BASE_URL`); see OpenClaw's `docs/tools/searxng-search.md`.

Searches already made stay attributed by their recorded provider, so switching never rewrites history.

## Security

There is no authentication, so the server guards against browser-based attacks on a loopback service:

- **Host allowlist (DNS rebinding).** Every request must carry a `Host` header naming `localhost`, `127.0.0.1` or `[::1]` (bare or on `PORT`/`HOST_PORT`), or an `ALLOWED_HOSTS` entry. Entries without a port are allowed on those ports; entries with a port match exactly. Anything else gets `403`.
- **Origin check (CSRF).** A non-GET request (that is, `POST /api/refresh`, which can spend a Brave query) with an `Origin` header that is not an allowed host, or is `null`, gets `403`. Requests without `Origin` (curl, scripts) are allowed.
- **Malformed paths.** Bad percent-encoding (for example `/%E0%A4%A`) returns `400`; path traversal returns `403`.

If you expose the dashboard on the LAN (`BIND_ADDRESS=0.0.0.0`), add the name or IP you browse to to `ALLOWED_HOSTS`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | Liveness check. |
| GET | `/api/summary` | Cached tile summaries. Reads no sources. |
| GET | `/api/providers/:id` | Cached detail payload. |
| GET | `/api/total` | Cached All platforms roll-up: windows, spend and searches per provider per day, per-provider rows. |
| POST | `/api/refresh` | Re-reads all sources, then returns the summary. Concurrent calls share one run. `?probe=brave` also runs the paid Brave quota probe. |

`/api/summary` returns `{ refreshedAt, timeZone, total, providers[] }`. Each provider summary includes `costKind`, `active` (web search backends) and `windows: { range, metrics, today, last7Days, allTime }`.

## Adding a provider

1. Create `src/providers/<id>/index.js` that exports a factory returning `{ id, name, collect(context) }`.
2. `collect` returns `{ summary, detail, timeSeries }`. The shapes are documented in `src/dashboard-state.js`. Set `summary.costKind` and return a `timeSeries` per-day series; the server then adds today/7-day/all-time windows and includes the provider in the All platforms total. `context.getTranscripts()` gives the shared, memoized transcript scan.
3. Register the provider in `src/server.js`. To customise the breakdown, add a renderer to `DetailRenderers` in `public/app.js`; without one, the detail payload is shown as JSON.
4. Add tests under `test/` that use synthetic fixtures.

## Known limitations

- Claude cost assumes standard-tier pricing. Fast mode, batch discounts, data-residency multipliers and other non-standard pricing are not modelled.
- Only transcripts on this machine are counted. Usage from other machines, claude.ai chat or deleted transcripts is missing.
- Web search counts only include `web_search` calls that appear in Claude Code transcripts. They miss searches from other harnesses or models and the dashboard's own quota probes. With an unlimited (pay-as-you-go) plan, Brave's headers carry no usage count to cross-check against.
- Admin API support was tested against mocked responses only; it has not been exercised with a live key.
- Brave estimates count every Brave-attributed call, including any that OpenClaw answered from its in-process result cache. No Brave results seen so far were marked as cached.
- Attribution by cutover time is only as accurate as `WEB_SEARCH_PROVIDER_HISTORY`. It applies only to calls whose result records no provider.
- The active-provider badge comes from `WEB_SEARCH_PROVIDER`, not from OpenClaw's live config, so it can drift if one is changed without the other.
- The 7-day and today windows are fixed when the snapshot is taken. A page left open past midnight shows yesterday's "today" until the next Refresh.
- There is no authentication. Keep `BIND_ADDRESS=127.0.0.1` or put the dashboard behind a reverse proxy that handles auth.
