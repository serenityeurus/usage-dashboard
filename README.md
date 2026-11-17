# usage-dashboard

A self-hosted dashboard for usage and spend across AI and API providers. It currently tracks **Claude** and **Brave Search**.
The main page has one tile per provider, showing totals and spend. Click a tile to open its breakdown. **Refresh** re-reads every source on the server.

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
| `CLAUDE_PROJECTS_DIR` | `$HOME/.claude/projects` | Claude Code transcript root. Mounted read-only. |
| `DASHBOARD_TIME_ZONE` | `UTC` | IANA time zone for daily and monthly buckets. |
| `ANTHROPIC_ADMIN_KEY` | empty | Optional Admin API key for real org usage and cost. |
| `BRAVE_API_KEY` | empty | Used only for the quota-header probe. |
| `BRAVE_COST_PER_1K` | `5` | USD per 1,000 Brave requests. |
| `BRAVE_MONTHLY_CREDIT_USD` | `5` | Brave's free monthly credit. |
| `BRAVE_QUOTA_MIN_INTERVAL_SECONDS` | `60` | Minimum gap between quota probes. |
| `BRAVE_PROBE_ON_STARTUP` | `true` | Set to `false` to skip the probe at container start. |

Model prices live in `config/pricing.json`, in USD per million tokens. The file is mounted into the container and re-read on every refresh, so you can edit it without rebuilding.

## How each metric is derived

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

### Brave Search

Brave has no usage API, so this provider combines two signals:

1. **Live quota.** One minimal search (`count=1`) reads `X-RateLimit-Limit`, `-Policy`, `-Remaining` and `-Reset`.
   - These are comma-separated lists with one entry per window: per-second and monthly. A monthly limit of `0` means unlimited, which is the case on pay-as-you-go plans.
   - Docs: <https://api-dashboard.search.brave.com/documentation/guides/rate-limiting>.
   - **Each probe is a billable query.** Probes only run at startup and on Refresh, never on page load, and are throttled by `BRAVE_QUOTA_MIN_INTERVAL_SECONDS`.
2. **Usage history.** The dashboard counts `web_search` tool calls (`mcp__openclaw__web_search`) in the same Claude Code transcripts, deduplicated by `tool_use.id`, and breaks them down by day, agent and month.
   - OpenClaw's own session store (`~/.openclaw/agents/*/sessions`, plus SQLite under the state directory) was not used. The session directories were empty, and the SQLite databases are guarded against outside readers.

**Estimated spend** = searches × `BRAVE_COST_PER_1K` / 1000. The monthly view subtracts the `BRAVE_MONTHLY_CREDIT_USD` credit.
Pricing is $5 per 1,000 requests with $5 of free credit each month, per Brave's pricing page (<https://api-dashboard.search.brave.com/documentation/pricing>; the page renders client-side, so these figures were confirmed against its search snippet). Check them against your plan.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | Liveness check. |
| GET | `/api/summary` | Cached tile summaries. Reads no sources. |
| GET | `/api/providers/:id` | Cached detail payload. |
| POST | `/api/refresh` | Re-reads all sources, then returns the summary. Concurrent calls share one run. |

## Adding a provider

1. Create `src/providers/<id>/index.js` that exports a factory returning `{ id, name, collect(context) }`.
2. `collect` returns `{ summary, detail }`. The `summary` shape is documented in `src/dashboard-state.js`. `context.getTranscripts()` gives the shared, memoized transcript scan.
3. Register the provider in `src/server.js`. To customise the breakdown, add a renderer to `DetailRenderers` in `public/app.js`; without one, the detail payload is shown as JSON.
4. Add tests under `test/` that use synthetic fixtures.

## Known limitations

- Claude cost assumes standard-tier pricing. Fast mode, batch discounts, data-residency multipliers and other non-standard pricing are not modelled.
- Only transcripts on this machine are counted. Usage from other machines, claude.ai chat or deleted transcripts is missing.
- Brave counts only include `web_search` calls that appear in Claude Code transcripts. They miss searches from other harnesses or models and the dashboard's own quota probes. With an unlimited (pay-as-you-go) plan, Brave's headers carry no usage count to cross-check against.
- Admin API support was tested against mocked responses only; it has not been exercised with a live key.
- There is no authentication. Keep `BIND_ADDRESS=127.0.0.1` or put the dashboard behind a reverse proxy that handles auth.
