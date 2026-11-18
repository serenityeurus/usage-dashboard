# usage-dashboard

A self-hosted dashboard for usage and spend across AI and API providers. It currently tracks **Claude**, **Brave Search** and **SearXNG** (self-hosted search).
The main page starts with an **All platforms** tile (combined spend, tokens, searches and messages), followed by one tile per provider. Every tile shows **today**, **the last 7 days** and **all time**. Click a tile to open its breakdown. **Refresh** re-reads every source on the server; the server also re-reads them on its own every 5 minutes (configurable), and an open tab follows along. The Claude tile shows how much of your plan's 5-hour session and weekly limits you have used: Claude Code's own **official** `/usage` percentages when the status line has captured them, otherwise an **estimate**.

- Stack: Node 22 with no runtime dependencies (`node:http` plus `node:test`) and a vanilla JS/SVG frontend.
- Runs in Docker as a non-root user with a read-only root filesystem, read-only data mounts and a healthcheck.

## Quick start

```sh
cp usage-dashboard.example.env usage-dashboard.env   # then fill in values
ln -s usage-dashboard.env .env                       # compose reads HOST_PORT/BIND_ADDRESS from .env
docker compose up -d --build
open http://127.0.0.1:8787/
```

For official Claude `/usage` figures, also install the status line once (see [Claude: official /usage](#claude-official-usage-status-line)):

```sh
mkdir -p ~/.claude/usage-dashboard                   # before the first compose up, so Docker mounts it
node scripts/install-statusline.mjs --dry-run        # then without --dry-run
```

To run without Docker: `npm start` (honours the same env vars; see `node src/server.js --help`).
To run the tests: `npm test`.

## Configuration (`usage-dashboard.env`)

| Key | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Host interface the port is published on. Use `0.0.0.0` for LAN access (there is no auth). |
| `HOST_PORT` | `8787` | Host port. |
| `ALLOWED_HOSTS` | empty | Extra `Host` names allowed to reach the server (see [Security](#security)). Entries are `host`, `host:port`, `[ipv6]` or `[ipv6]:port`; anything else (a scheme, a path, an unbracketed IPv6 address) stops startup with an error. |
| `CLAUDE_PROJECTS_DIR` | `$HOME/.claude/projects` | Claude Code transcript root. Mounted read-only. |
| `DASHBOARD_TIME_ZONE` | `TZ`, else `America/Detroit` | IANA time zone for daily/monthly buckets and the today/7-day windows. The POSIX leading colon (`TZ=:America/Detroit`) is accepted. |
| `ANTHROPIC_ADMIN_KEY` | empty | Optional Admin API key for real org usage and cost. |
| `WEB_SEARCH_PROVIDER` | unset | Which backend OpenClaw's `web_search` uses now (`brave` or `searxng`). Marks that tile **active** and controls the Brave probe. When unset, see [Active provider](#active-provider). |
| `WEB_SEARCH_PROVIDER_HISTORY` | empty | Cutover history for calls whose result records no provider, e.g. `searxng@2026-11-17T21:00:00Z`. |
| `SEARXNG_BASE_URL` | compose: `http://host.docker.internal:8888` | SearXNG instance for the health check. Outside Docker use `http://127.0.0.1:8888`. |
| `SEARXNG_TIMEOUT_SECONDS` | `5` | Health-check timeout. |
| `BRAVE_API_KEY` | empty | Used only for the quota-header probe. |
| `BRAVE_COST_PER_1K` | `5` | USD per 1,000 Brave requests. |
| `BRAVE_MONTHLY_CREDIT_USD` | `5` | Brave's free monthly credit. |
| `BRAVE_QUOTA_MIN_INTERVAL_SECONDS` | `60` | Minimum gap between quota probes. |
| `BRAVE_PROBE_ON_STARTUP` | `true` | Set to `false` to skip the probe at container start. |
| `BRAVE_QUOTA_PROBE` | `auto` | `auto`: probe while `WEB_SEARCH_PROVIDER=brave`; otherwise (another provider, or unset) only on an explicit **Probe quota** click. `true`: every startup/manual refresh. `false`: never. Auto refreshes never probe in any mode. |
| `AUTO_REFRESH_SECONDS` | `300` | Server-side refresh interval; `0` disables. Must be an integer, `0` or at least `30`; anything else stops startup with an error. See [Auto refresh](#auto-refresh). |
| `CLAUDE_QUOTA_METRIC` | `usd` | What the Claude plan-limit estimate measures: `usd` (API-equivalent cost) or `tokens` (all tokens, cache reads included). See [Claude: plan limits](#claude-plan-limits-estimate). |
| `CLAUDE_SESSION_LIMIT_USD`, `CLAUDE_WEEKLY_LIMIT_USD` | empty | Your calibrated 5-hour and weekly limits in API-equivalent USD (used when the metric is `usd`). Empty = no limit for that window. |
| `CLAUDE_SESSION_LIMIT_TOKENS`, `CLAUDE_WEEKLY_LIMIT_TOKENS` | empty | The same limits in tokens (used when the metric is `tokens`). |
| `CLAUDE_STATE_DIR` | `$HOME/.claude/usage-dashboard` | Host directory with the status line capture, mounted read-only (compose only). |
| `USAGE_DASHBOARD_STATE_FILE` | `$HOME/.claude/usage-dashboard/rate-limits.json` | Capture file written by the status line and read by the dashboard. Compose sets it to the mounted path inside the container. |
| `CLAUDE_STATUSLINE_MAX_AGE_SECONDS` | `900` | Age after which a capture is labelled **stale** (still shown, as a lower bound, until its window resets). Positive integer. |
| `CLAUDE_WEEKLY_RESET` | `rolling` | `rolling` (trailing 7 days) or a weekly reset like `mon 00:00` / `thursday 17:30`, in `DASHBOARD_TIME_ZONE`. |

Model prices live in `config/pricing.json`, in USD per million tokens. The file is mounted into the container and re-read on every refresh, so you can edit it without rebuilding.

## How each metric is derived

### Time windows and the All platforms total

Each provider returns a normalized per-day series (`timeSeries` in the adapter contract, see `src/dashboard-state.js`). The server turns it into `summary.windows` for every provider:

- `today`: the current calendar day in the dashboard time zone.
- `last7Days`: today plus the six previous calendar days.
- `allTime`: everything, including calls with no timestamp.

Windows and the total are recomputed from the stored per-day series on every read (`/api/summary`, `/api/total`, `/api/providers/:id`), not when the data is refreshed. "Today" therefore rolls over at local midnight without a Refresh, and a provider whose last refresh failed (its previous data is shown, marked stale) is windowed against the current day too. The page header shows the day currently used as "today". Claude's windows sum unrounded per-day cost and round once, so `allTime` matches the Claude tile's all-time cost.

The **All platforms** tile (`total` in `/api/summary`, full payload at `/api/total`) adds the windows of every provider. It never leads with one combined "total spend", because a bill and an estimate are not the same sort of money. Instead every window (today, 7 days, all time) has two headline figures:

- **Actual spend** (`actualUsd`): the sum of `actual`-kind cost, i.e. what was billed. It reads $0.00 with the hint "no billing source connected" while no provider reports a non-zero actual cost (SearXNG is actual but always $0).
- **Estimated spend** (`estimatedUsd`): `api-equivalent` + `estimated`, shown with those two sub-lines so the Claude part is clearly not a bill.

Both are computed in `src/total.js` from unrounded sums and rounded once. `costUsd` (all three kinds added) and `costByKind` remain in the payload for backward compatibility, but the UI does not show `costUsd` as a headline. The kinds:

| Kind | Meaning | Provider |
| --- | --- | --- |
| Actual | Billed amount | SearXNG ($0, self-hosted) |
| API-equivalent | What subscription token usage would cost at API list prices; not a bill | Claude |
| Estimated | Request count × list price, unconfirmed by the vendor, before credits | Brave |

The combined breakdown shows spend per day stacked by provider (each legend entry names the provider's kind; the bars are estimated or API-equivalent unless marked Actual; per-day costs are summed unrounded and rounded once), searches per day stacked by backend (which makes the Brave → SearXNG cutover visible) and a per-provider table.

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

### Claude: official /usage (status line)

Claude Code passes its [status line command](https://code.claude.com/docs/en/statusline) a JSON blob whose `rate_limits` object holds the numbers `/usage` shows: `five_hour` and `seven_day`, each with `used_percentage` (0–100) and `resets_at` (Unix seconds), plus `spend_limit` behind a Claude apps gateway. `scripts/claude-statusline.mjs` is such a command: it saves `rate_limits` and prints a compact line like `Opus 5.5 · 5h 34% (resets 13:00) · wk 41% (Fri 19:00)`.

- **Install:** `node scripts/install-statusline.mjs` adds `statusLine` to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), keeping every other key, after copying the file to `~/backups/settings-claude-<timestamp>.json`. `--dry-run` shows the key diff only; `--uninstall` removes it. An existing, different status line is left alone unless you pass `--force`: then it is kept in the backup and in `statusline-chain.json` next to the capture, the script runs it with the same stdin and prints *its* output (so your status line looks unchanged), and `--uninstall` restores it. `USAGE_DASHBOARD_STATUSLINE_CHAIN=<command>` in Claude Code's environment does the same by hand. The command uses absolute paths to the current `node` and the script, since Claude Code's shell may not have nvm on `PATH`; re-run the installer after changing Node versions or moving the repo.
- **What is stored:** `~/.claude/usage-dashboard/rate-limits.json` = `{ capturedAt, sessionId, model { id, displayName }, rate_limits }`, written atomically (temp file + rename, mode 0600). Every window key under `rate_limits` is copied generically (only scalar fields), so a future per-model window shows up without a code change; the docs currently list only `five_hour`, `seven_day` and `spend_limit`. Nothing else from stdin (transcript path, cwd, workspace, cost) is written. An update without `rate_limits` never overwrites an earlier capture.
- **When it refreshes:** only while an **interactive** Claude Code session is running and receiving responses (`rate_limits` appears after a session's first API response, for Pro/Max/Ultra plans). `claude -p` runs, including OpenClaw's claude-cli agent runs, do not run the status line, although they use the same quota. So a capture can lag real usage; it never runs ahead of it.
- **Dashboard rule, per window:** if the capture has the window and its `resets_at` is in the future, the tile shows the official % with an **official** badge, the reset time and the capture age (source "Claude Code /usage (status line, captured 4 min ago)"). After `CLAUDE_STATUSLINE_MAX_AGE_SECONDS` the badge becomes **official · stale** and the text "as of <time>, at least this much". The capture is *not* discarded for the estimate when stale: usage within a window only grows, so an old reading before `resets_at` is still a true lower bound, which is more than the estimate can claim. Once `resets_at` passes, or when a window is missing or the file is absent/invalid, that window falls back to the estimate (below).
- **Blocked until:** when Claude Code hits a usage limit it writes a 429 line to the transcript (`apiError: "usage_limit_reached"`, `apiErrorParams.rate_limit_info { status: "rejected", resetsAt, rateLimitType }`). The newest such rejection whose `resetsAt` is still ahead, with no successful API response after it, shows as "Rate-limited (five hour limit): blocked until …" on the tile and as a warning. This works without the status line.
- **Performance:** the script does no network and one small sync write; a run takes about 3 ms more than Node's own startup (median 78 ms vs 74 ms for `node -e 0` on an M-series Mac with Node 26), well inside Claude Code's 300 ms update debounce. It never throws and always exits 0 with a line, even on garbage stdin or an unwritable state path.
- **Docker:** compose mounts the *directory* `CLAUDE_STATE_DIR` read-only at `/data/claude-state`. A single-file bind mount would not see the atomic rename. Create the directory before the first `docker compose up` (the installer does), or Docker creates it for you.
- **API:** each window in `claude.quota` gains `source` (`official` or `estimate`), `sourceLabel` and `official { usedPercent, resetsAt, capturedAt, ageSeconds, stale }` (or `null`); the v0.3 estimate fields stay as they were. `quota.official` describes the capture (`status: ok|missing|invalid`, `capturedAt`, `ageSeconds`, `stale`, `expiredWindows`), `quota.extraWindows` lists other windows (e.g. `spend_limit`), and `quota.block` is `{ until, since, rateLimitType }` or `null`. `quota.estimate` is now true only while some window still shows an estimate.

### Claude: plan limits (estimate)

Claude subscriptions have a rolling **5-hour session limit** and a **weekly limit**, but Anthropic publishes no token or dollar figures for them. For any window without an unexpired [status line capture](#claude-official-usage-status-line), the dashboard *estimates* usage against limits you supply and labels it "estimate".

- **What is measured:** the same deduplicated transcript records as the cost figures. `CLAUDE_QUOTA_METRIC=usd` (the default) sums API-equivalent cost; `tokens` sums all tokens. USD is the default because cache reads dominate raw token counts while costing a tenth of the input rate, so a token limit swings with cache behaviour. Unpriced models count tokens but no USD.
- **Session window:** a window opens at the first message after the previous window expired and lasts 5 hours; the start is floored to the hour, matching the on-the-hour reset times Claude shows. It is a block, not a trailing 5 hours: steady use from 10:10 to 16:00 is two windows (10:00–15:00 and 15:00–20:00). When the latest window has expired, the session shows 0 and "the next message starts one". The tile shows the reset time.
- **Weekly window:** `CLAUDE_WEEKLY_RESET=rolling` counts the trailing 7 days and shows when the oldest counted usage ages out. `mon 00:00` (any weekday, `HH:MM`) counts from the most recent such wall time in `DASHBOARD_TIME_ZONE` and shows the next reset; weeks spanning a DST change are 167 or 169 hours.
- **Percent** = used ÷ limit. Bars cap at 100% visually; above that the figure is shown in red with ">100%" and a tile warning. A window with no limit shows usage only. With no limit set for the chosen metric the section reads "Not configured" and says which keys to set, but still shows current usage so you can calibrate.
- **Calibration:** run `/usage` in Claude Code. If it shows the session at P% while the dashboard shows U used in the current window, set `CLAUDE_SESSION_LIMIT_USD` to U ÷ (P/100); repeat for the weekly figure, then `docker compose up -d`. Re-check now and then: limits vary by plan and model mix, and usage from claude.ai or other machines is invisible here but counts toward the real limit, so the estimate reads low when you use those.
- **API:** `/api/summary` carries it as `quota` on the `claude` provider (`configured`, `metric`, `session { active, startAt, resetAt, used { usd, tokens, messages }, limit, percent, overLimit }`, `weekly { mode, startAt, resetAt, nextDropAt, … }`); `/api/providers/claude` adds `recentBlocks`, the last 10 session windows, also listed on the Claude page. Like other refresh-time figures it updates on the next refresh (auto, every 5 minutes by default).

### Claude: Admin API (optional)

When `ANTHROPIC_ADMIN_KEY` is set, the dashboard calls `GET /v1/organizations/usage_report/messages` (`bucket_width=1d`, `group_by[]=model`) and `GET /v1/organizations/cost_report` for the last 30 days, following `has_more`/`next_page` pagination.
Cost amounts are decimal strings in cents. Docs: <https://platform.claude.com/docs/en/manage-claude/usage-cost-api>.
This only works for Claude Console organizations, not claude.ai subscriptions. When no key is set, the view shows "Not configured".

### Web search attribution (Brave vs SearXNG)

OpenClaw's `web_search` tool can use several backends, selected by the OpenClaw config key `tools.web.search.provider`. Both providers count the same `web_search` tool calls from the transcripts, so each call is attributed to exactly one backend:

1. **Recorded provider (primary).** OpenClaw's tool result is a JSON payload with a top-level `"provider"` field (`"brave"`, `"searxng"`). The transcript scanner matches each `tool_use` with its later `tool_result` (`tool_use_id`) and keeps that field. This was verified on real transcripts: every Brave result before the switch carries `"provider": "brave"`, and the SearXNG plugin writes `"provider": "searxng"`.
2. **Cutover history (fallback).** Calls with no parseable result (errors, interrupted sessions) are attributed by time using `WEB_SEARCH_PROVIDER_HISTORY`, e.g. `searxng@2026-11-17T21:00:00Z`. Calls before the first entry, or with no history, count as Brave, because every search before v0.2 was Brave.

Brave's history and spend therefore no longer include searches that SearXNG served. Each detail view shows how many calls were attributed by each method. Calls recorded for a backend this dashboard does not model (for example `"perplexity"`) are counted under **Other web search** (`other-search`). They add to the total's search counts but never to spend, because their price is unknown. That tile stays hidden until such a call exists.

`WEB_SEARCH_PROVIDER` only labels the active backend and drives the Brave probe policy; it never changes attribution. The dashboard does not read `openclaw.json` (it holds secrets), so keep this env value in sync with the OpenClaw setting by hand.

#### Active provider

- **`WEB_SEARCH_PROVIDER` set:** that tile gets the **active** badge. With `BRAVE_QUOTA_PROBE=auto`, Brave is probed on startup and Refresh only when it is `brave`.
- **Unset:** the badge goes to the backend of the most recent `web_search` call whose result recorded a provider, shown as **active?** with a tooltip. The search tiles also show an "Active web_search backend" line, e.g. `searxng (last recorded; WEB_SEARCH_PROVIDER unset)`. With no recorded call it reads `unknown`. Because this is inferred, `BRAVE_QUOTA_PROBE=auto` never probes; only an explicit **Probe quota now** click does (`BRAVE_QUOTA_PROBE=true` still probes every refresh). Earlier versions defaulted the unset value to `brave`, which spent a paid query per refresh while OpenClaw was actually on SearXNG.

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

### Auto refresh

The server runs a refresh every `AUTO_REFRESH_SECONDS` (default 300; `0` turns it off), starting one interval after the startup refresh. A tick is skipped when a refresh is already running. Auto refreshes **never run the paid Brave quota probe**, whatever `BRAVE_QUOTA_PROBE` says; startup and the **Refresh** button keep their behaviour, and a manual Refresh that arrives during an auto run waits and runs its own so it can still probe. With the Admin API configured, each auto refresh also calls it (free, but it counts toward Anthropic's API rate limits).

The interval is returned as `autoRefreshSeconds` in `/api/summary`, `/api/total` and `/api/providers/:id`. The page re-fetches the current view (GET only) on the same interval, aimed just after the server's next expected refresh, shows "auto-refresh every 5 min" next to the last-updated time, pauses while the tab is hidden and catches up as soon as it is visible again. A failed background fetch keeps the current view and notes the error in the header.

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
- **Origin check (CSRF).** A non-GET request (that is, `POST /api/refresh`, which can spend a Brave query) with an `Origin` header that is not an allowed host, or is `null`, gets `403`. Requests without `Origin` (curl, scripts) are allowed. The Origin's effective port counts: `http://localhost` means port 80 and `https://localhost` port 443, so a page served by another local web server cannot POST to the dashboard on 8787. Behind a TLS reverse proxy on 443, list the host with its port (`ALLOWED_HOSTS=dash.lan:443`); a port-less entry only covers `PORT`/`HOST_PORT` for Origins. A port-less `Host` header (what proxies normally send) matches port-less entries and any `host:80` or `host:443` entry, since clients omit default ports.
- **Malformed paths.** Bad percent-encoding (for example `/%E0%A4%A`) returns `400`; path traversal returns `403`.

If you expose the dashboard on the LAN (`BIND_ADDRESS=0.0.0.0`), add the name or IP you browse to to `ALLOWED_HOSTS`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET, HEAD | `/healthz` | Liveness check. |
| GET, HEAD | `/api/summary` | Cached tile summaries. Reads no sources. |
| GET, HEAD | `/api/providers/:id` | Cached detail payload. |
| GET, HEAD | `/api/total` | Cached All platforms roll-up: windows, spend and searches per provider per day, per-provider rows. |
| POST | `/api/refresh` | Re-reads all sources, then returns the summary. Concurrent calls share one run (but never join an auto run). `?probe=brave` also runs the paid Brave quota probe. |

HEAD is answered wherever GET is (same status and headers, no body), as for the static files. Any other method on a known route, including `OPTIONS`, gets `405` with an `Allow` header; there is no CORS, so there is nothing for a preflight to negotiate. Unknown `/api/` paths get `404`.

`/api/summary` returns `{ refreshedAt, refreshReason ('startup' | 'refresh' | 'auto'), autoRefreshSeconds, timeZone, range: { today, weekStart }, total, providers[] }`. Each provider summary includes `costKind`, `active` (web search backends) and `windows: { range, metrics, today, last7Days, allTime }`.

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
- The active-provider badge comes from `WEB_SEARCH_PROVIDER`, not from OpenClaw's live config, so it can drift if one is changed without the other. When unset, it is only as current as the last recorded search.
- Windows roll over at midnight on the next API read; an open page re-fetches every `AUTO_REFRESH_SECONDS` (not at all when it is `0`). Month-to-date figures (e.g. "Searches 2026-11") and the Claude plan-limit estimate are fixed at refresh time.
- Official Claude percentages are only as fresh as the last interactive Claude Code session (see [above](#claude-official-usage-status-line)); with several sessions open the last one to update wins, which is fine because they share one account. `capturedAt` is when the status line last ran, which can be slightly later than the API response that produced the numbers.
- Claude plan-limit estimates are against limits you calibrate yourself. The window rules (block start floored to the hour, 5-hour length) follow Claude's described behaviour and its on-the-hour reset times, not a published algorithm; Anthropic can change them.
- There is no authentication. Keep `BIND_ADDRESS=127.0.0.1` or put the dashboard behind a reverse proxy that handles auth.

## License

MIT. See [LICENSE](LICENSE).
