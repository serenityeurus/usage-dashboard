// Vanilla JS UI: tile grid (#/) and per-provider detail (#/provider/<id>).
const appRoot = document.getElementById('app');
const refreshButton = document.getElementById('refresh-button');
const refreshedAtLabel = document.getElementById('refreshed-at');
const todayLabel = document.getElementById('today-label');
const autoRefreshLabel = document.getElementById('auto-refresh-label');

// Server-reported auto-refresh interval (AUTO_REFRESH_SECONDS); null until the
// first payload, 0 when disabled. The page re-fetches on the same interval.
let autoRefreshSeconds = null;
let lastRefreshedAt = null;
let dashboardTimeZone;
let pollTimer = null;

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integerFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const formatUsd = (value) => (value == null ? '—' : usdFormatter.format(value));
const formatInteger = (value) => (value == null ? '—' : integerFormatter.format(value));
const formatCompact = (value) => (value == null ? '—' : compactFormatter.format(value));
const formatDateTime = (isoString) => (isoString ? new Date(isoString).toLocaleString() : '—');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatMetric(metric) {
  if (metric.unit === 'usd') return formatUsd(metric.value);
  return typeof metric.value === 'number' ? formatInteger(metric.value) : escapeHtml(metric.value);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// The server recomputes windows on every read, so this follows local midnight
// even when no refresh has run since.
function setToday(range, timeZone) {
  todayLabel.textContent = range?.today ? `Today: ${range.today}${timeZone ? ` (${timeZone})` : ''}` : '';
}

function setRefreshedAt(refreshedAt, durationMs) {
  refreshedAtLabel.textContent = refreshedAt
    ? `Updated ${formatDateTime(refreshedAt)}${durationMs != null ? ` (${durationMs} ms)` : ''}`
    : 'Collecting data…';
}

function formatInterval(seconds) {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

// Every API payload carries refreshedAt, timeZone and autoRefreshSeconds.
function noteServerState(payload) {
  lastRefreshedAt = payload.refreshedAt || null;
  dashboardTimeZone = payload.timeZone || undefined;
  if (typeof payload.autoRefreshSeconds === 'number') autoRefreshSeconds = payload.autoRefreshSeconds;
  autoRefreshLabel.textContent = autoRefreshSeconds ? `· auto-refresh every ${formatInterval(autoRefreshSeconds)}` : (autoRefreshSeconds === 0 ? '· auto-refresh off' : '');
}

// Reset times are shown in the dashboard time zone, like the day windows.
function formatResetTime(isoString) {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleString('en-US', {
    timeZone: dashboardTimeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// ---------- time windows (normalized by the server for every provider) ----------
const WindowColumns = [['today', 'Today'], ['last7Days', '7 days'], ['allTime', 'All time']];
const MetricFormats = {
  costUsd: ['Spend', formatUsd],
  tokens: ['Tokens', formatCompact],
  searches: ['Searches', formatInteger],
  messages: ['Messages', formatInteger],
};
const CostKindLabels = { actual: 'Actual', 'api-equivalent': 'API-equivalent', estimated: 'Estimated' };
const EstimatedKinds = ['api-equivalent', 'estimated'];
const NoActualHint = 'no billing source connected';
const ProviderColors = { claude: '#d97757', brave: '#fb542b', searxng: '#3fa7d6', 'other-search': '#9e9e9e' };
const FallbackColors = ['#8bc34a', '#ab47bc', '#ffca28', '#26a69a', '#ec407a'];
const providerColor = (providerId, index) => ProviderColors[providerId] || FallbackColors[index % FallbackColors.length];

function windowsTable(windows, { costKind, rows } = {}) {
  if (!windows) return '';
  const metricRows = rows || (windows.metrics || []).map((metric) => {
    const [label, format] = MetricFormats[metric] || [metric, formatInteger];
    const fullLabel = metric === 'costUsd' && costKind ? `${label} (${CostKindLabels[costKind] || costKind})` : label;
    return { label: fullLabel, value: (window) => format(window?.[metric]) };
  });
  return `<table class="windows"><thead><tr><th></th>${WindowColumns.map(([, label]) => `<th class="num">${label}</th>`).join('')}</tr></thead>
    <tbody>${metricRows.map((row) => `<tr class="${row.className || ''}"><th scope="row">${escapeHtml(row.label)}</th>${WindowColumns.map(([windowId]) => `<td class="num">${row.value(windows[windowId])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function totalWindowRows() {
  return [
    // Two headlines, never one combined "total spend": a bill and an estimate
    // are not the same sort of money. costUsd stays in the payload only for
    // backward compatibility.
    { label: 'Actual spend (billed)', value: (window) => formatUsd(window?.actualUsd), className: 'strong' },
    { label: 'Estimated spend (not billed)', value: (window) => formatUsd(window?.estimatedUsd), className: 'strong' },
    ...EstimatedKinds.map((kind) => ({ label: `  ${CostKindLabels[kind]}`, value: (window) => formatUsd(window?.costByKind?.[kind]), className: 'sub' })),
    { label: 'Tokens', value: (window) => formatCompact(window?.tokens) },
    { label: 'Searches (all providers)', value: (window) => formatInteger(window?.searches) },
    { label: 'Messages', value: (window) => formatInteger(window?.messages) },
  ];
}

function activeBadge(provider) {
  if (!provider.active) return '';
  const inferred = provider.activeProvider?.source === 'transcripts';
  const title = inferred ? 'Most recently recorded web_search provider (WEB_SEARCH_PROVIDER is unset)' : 'Active web_search provider';
  return `<span class="badge" title="${title}">${inferred ? 'active?' : 'active'}</span>`;
}

function renderTotalTile(total) {
  if (!total) return '';
  const allTime = total.windows.allTime;
  return `<a class="tile tile-total" href="#/total" data-provider="total">
      <h2>${escapeHtml(total.name)} <span class="muted small">${formatInteger(total.providerCount)} providers</span></h2>
      <div class="tile-primary">
        <div><span class="big">${formatUsd(allTime.actualUsd)}</span><span class="label">Actual spend, all time${allTime.actualUsd ? ' (billed)' : ` (${NoActualHint})`}</span></div>
        <div><span class="big">${formatUsd(allTime.estimatedUsd)}</span><span class="label">Estimated spend, all time (API-equivalent ${formatUsd(allTime.costByKind?.['api-equivalent'])} + estimated ${formatUsd(allTime.costByKind?.estimated)}; not a bill)</span></div>
        <div><span class="big">${formatCompact(allTime.tokens)}</span><span class="label">Tokens</span></div>
        <div><span class="big">${formatInteger(allTime.searches)}</span><span class="label">Searches</span></div>
        <div><span class="big">${formatInteger(allTime.messages)}</span><span class="label">Messages</span></div>
      </div>
      ${windowsTable(total.windows, { rows: totalWindowRows() })}
      <span class="tile-cta">View combined breakdown →</span>
    </a>`;
}

// ---------- Claude plan-limit estimate ----------
function formatQuotaAmount(metric, value) {
  return metric === 'usd' ? formatUsd(value) : formatCompact(value);
}

function quotaBar(label, window, metric, resetText) {
  const used = window.used?.[metric];
  if (window.limit == null) {
    return `<div class="quota-row"><div class="quota-head"><span>${escapeHtml(label)}</span><span class="muted">${formatQuotaAmount(metric, used)} used · no limit set</span></div>
      <div class="quota-reset muted small">${escapeHtml(resetText)}</div></div>`;
  }
  const width = Math.min(100, Math.max(0, window.percent));
  return `<div class="quota-row${window.overLimit ? ' over' : ''}">
      <div class="quota-head"><span>${escapeHtml(label)}</span><span><strong>${window.overLimit ? '>100% ' : ''}${window.percent.toFixed(1)}%</strong>
        <span class="muted">${formatQuotaAmount(metric, used)} / ${formatQuotaAmount(metric, window.limit)}</span></span></div>
      <div class="quota-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}"><div class="quota-fill" style="width:${width}%"></div></div>
      <div class="quota-reset muted small">${escapeHtml(resetText)}${window.overLimit ? ' · over the configured limit: recalibrate?' : ''}</div>
    </div>`;
}

function sessionResetText(session) {
  if (!session.active) return `No active ${session.windowHours}-hour window; the next message starts one`;
  if (Date.parse(session.resetAt) <= Date.now()) return 'Window ended; updates on the next refresh';
  return `Resets ${formatResetTime(session.resetAt)} (window opened ${formatResetTime(session.startAt)})`;
}

function weeklyResetText(weekly) {
  if (weekly.mode === 'fixed') return `Resets ${formatResetTime(weekly.resetAt)} (weekly, ${weekly.label})`;
  return `Rolling 7 days${weekly.nextDropAt ? `; oldest counted usage ages out ${formatResetTime(weekly.nextDropAt)}` : ''}`;
}

function renderQuota(quota) {
  if (!quota) return '';
  const metricLabel = quota.metric === 'usd' ? 'API-equivalent USD' : 'tokens';
  const heading = `<div class="quota-title">Plan limits <span class="badge badge-estimate" title="${escapeHtml(quota.calibrationNote)}">estimate</span> <span class="muted small">by ${metricLabel}</span></div>`;
  if (!quota.configured) {
    return `<div class="quota">${heading}
      <p class="muted small">Not configured. ${escapeHtml(quota.howToConfigure)}</p>
      <p class="muted small">Now: ${formatQuotaAmount(quota.metric, quota.session.used[quota.metric])} in the current 5-hour window, ${formatQuotaAmount(quota.metric, quota.weekly.used[quota.metric])} this week (${escapeHtml(quota.weekly.label)}).</p></div>`;
  }
  return `<div class="quota">${heading}
      ${quotaBar(`Session (${quota.session.windowHours} h)`, quota.session, quota.metric, sessionResetText(quota.session))}
      ${quotaBar('Weekly', quota.weekly, quota.metric, weeklyResetText(quota.weekly))}
      <p class="muted small">Calibrate against Claude Code's /usage and adjust the limits.</p>
    </div>`;
}

// ---------- tiles ----------
function renderTiles(summary) {
  noteServerState(summary);
  setRefreshedAt(summary.refreshedAt, summary.durationMs);
  setToday(summary.range, summary.timeZone);
  if (!summary.providers.length) {
    appRoot.innerHTML = '<p class="muted">Collecting data… this page will update shortly.</p>';
    setTimeout(route, 1500);
    return;
  }
  appRoot.innerHTML = `${renderTotalTile(summary.total)}<section class="tile-grid">${summary.providers.filter((provider) => !provider.hidden).map((provider) => `
    <a class="tile${provider.active ? ' tile-active' : ''}" href="#/provider/${escapeHtml(provider.id)}" data-provider="${escapeHtml(provider.id)}">
      <h2>${escapeHtml(provider.name)} ${activeBadge(provider)}</h2>
      ${provider.ok === false ? `<p class="error">Error: ${escapeHtml(provider.error)}${provider.stale ? ' (showing last good data)' : ''}</p>` : ''}
      <div class="tile-primary">
        <div><span class="big">${formatUsd(provider.costUsd)}</span><span class="label">${escapeHtml(provider.costLabel)}</span></div>
        ${provider.primaryMetric ? `<div><span class="big">${formatCompact(provider.primaryMetric.value)}</span><span class="label">${escapeHtml(provider.primaryMetric.label)}</span></div>` : ''}
      </div>
      ${windowsTable(provider.windows, { costKind: provider.costKind })}
      ${provider.id === 'claude' ? renderQuota(provider.quota) : ''}
      <dl class="tile-secondary">${(provider.secondaryMetrics || []).map((metric) => `
        <div><dt>${escapeHtml(metric.label)}</dt><dd>${formatMetric(metric)}</dd></div>`).join('')}
      </dl>
      ${(provider.warnings || []).map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join('')}
      <span class="tile-cta">View breakdown →</span>
    </a>`).join('')}
  </section>`;
}

// ---------- shared detail widgets ----------
// Inserts zero rows for missing YYYY-MM-DD days so gaps are visible in charts.
function fillMissingDays(rows, valueKey) {
  const datedRows = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
  if (datedRows.length < 2) return datedRows;
  const rowsByDay = new Map(datedRows.map((row) => [row.day, row]));
  const filledRows = [];
  const cursor = new Date(`${datedRows[0].day}T00:00:00Z`);
  const lastDay = datedRows[datedRows.length - 1].day;
  for (let guard = 0; guard < 3660; guard += 1) {
    const day = cursor.toISOString().slice(0, 10);
    filledRows.push(rowsByDay.get(day) || { day, [valueKey]: 0 });
    if (day === lastDay) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filledRows;
}

function barChart(inputRows, { valueKey, labelKey = 'day', format = formatInteger, title }) {
  const rows = labelKey === 'day' ? fillMissingDays(inputRows, valueKey) : inputRows;
  if (!rows.length) return '<p class="muted">No data.</p>';
  const chartWidth = 900;
  const chartHeight = 220;
  const paddingBottom = 40;
  const paddingLeft = 8;
  const maxValue = Math.max(...rows.map((row) => row[valueKey] || 0)) || 1;
  const slotWidth = (chartWidth - paddingLeft) / rows.length;
  const barWidth = Math.min(48, Math.max(2, slotWidth * 0.75));
  const labelEvery = Math.ceil(rows.length / 12);
  const bars = rows.map((row, index) => {
    const barHeight = ((row[valueKey] || 0) / maxValue) * (chartHeight - paddingBottom - 10);
    const barX = paddingLeft + index * slotWidth + (slotWidth - barWidth) / 2;
    const barY = chartHeight - paddingBottom - barHeight;
    const label = escapeHtml(row[labelKey]);
    const tickLabel = index % labelEvery === 0
      ? `<text x="${barX + barWidth / 2}" y="${chartHeight - paddingBottom + 14}" text-anchor="middle" class="axis">${label.slice(5)}</text>` : '';
    return `<rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" class="bar"><title>${label}: ${escapeHtml(format(row[valueKey]))}</title></rect>${tickLabel}`;
  }).join('');
  return `<figure class="chart"><figcaption>${escapeHtml(title)} — peak ${escapeHtml(format(maxValue))}</figcaption>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="${escapeHtml(title)}">${bars}</svg></figure>`;
}

// One bar per day, one stacked segment per series (provider).
function stackedBarChart(inputRows, { series, valueOf, format = formatInteger, title }) {
  const rows = fillMissingDays(inputRows, '__none');
  if (!rows.length) return '<p class="muted">No data.</p>';
  const chartWidth = 900;
  const chartHeight = 240;
  const paddingBottom = 40;
  const paddingLeft = 8;
  const totals = rows.map((row) => series.reduce((sum, item) => sum + (valueOf(row, item.id) || 0), 0));
  const maxValue = Math.max(...totals) || 1;
  const slotWidth = (chartWidth - paddingLeft) / rows.length;
  const barWidth = Math.min(48, Math.max(2, slotWidth * 0.75));
  const labelEvery = Math.ceil(rows.length / 12);
  const plotHeight = chartHeight - paddingBottom - 10;
  const bars = rows.map((row, index) => {
    const barX = paddingLeft + index * slotWidth + (slotWidth - barWidth) / 2;
    let stackTop = chartHeight - paddingBottom;
    const segments = series.map((item) => {
      const value = valueOf(row, item.id) || 0;
      if (!value) return '';
      const segmentHeight = (value / maxValue) * plotHeight;
      stackTop -= segmentHeight;
      return `<rect x="${barX}" y="${stackTop}" width="${barWidth}" height="${segmentHeight}" fill="${item.color}"><title>${escapeHtml(row.day)} ${escapeHtml(item.name)}: ${escapeHtml(format(value))}</title></rect>`;
    }).join('');
    const tickLabel = index % labelEvery === 0
      ? `<text x="${barX + barWidth / 2}" y="${chartHeight - paddingBottom + 14}" text-anchor="middle" class="axis">${escapeHtml(row.day.slice(5))}</text>` : '';
    return `<g><title>${escapeHtml(row.day)}: ${escapeHtml(format(totals[index]))}</title>${segments}</g>${tickLabel}`;
  }).join('');
  const legend = series.map((item) => `<span class="legend-item"><span class="swatch" style="background:${item.color}"></span>${escapeHtml(item.name)}</span>`).join('');
  return `<figure class="chart"><figcaption>${escapeHtml(title)} — peak ${escapeHtml(format(maxValue))} <span class="legend">${legend}</span></figcaption>
    <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="${escapeHtml(title)}">${bars}</svg></figure>`;
}

function dataTable(columns, rows) {
  if (!rows.length) return '<p class="muted">No data.</p>';
  return `<div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th class="${column.numeric ? 'num' : ''}">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${columns.map((column) => {
      const value = column.render ? column.render(row) : escapeHtml(row[column.key]);
      return `<td class="${column.numeric ? 'num' : ''}">${value}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function statCards(cards) {
  return `<div class="stat-cards">${cards.map((card) => `<div class="stat"><span class="big">${card.value}</span><span class="label">${escapeHtml(card.label)}</span></div>`).join('')}</div>`;
}

// ---------- provider detail views ----------
const tokenColumns = [
  { label: 'Messages', key: 'messageCount', numeric: true, render: (row) => formatInteger(row.messageCount) },
  { label: 'Input', numeric: true, render: (row) => formatCompact(row.inputTokens) },
  { label: 'Output', numeric: true, render: (row) => formatCompact(row.outputTokens) },
  { label: 'Cache write', numeric: true, render: (row) => formatCompact(row.cacheWriteTokens) },
  { label: 'Cache read', numeric: true, render: (row) => formatCompact(row.cacheReadTokens) },
  { label: 'API-equiv. cost', numeric: true, render: (row) => formatUsd(row.costUsd) + (row.unknownCostMessageCount ? ' *' : '') },
];

function renderClaudeDetail(detail) {
  const admin = detail.adminApi || {};
  let adminSection;
  if (!admin.configured) {
    adminSection = '<p class="muted">Not configured. Set <code>ANTHROPIC_ADMIN_KEY</code> (an Admin API key, Console organizations only) to show real billed org usage and cost.</p>';
  } else if (!admin.ok) {
    adminSection = `<p class="error">Admin API error: ${escapeHtml(admin.error || 'not fetched yet')}</p>`;
  } else {
    adminSection = statCards([
      { label: `Billed cost, last ${admin.lookbackDays} days`, value: formatUsd(admin.cost.totalCostUsd) },
      { label: 'Input tokens', value: formatCompact(admin.usage.totals.inputTokens) },
      { label: 'Output tokens', value: formatCompact(admin.usage.totals.outputTokens) },
    ]) + barChart(admin.cost.byDay, { valueKey: 'costUsd', format: formatUsd, title: 'Billed cost per day' });
  }

  const tokenTypeRows = Object.entries(detail.tokenTypes).map(([tokenType, row]) => ({ tokenType, ...row }));
  const quota = detail.quota;
  const quotaSection = quota ? `
    <h3>Plan limits (estimate)</h3>
    <p class="note">${escapeHtml(quota.calibrationNote)} Session windows open at the first message after the previous
      ${quota.session.windowHours}-hour window expired (start floored to the hour) and last ${quota.session.windowHours} hours.</p>
    ${renderQuota(quota)}
    <h3>Recent session windows</h3>
    ${dataTable([
    { label: 'Window', render: (row) => `${escapeHtml(formatResetTime(row.startAt))} → ${escapeHtml(formatResetTime(row.resetAt))}${row.active ? ' <span class="badge">current</span>' : ''}` },
    { label: 'Messages', numeric: true, render: (row) => formatInteger(row.used.messages) },
    { label: 'Tokens', numeric: true, render: (row) => formatCompact(row.used.tokens) },
    { label: 'API-equiv. cost', numeric: true, render: (row) => formatUsd(row.used.usd) + (row.used.unpricedMessages ? ' *' : '') },
    { label: 'Of session limit', numeric: true, render: (row) => (row.percent == null ? '—' : `${row.percent.toFixed(1)}%`) },
  ], quota.recentBlocks || [])}` : '';
  return `
    <p class="note"><strong>${escapeHtml(detail.costLabel)}.</strong> ${escapeHtml(detail.costNote)}</p>
    ${statCards([
      { label: 'API-equivalent cost (all time)', value: formatUsd(detail.totals.costUsd) },
      { label: `Cost ${detail.monthToDate.month}`, value: formatUsd(detail.monthToDate.costUsd) },
      { label: 'Total tokens', value: formatCompact(detail.totals.totalTokens) },
      { label: 'API messages', value: formatInteger(detail.totals.messageCount) },
      { label: 'Sessions', value: formatInteger(detail.sessionCount) },
    ])}
    ${detail.unknownModels.length ? `<p class="warning">* Models missing from config/pricing.json (cost excluded): ${detail.unknownModels.map((row) => `${escapeHtml(row.model)} (${row.messageCount})`).join(', ')}</p>` : ''}
    ${quotaSection}
    <h3>By day</h3>
    ${barChart(detail.byDay, { valueKey: 'costUsd', format: formatUsd, title: 'API-equivalent cost per day' })}
    ${barChart(detail.byDay, { valueKey: 'totalTokens', format: formatCompact, title: 'Tokens per day' })}
    <h3>By model</h3>
    ${dataTable([{ label: 'Model', key: 'model' }, ...tokenColumns], detail.byModel)}
    <h3>By project / agent</h3>
    ${dataTable([{ label: 'Project', key: 'project' }, ...tokenColumns], detail.byProject)}
    <h3>Token type split</h3>
    ${dataTable([
    { label: 'Token type', key: 'tokenType' },
    { label: 'Tokens', numeric: true, render: (row) => formatInteger(row.tokens) },
    { label: 'Share of tokens', numeric: true, render: (row) => (detail.totals.totalTokens ? `${((row.tokens / detail.totals.totalTokens) * 100).toFixed(1)}%` : '—') },
    { label: 'API-equiv. cost', numeric: true, render: (row) => formatUsd(row.costUsd) },
  ], tokenTypeRows)}
    <h3>Top sessions</h3>
    ${dataTable([
    { label: 'Session', render: (row) => `<code>${escapeHtml(row.sessionId.slice(0, 8))}</code>` },
    { label: 'Project', key: 'project' },
    { label: 'Models', render: (row) => escapeHtml(row.models.join(', ')) },
    { label: 'Last activity', render: (row) => escapeHtml(formatDateTime(row.lastAt)) },
    { label: 'Messages', numeric: true, render: (row) => formatInteger(row.messageCount) },
    { label: 'Tokens', numeric: true, render: (row) => formatCompact(row.totalTokens) },
    { label: 'API-equiv. cost', numeric: true, render: (row) => formatUsd(row.costUsd) },
  ], detail.topSessions)}
    <h3>Anthropic Admin API (real org usage)</h3>
    ${adminSection}
    ${scanFooter(detail.scan)}`;
}

function renderBraveDetail(detail) {
  const quota = detail.quota || {};
  let quotaSection;
  if (!quota.configured) {
    quotaSection = '<p class="muted">Not configured. Set <code>BRAVE_API_KEY</code> to read live quota headers.</p>';
  } else if (!quota.probed) {
    quotaSection = '<p class="muted">Not probed yet. Press Refresh (uses one search query).</p>';
  } else if (!quota.quota) {
    quotaSection = `<p class="error">${escapeHtml(quota.error || 'No rate-limit headers in response')}</p>`;
  } else {
    const monthly = quota.quota.monthly;
    quotaSection = statCards([
      { label: 'Monthly quota', value: monthly ? (monthly.unlimited ? 'unlimited' : formatInteger(monthly.limit)) : '—' },
      { label: 'Remaining this window', value: monthly && !monthly.unlimited ? formatInteger(monthly.remaining) : '—' },
      { label: 'Used this window (per Brave)', value: formatInteger(quota.quota.monthlyUsed) },
      { label: 'Window resets', value: escapeHtml(monthly?.resetAt ? formatDateTime(monthly.resetAt) : '—') },
      { label: 'Rate limit (req/s)', value: formatInteger(quota.quota.perSecond?.limit) },
    ]) + `<p class="muted">Probed ${escapeHtml(formatDateTime(quota.probedAt))}${quota.throttled ? ' (cached; probes are rate-limited)' : ''}. HTTP ${escapeHtml(quota.httpStatus)}.</p>`;
  }
  const probeInfo = detail.quotaProbe || {};
  const probeControls = quota.configured && probeInfo.mode !== 'false'
    ? `<p class="muted small">Probe mode <code>${escapeHtml(probeInfo.mode)}</code>; this refresh: ${probeInfo.ranThisRefresh ? 'probed' : 'skipped'} (${escapeHtml(probeInfo.reason)}).
       <button type="button" class="secondary" data-probe="brave">Probe quota now (uses 1 paid query)</button></p>`
    : `<p class="muted small">Quota probe disabled (${escapeHtml(probeInfo.reason || 'no key')}).</p>`;
  return `
    <p class="note"><strong>${escapeHtml(detail.costLabel)}.</strong> ${escapeHtml(detail.costNote)}</p>
    ${statCards([
    { label: 'Searches (all time, from transcripts)', value: formatInteger(detail.totalCount) },
    { label: 'Estimated gross spend (all time)', value: formatUsd(detail.totalGrossUsd) },
    { label: `Searches ${detail.monthToDate.month}`, value: formatInteger(detail.monthToDate.count) },
    { label: `Est. billed ${detail.monthToDate.month} (after $${detail.pricing.monthlyCreditUsd} credit)`, value: formatUsd(detail.monthToDate.netUsd) },
  ])}
    ${attributionNote(detail)}
    <h3>Live quota (Brave rate-limit headers)</h3>
    ${quotaSection}
    ${probeControls}
    <h3>By day</h3>
    ${barChart(detail.byDay, { valueKey: 'count', title: 'Searches per day' })}
    <h3>By agent</h3>
    ${dataTable([
    { label: 'Agent', key: 'agent' },
    { label: 'Searches', numeric: true, render: (row) => formatInteger(row.count) },
    { label: 'Est. spend', numeric: true, render: (row) => formatUsd(row.estimatedUsd) },
  ], detail.byAgent)}
    <h3>By month</h3>
    ${dataTable([
    { label: 'Month', key: 'month' },
    { label: 'Searches', numeric: true, render: (row) => formatInteger(row.count) },
    { label: 'Gross', numeric: true, render: (row) => formatUsd(row.grossUsd) },
    { label: 'After credit', numeric: true, render: (row) => formatUsd(row.netUsd) },
  ], detail.byMonth)}
    ${scanFooter(detail.scan)}`;
}

function attributionNote(detail) {
  const attribution = detail.attribution;
  if (!attribution) return '';
  return `<p class="muted small">Attribution: ${formatInteger(attribution.recorded)} calls by the provider recorded in the tool result,
    ${formatInteger(attribution.cutover)} by WEB_SEARCH_PROVIDER_HISTORY cutover time, ${formatInteger(attribution.fallback)} by fallback (pre-history calls default to Brave).</p>`;
}

function searchBreakdown(detail, { showSpend }) {
  const spendColumn = showSpend ? [{ label: 'Est. spend', numeric: true, render: (row) => formatUsd(row.estimatedUsd) }] : [];
  return `
    <h3>By day</h3>
    ${barChart(detail.byDay, { valueKey: 'count', title: 'Searches per day' })}
    <h3>By agent</h3>
    ${dataTable([{ label: 'Agent', key: 'agent' }, { label: 'Searches', numeric: true, render: (row) => formatInteger(row.count) }, ...spendColumn], detail.byAgent)}
    <h3>By month</h3>
    ${dataTable([{ label: 'Month', key: 'month' }, { label: 'Searches', numeric: true, render: (row) => formatInteger(row.count) }], detail.byMonth)}`;
}

function renderSearxngDetail(detail) {
  const health = detail.health || {};
  let healthSection;
  if (!health.configured) {
    healthSection = '<p class="muted">Not configured. Set <code>SEARXNG_BASE_URL</code> to check instance health.</p>';
  } else {
    healthSection = statCards([
      { label: 'Status', value: health.ok ? '<span class="ok">up</span>' : '<span class="error">down</span>' },
      { label: `Latency (${escapeHtml(health.method)})`, value: `${formatInteger(health.latencyMs)} ms` },
      { label: 'Instance', value: `<code>${escapeHtml(health.baseUrl)}</code>` },
    ]) + `<p class="muted">Checked ${escapeHtml(formatDateTime(health.checkedAt))}${health.error ? ` — <span class="error">${escapeHtml(health.error)}</span>` : ''}. Health checks are free (self-hosted) and run on every refresh.</p>`;
  }
  return `
    <p class="note"><strong>${escapeHtml(detail.costLabel)}.</strong> ${escapeHtml(detail.costNote)}</p>
    ${statCards([
    { label: 'Searches (all time, from transcripts)', value: formatInteger(detail.totalCount) },
    { label: `Searches ${detail.monthToDate.month}`, value: formatInteger(detail.monthToDate.count) },
    { label: 'Spend', value: formatUsd(0) },
  ])}
    ${attributionNote(detail)}
    <h3>Instance health</h3>
    ${healthSection}
    ${searchBreakdown(detail, { showSpend: false })}
    ${scanFooter(detail.scan)}`;
}

async function renderTotalDetail() {
  const payload = await fetchJson('/api/total');
  noteServerState(payload);
  setRefreshedAt(payload.refreshedAt);
  setToday(payload.range, payload.timeZone);
  if (!payload.summary) {
    appRoot.innerHTML = '<nav class="crumbs"><a href="#/">← All providers</a></nav><p class="muted">No data yet.</p>';
    return;
  }
  const { detail } = payload;
  const series = detail.providers.map((provider, index) => ({ id: provider.id, name: provider.name, color: providerColor(provider.id, index) }));
  // Spend legend carries each provider's cost kind, so the stacked bars cannot be read as one bill.
  const spendSeries = series.map((item, index) => {
    const costKind = detail.providers[index].costKind;
    return { ...item, name: `${item.name} (${CostKindLabels[costKind] || costKind})` };
  });
  const searchSeries = series.filter((item) => detail.providers.find((provider) => provider.id === item.id)?.metrics.includes('searches'));
  const windowCell = (provider, windowId, metric, format) => (provider.metrics.includes(metric) ? format(provider.windows?.[windowId]?.[metric]) : '—');
  appRoot.innerHTML = `
    <nav class="crumbs"><a href="#/">← All providers</a></nav>
    <h2 class="detail-title">All platforms</h2>
    <p class="note"><strong>Actual and estimated spend are shown separately, never added.</strong> Actual = billed (SearXNG is self-hosted, $0)${payload.summary.windows.allTime.actualUsd ? '' : `; ${NoActualHint}`}.
      Estimated = API-equivalent + estimated. API-equivalent = what subscription token usage would cost at API list prices (Claude); it is not a bill.
      Brave's part is request count × list price, unconfirmed by the vendor and before the monthly credit.
      Days are in ${escapeHtml(payload.timeZone)}; "7 days" is today plus the six previous days.</p>
    ${windowsTable(payload.summary.windows, { rows: totalWindowRows() })}
    <h3>Spend by provider per day (estimated / API-equivalent unless marked actual)</h3>
    ${stackedBarChart(detail.byDay, { series: spendSeries, valueOf: (row, providerId) => row.byProvider?.[providerId]?.costUsd, format: formatUsd, title: 'Spend per day by kind (stacked by provider; not a bill unless actual)' })}
    <h3>Searches by provider per day</h3>
    ${stackedBarChart(detail.byDay, { series: searchSeries, valueOf: (row, providerId) => row.byProvider?.[providerId]?.searches, title: 'Web searches per day (stacked by backend)' })}
    <h3>Per provider</h3>
    ${dataTable([
    { label: 'Provider', render: (row) => `<a href="#/provider/${escapeHtml(row.id)}">${escapeHtml(row.name)}</a> ${activeBadge(row)}${row.ok === false ? ' <span class="error">(error)</span>' : ''}` },
    { label: 'Spend kind', render: (row) => escapeHtml(CostKindLabels[row.costKind] || row.costKind) },
    { label: 'Spend today', numeric: true, render: (row) => windowCell(row, 'today', 'costUsd', formatUsd) },
    { label: 'Spend 7d', numeric: true, render: (row) => windowCell(row, 'last7Days', 'costUsd', formatUsd) },
    { label: 'Spend all time', numeric: true, render: (row) => windowCell(row, 'allTime', 'costUsd', formatUsd) },
    { label: 'Tokens', numeric: true, render: (row) => windowCell(row, 'allTime', 'tokens', formatCompact) },
    { label: 'Searches', numeric: true, render: (row) => windowCell(row, 'allTime', 'searches', formatInteger) },
    { label: 'Messages', numeric: true, render: (row) => windowCell(row, 'allTime', 'messages', formatInteger) },
  ], detail.providers)}`;
}

function scanFooter(scan) {
  if (!scan) return '';
  return `<p class="muted small">Source scan: ${formatInteger(scan.fileCount)} transcript files, ${(scan.totalBytes / 1e6).toFixed(1)} MB,
    ${formatInteger(scan.reparsedFileCount)} re-parsed this refresh, ${scan.durationMs} ms${scan.rootMissing ? ' — transcript directory not found!' : ''}${scan.unreadableFileCount ? `, ${scan.unreadableFileCount} unreadable` : ''}.</p>`;
}

function renderOtherSearchDetail(detail) {
  return `
    <p class="note"><strong>${escapeHtml(detail.costLabel)}.</strong> ${escapeHtml(detail.costNote)}</p>
    ${statCards([
    { label: 'Searches (all time, from transcripts)', value: formatInteger(detail.totalCount) },
    { label: `Searches ${detail.monthToDate.month}`, value: formatInteger(detail.monthToDate.count) },
  ])}
    <h3>By backend</h3>
    ${dataTable([{ label: 'Backend', key: 'provider' }, { label: 'Searches', numeric: true, render: (row) => formatInteger(row.count) }], detail.byProvider)}
    ${searchBreakdown(detail, { showSpend: false })}
    ${scanFooter(detail.scan)}`;
}

const DetailRenderers = {
  claude: renderClaudeDetail, brave: renderBraveDetail, searxng: renderSearxngDetail, 'other-search': renderOtherSearchDetail,
};

function renderGenericDetail(detail) {
  return `<pre class="raw">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>`;
}

async function renderDetail(providerId) {
  const payload = await fetchJson(`/api/providers/${encodeURIComponent(providerId)}`);
  noteServerState(payload);
  setRefreshedAt(payload.refreshedAt);
  setToday(payload.range, payload.timeZone);
  const renderer = DetailRenderers[providerId] || renderGenericDetail;
  appRoot.innerHTML = `
    <nav class="crumbs"><a href="#/">← All providers</a></nav>
    <h2 class="detail-title">${escapeHtml(payload.summary?.name || providerId)} ${activeBadge(payload.summary || {})}</h2>
    ${payload.ok === false ? `<p class="error">Last refresh failed: ${escapeHtml(payload.error)}</p>` : ''}
    ${windowsTable(payload.summary?.windows, { costKind: payload.summary?.costKind })}
    ${payload.detail ? renderer(payload.detail) : '<p class="muted">No data yet.</p>'}`;
}

// ---------- routing & refresh ----------
// background: a timer re-fetch. A failed background fetch keeps the current
// view (the server may be restarting) and only notes the error in the header.
async function route({ background = false } = {}) {
  const providerMatch = location.hash.match(/^#\/provider\/([a-z0-9-]+)$/);
  const scrollY = window.scrollY;
  try {
    if (location.hash === '#/total') await renderTotalDetail();
    else if (providerMatch) await renderDetail(providerMatch[1]);
    else renderTiles(await fetchJson('/api/summary'));
    if (background) window.scrollTo(0, scrollY); // re-render must not jump the page
  } catch (error) {
    if (background) refreshedAtLabel.textContent = `Auto-refresh failed (${error.message}); retrying`;
    else appRoot.innerHTML = `<p class="error">Failed to load: ${escapeHtml(error.message)}</p>`;
  } finally {
    schedulePoll();
  }
}

// Re-fetch (GET only; the server's own timer does the refresh) once per
// interval, aimed just after the server's next expected auto refresh so the
// tab lags the server by seconds, not a whole interval. Paused while hidden.
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!autoRefreshSeconds || document.hidden) return;
  const intervalMs = autoRefreshSeconds * 1000;
  let delayMs = intervalMs;
  const refreshedAtMs = Date.parse(lastRefreshedAt);
  if (Number.isFinite(refreshedAtMs)) {
    const untilNextServerRefreshMs = refreshedAtMs + intervalMs + 5000 - Date.now();
    if (untilNextServerRefreshMs >= 5000 && untilNextServerRefreshMs < intervalMs) delayMs = untilNextServerRefreshMs;
  }
  pollTimer = setTimeout(() => {
    if (refreshButton.disabled) schedulePoll(); // a manual refresh is in progress and will re-render
    else route({ background: true });
  }, delayMs);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
  } else {
    route({ background: true }); // catch up at once, then resume the schedule
  }
});

refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  try {
    await fetchJson('/api/refresh', { method: 'POST' });
    await route();
  } catch (error) {
    appRoot.insertAdjacentHTML('afterbegin', `<p class="error">Refresh failed: ${escapeHtml(error.message)}</p>`);
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh';
  }
});

// Explicit paid probe (e.g. Brave quota while SearXNG is the active backend).
appRoot.addEventListener('click', async (event) => {
  const probeButton = event.target.closest('button[data-probe]');
  if (!probeButton) return;
  probeButton.disabled = true;
  probeButton.textContent = 'Probing…';
  try {
    await fetchJson(`/api/refresh?probe=${encodeURIComponent(probeButton.dataset.probe)}`, { method: 'POST' });
    await route();
  } catch (error) {
    appRoot.insertAdjacentHTML('afterbegin', `<p class="error">Probe failed: ${escapeHtml(error.message)}</p>`);
  }
});

window.addEventListener('hashchange', route);
route();
