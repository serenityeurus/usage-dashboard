// Vanilla JS UI: tile grid (#/) and per-provider detail (#/provider/<id>).
const appRoot = document.getElementById('app');
const refreshButton = document.getElementById('refresh-button');
const refreshedAtLabel = document.getElementById('refreshed-at');

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

function setRefreshedAt(refreshedAt, durationMs) {
  refreshedAtLabel.textContent = refreshedAt
    ? `Updated ${formatDateTime(refreshedAt)}${durationMs != null ? ` (${durationMs} ms)` : ''}`
    : 'Collecting data…';
}

// ---------- tiles ----------
function renderTiles(summary) {
  setRefreshedAt(summary.refreshedAt, summary.durationMs);
  if (!summary.providers.length) {
    appRoot.innerHTML = '<p class="muted">Collecting data… this page will update shortly.</p>';
    setTimeout(route, 1500);
    return;
  }
  appRoot.innerHTML = `<section class="tile-grid">${summary.providers.map((provider) => `
    <a class="tile" href="#/provider/${escapeHtml(provider.id)}" data-provider="${escapeHtml(provider.id)}">
      <h2>${escapeHtml(provider.name)}</h2>
      ${provider.ok === false ? `<p class="error">Error: ${escapeHtml(provider.error)}${provider.stale ? ' (showing last good data)' : ''}</p>` : ''}
      <div class="tile-primary">
        <div><span class="big">${formatUsd(provider.costUsd)}</span><span class="label">${escapeHtml(provider.costLabel)}</span></div>
        ${provider.primaryMetric ? `<div><span class="big">${formatCompact(provider.primaryMetric.value)}</span><span class="label">${escapeHtml(provider.primaryMetric.label)}</span></div>` : ''}
      </div>
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
  return `
    <p class="note"><strong>${escapeHtml(detail.costLabel)}.</strong> ${escapeHtml(detail.costNote)}</p>
    ${statCards([
    { label: 'Searches (all time, from transcripts)', value: formatInteger(detail.totalCount) },
    { label: 'Estimated gross spend (all time)', value: formatUsd(detail.totalGrossUsd) },
    { label: `Searches ${detail.monthToDate.month}`, value: formatInteger(detail.monthToDate.count) },
    { label: `Est. billed ${detail.monthToDate.month} (after $${detail.pricing.monthlyCreditUsd} credit)`, value: formatUsd(detail.monthToDate.netUsd) },
  ])}
    <h3>Live quota (Brave rate-limit headers)</h3>
    ${quotaSection}
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

function scanFooter(scan) {
  if (!scan) return '';
  return `<p class="muted small">Source scan: ${formatInteger(scan.fileCount)} transcript files, ${(scan.totalBytes / 1e6).toFixed(1)} MB,
    ${formatInteger(scan.reparsedFileCount)} re-parsed this refresh, ${scan.durationMs} ms${scan.rootMissing ? ' — transcript directory not found!' : ''}${scan.unreadableFileCount ? `, ${scan.unreadableFileCount} unreadable` : ''}.</p>`;
}

const DetailRenderers = { claude: renderClaudeDetail, brave: renderBraveDetail };

function renderGenericDetail(detail) {
  return `<pre class="raw">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>`;
}

async function renderDetail(providerId) {
  const payload = await fetchJson(`/api/providers/${encodeURIComponent(providerId)}`);
  setRefreshedAt(payload.refreshedAt);
  const renderer = DetailRenderers[providerId] || renderGenericDetail;
  appRoot.innerHTML = `
    <nav class="crumbs"><a href="#/">← All providers</a></nav>
    <h2 class="detail-title">${escapeHtml(payload.summary?.name || providerId)}</h2>
    ${payload.ok === false ? `<p class="error">Last refresh failed: ${escapeHtml(payload.error)}</p>` : ''}
    ${payload.detail ? renderer(payload.detail) : '<p class="muted">No data yet.</p>'}`;
}

// ---------- routing & refresh ----------
async function route() {
  const providerMatch = location.hash.match(/^#\/provider\/([a-z0-9-]+)$/);
  try {
    if (providerMatch) await renderDetail(providerMatch[1]);
    else renderTiles(await fetchJson('/api/summary'));
  } catch (error) {
    appRoot.innerHTML = `<p class="error">Failed to load: ${escapeHtml(error.message)}</p>`;
  }
}

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

window.addEventListener('hashchange', route);
route();
