const params = new URLSearchParams(location.search);
const host = params.get('host');
const reason = params.get('reason');

const $ = (id) => document.getElementById(id);

function fmtNum(n) { return new Intl.NumberFormat().format(n); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

if (reason === 'non-web') {
  document.body.innerHTML = '<div class="message">Open this extension on an http(s) page.</div>';
} else if (!host) {
  document.body.innerHTML = '<div class="message">No host provided.</div>';
} else {
  init();
}

async function init() {
  $('host-title').textContent = `robots.txt Disallow Index Count Check for ${host}`;
  document.title = `robots.txt Disallow Check - ${host}`;
  $('refresh-all').addEventListener('click', () => {
    if (confirm('Clear cache and re-run all queries for ' + host + '?')) {
      rowsByQuery.clear();
      $('rows').innerHTML = '';
      chrome.runtime.sendMessage({ type: 'refreshAll', host });
    }
  });

  $('rescan').addEventListener('click', () => {
    if (confirm('Re-read robots.txt for ' + host + '? Cache is kept, so already-queried rows return instantly. Only new / uncached rules re-query.')) {
      rowsByQuery.clear();
      $('rows').innerHTML = '';
      chrome.runtime.sendMessage({ type: 'rescan', host });
    }
  });

  $('open-google').addEventListener('click', () => {
    const blocked = [...rowsByQuery.values()].find(r => r.status === 'blocked');
    const url = blocked?.verifyUrl
      || `https://www.google.com/search?q=site:${encodeURIComponent(host)}&filter=0`;
    chrome.tabs.create({ url });
  });
  $('resume').addEventListener('click', () => {
    $('captcha-banner').hidden = true;
    chrome.runtime.sendMessage({ type: 'resumeAfterCaptcha', host });
  });

  $('confirm-start').addEventListener('click', () => {
    $('confirm-banner').hidden = true;
    chrome.runtime.sendMessage({ type: 'confirmRun', host });
  });

  $('stop-run').addEventListener('click', () => {
    const spinner = $('run-spinner');
    if (spinner) spinner.hidden = true;
    chrome.runtime.sendMessage({ type: 'stopRun', host });
  });

  $('resume-run').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'resumeRun', host });
  });

  $('copy-tsv').addEventListener('click', copyTsv);
  $('copy-md').addEventListener('click', copyMd);

  $('copy-debug').addEventListener('click', async () => {
    const obj = await chrome.storage.local.get('debug:lastUnrecognized');
    const snap = obj['debug:lastUnrecognized'];
    if (!snap) {
      alert('No unrecognized response captured yet.');
      return;
    }
    const text = `URL: ${snap.url}\nCaptured at: ${new Date(snap.at).toISOString()}\nBody length: ${snap.body.length}\n\n--- BODY ---\n${snap.body}`;
    await navigator.clipboard.writeText(text);
    alert(`Copied ${text.length} bytes to clipboard. Paste it back so we can update the parser.`);
  });

  for (const th of document.querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => onSortHeaderClick(th));
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.host !== host) return;
    if (msg.type === 'run:meta') onMeta(msg);
    else if (msg.type === 'run:row') upsertRow(msg.row);
    else if (msg.type === 'run:state') { runStatus = msg.runStatus; updateProgress(); }
    else if (msg.type === 'run:done') { runStatus = 'done'; updateProgress(); }
    else if (msg.type === 'run:captcha') { runStatus = 'paused-captcha'; $('captcha-banner').hidden = false; updateProgress(); }
    else if (msg.type === 'run:confirm') { runStatus = 'awaiting-confirmation'; showConfirmBanner(msg); updateProgress(); }
  });

  // Tell background to start. With existing state, this just replays —
  // it will not auto-start work.
  chrome.runtime.sendMessage({ type: 'startRun', host });
}

// Authoritative run state mirrored from background. Drives banners + buttons.
let runStatus = null;

function onMeta({ robotsStatus, robots, ruleCount, startedAt, runStatus: nextStatus }) {
  // Banner visibility is owned by updateProgress (driven by runStatus).
  // Don't toggle banners here, or we'd hide a banner from a message that
  // happens to arrive before run:meta.
  runStatus = nextStatus || null;

  // Reset the row map + DOM. Without this, stale entries from a previous
  // run on the same tab (e.g. after Refresh All, or after the robots.txt
  // rules changed between opens) inflate the queryable count and total.
  rowsByQuery.clear();
  $('rows').innerHTML = '';

  const stamp = formatAge(startedAt || Date.now());
  const spinner = `<span class="run-spinner" id="run-spinner" title="Run is active" hidden></span>`;
  if (robotsStatus !== 'ok') {
    $('meta').innerHTML = `Run started ${escapeHtml(stamp)}${spinner} · robots.txt: <strong>${escapeHtml(describeRobotsStatus(robotsStatus, robots))}</strong>`;
  } else {
    const robotsUrl = `https://${host}/robots.txt`;
    $('meta').innerHTML = `Run started ${escapeHtml(stamp)}${spinner} · <a href="${escapeHtml(robotsUrl)}" target="_blank" rel="noopener noreferrer" title="Open robots.txt">robots.txt: 200 OK ↗</a> · ${ruleCount} rule(s)`;
  }
  updateProgress();
}

function showConfirmBanner({ queryableCount, minMs, maxMs }) {
  const fmtMin = ms => Math.ceil(ms / 60000);
  $('confirm-text').textContent =
    `${queryableCount} fresh queries to run, taking approximately ${fmtMin(minMs)}-${fmtMin(maxMs)} minutes (Google rate limit). Cached and skipped rows are already shown above.`;
  $('confirm-banner').hidden = false;
}

function describeRobotsStatus(status, robots) {
  switch (status) {
    case 'notFound': return `not found (no crawl restrictions)`;
    case 'authRequired': return `requires authentication (HTTP ${robots?.httpStatus}) - cannot evaluate`;
    case 'temporaryError': return `temporarily unavailable (HTTP ${robots?.httpStatus})`;
    case 'invalidContent': return `non-text content (${robots?.contentType}) - likely soft 404`;
    case 'redirectError': return robots?.message || 'redirect error';
    case 'networkError': return robots?.message || 'network error';
    case 'timeout': return 'request timed out (15s)';
    default: return status;
  }
}

const rowsByQuery = new Map();

// ---- sorting --------------------------------------------------------------
// Sort state is per-tab session. null/null = original parse order from rowsByQuery.
let sortState = { column: null, direction: null };

const SORT_KEYS = {
  pattern:     r => (r.raw ?? '').toLowerCase(),
  query:       r => r.query?.toLowerCase(),
  results:     r => r.result?.count,
  lastFetched: r => r.result?.fetchedAt,
};

function compareRows(a, b) {
  const extract = SORT_KEYS[sortState.column];
  const va = extract(a);
  const vb = extract(b);
  // Missing values always sort to the end, regardless of direction.
  const aMissing = va == null || va === '';
  const bMissing = vb == null || vb === '';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const cmp = typeof va === 'number'
    ? va - vb
    : String(va).localeCompare(String(vb));
  return sortState.direction === 'desc' ? -cmp : cmp;
}

function applySort() {
  // Update header indicators.
  for (const th of document.querySelectorAll('th.sortable')) {
    const active = th.dataset.sortKey === sortState.column;
    th.classList.toggle('is-active', active);
    const ind = th.querySelector('.sort-ind');
    if (!ind) continue;
    ind.textContent = active ? (sortState.direction === 'desc' ? '▼' : '▲') : '';
  }
  // Reorder DOM. Insertion order of rowsByQuery is the parse order; that's
  // our default. appendChild on an existing node moves it (no clone, so
  // listeners survive).
  const tbody = $('rows');
  const ordered = sortState.column
    ? [...rowsByQuery.values()].sort(compareRows)
    : [...rowsByQuery.values()];
  for (const row of ordered) {
    const k = row.query || row.raw;
    const tr = tbody.querySelector(`tr[data-key="${cssEscape(k)}"]`);
    if (tr) tbody.appendChild(tr);
  }
}

function onSortHeaderClick(th) {
  const col = th.dataset.sortKey;
  if (sortState.column !== col) {
    sortState = { column: col, direction: 'asc' };
  } else if (sortState.direction === 'asc') {
    sortState.direction = 'desc';
  } else {
    sortState = { column: null, direction: null };
  }
  applySort();
}

function upsertRow(row) {
  const k = row.query || row.raw;
  rowsByQuery.set(k, row);
  let tr = document.querySelector(`tr[data-key="${cssEscape(k)}"]`);
  if (!tr) {
    tr = document.createElement('tr');
    tr.dataset.key = k;
    $('rows').appendChild(tr);
  }
  tr.innerHTML = renderRow(row);
  tr.querySelector('.refresh-row')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'refreshRow', host, query: row.query });
  });
  if (sortState.column) applySort();
  updateProgress();
}

function renderRow(row) {
  const variantBadge = row.variants && row.variants.length > 1
    ? ` <span title="Also matches: ${escapeHtml(row.variants.slice(1).join(', '))}">+${row.variants.length - 1}</span>`
    : '';
  const patternCell = `<code>${escapeHtml(row.raw)}</code>${variantBadge}`;

  if (row.kind === 'skipped') {
    return `
      <td>${patternCell}</td>
      <td>—</td>
      <td class="results-cell">skipped</td>
      <td class="status-skipped" title="${escapeHtml(row.reason)}">⚠ ${escapeHtml(row.reason)}</td>
      <td>—</td>
    `;
  }

  const queryCell = `<code>${escapeHtml(row.query)}</code>`;
  const result = row.result;
  let resultText = '—';
  const approx = !!(result?.approximate || row.approximate);
  if (row.status === 'live' || row.status === 'cached') {
    resultText = (approx && result.count > 0 ? '~' : '') + fmtNum(result.count);
  }
  if (row.status === 'error') resultText = '—';
  const resultTitle = approx
    ? (row.approximate
        ? 'Approximate: this rule has a mid-path wildcard. Query uses inurl: which is substring-based, so the count is a loose match (often an overestimate).'
        : 'Approximate: Google did not show an exact count for this query - this is the visible result count (likely a lower bound).')
    : 'Google site: is a prefix match - count is an upper bound on URLs covered by this rule.';

  let statusCell = '';
  if (row.status === 'fetching') statusCell = `<span class="status-fetching">⟳ fetching...</span>`;
  if (row.status === 'pending')  statusCell = `<span class="status-pending">…</span>`;
  if (row.status === 'stopped')  statusCell = `<span class="status-stopped" title="Run stopped. Click ↻ to retry this row.">⏸ stopped</span>`;
  if (row.status === 'live')     statusCell = `<span class="status-live">✓ just now</span>`;
  if (row.status === 'cached')   statusCell = `<span class="status-cached">✓ ${formatAge(result.fetchedAt)}</span>`;
  if (row.status === 'blocked')  statusCell = `<span class="status-blocked">⛔ CAPTCHA</span>`;
  if (row.status === 'error') {
    const msg = row.errorMessage || 'unknown';
    const short = msg.length > 30 ? msg.slice(0, 27) + '...' : msg;
    const suffix = msg.includes('http-429') ? ' (rate limited)' : '';
    statusCell = `<span class="status-error" title="${escapeHtml(msg)}">✗ ${escapeHtml(short)}${suffix}</span>`;
  }

  const refreshBtn = `<button class="refresh-row" title="Refresh this row" type="button">↻</button>`;
  const verifyLink = `<a href="${escapeHtml(row.verifyUrl)}" target="_blank" rel="noopener noreferrer" title="Open in Google">↗</a>`;

  return `
    <td>${patternCell}</td>
    <td>${queryCell}</td>
    <td class="results-cell" title="${escapeHtml(resultTitle)}">${resultText}</td>
    <td>${statusCell}</td>
    <td class="row-actions">${verifyLink} ${refreshBtn}</td>
  `;
}

function formatAge(t) {
  const d = new Date(t);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const tz = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
    .formatToParts(d)
    .find(p => p.type === 'timeZoneName')?.value || '';
  return `${dd}.${mm}.${yy} @ ${hh}:${mi}${tz ? ' ' + tz : ''}`;
}

function updateProgress() {
  const rows = [...rowsByQuery.values()];
  const queryable = rows.filter(r => r.kind === 'queryable');
  const skipped = rows.length - queryable.length;
  const done = queryable.filter(r => r.status === 'live' || r.status === 'cached').length;
  const blocked = queryable.filter(r => r.status === 'blocked').length;
  const todo = queryable.length - done - blocked;

  // Banners and buttons derive from runStatus, not row statuses, so they can't disagree.
  const isRunning = runStatus === 'running';
  const isStopped = runStatus === 'paused-stopped';
  const isAwaiting = runStatus === 'awaiting-confirmation';
  const isCaptcha = runStatus === 'paused-captcha';

  // Spinner: only when actively running.
  const spinner = $('run-spinner');
  if (spinner) spinner.hidden = !isRunning;

  // Stop button: visible only while running. Resume button: visible only while paused-stopped.
  $('stop-run').hidden = !isRunning;
  $('resume-run').hidden = !isStopped;

  // Banners are shown by their dedicated message; hide them when the state moves away.
  if (!isCaptcha) $('captcha-banner').hidden = true;
  if (!isAwaiting) $('confirm-banner').hidden = true;

  $('progress-text').textContent = `${done} / ${queryable.length} queried · ${skipped} skipped · ${blocked} blocked · ${todo} to go`;
  const pct = queryable.length === 0 ? 100 : Math.round(done / queryable.length * 100);
  $('progress-fill').style.width = pct + '%';

  const counted = rows.filter(r => r.status === 'live' || r.status === 'cached');
  const totalCount = counted.reduce((s, r) => s + (r.result?.count || 0), 0);
  // If any contributing row is approximate (and contributed a non-zero count),
  // the total is itself approximate — surface that with the same `~` prefix
  // we use on individual cells.
  const totalApprox = totalCount > 0 && counted.some(r =>
    (r.result?.count || 0) > 0 && (r.result?.approximate || r.approximate));
  const prefix = totalApprox ? '~' : '';
  $('total-indexed').innerHTML = `<strong>${prefix}${fmtNum(totalCount)}</strong>`;
}

function exportRows() {
  const onlyIndexed = $('only-indexed').checked;
  const all = [...rowsByQuery.values()];
  return onlyIndexed
    ? all.filter(r => (r.result?.count ?? 0) > 0)
    : all;
}

function copyTsv() {
  const lines = exportRows().map(r => {
    const status = r.kind === 'skipped' ? 'skipped' : r.status;
    const count = r.result?.count ?? '';
    return `${r.raw}\t${r.query || ''}\t${count}\t${status}`;
  });
  navigator.clipboard.writeText(lines.join('\n'));
}

function copyMd() {
  const header = '| Pattern | Query | Results | Status |\n|---|---|---|---|';
  const lines = exportRows().map(r => {
    const status = r.kind === 'skipped' ? `skipped (${r.reason})` : r.status;
    const count = r.result?.count != null ? fmtNum(r.result.count) : '';
    return `| \`${r.raw}\` | \`${r.query || ''}\` | ${count} | ${status} |`;
  });
  navigator.clipboard.writeText([header, ...lines].join('\n'));
}

function cssEscape(s) {
  return s.replace(/["\\]/g, '\\$&');
}
