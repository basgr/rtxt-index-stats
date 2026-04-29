import { fetchRobots } from './robots-fetch.js';
import { parse as parseRobots } from './robots-parser.js';
import { normalizeAndDedupe } from './pattern-normalize.js';
import { fetchCount } from './google-fetch.js';
import { getCached, setCached, getRunState, setRunState, clearCachedForHost, clearRunState, clearCachedQuery } from './cache.js';
import * as throttle from './throttle.js';

const activeRuns = new Map(); // host → Promise (lock so a 2nd icon click doesn't start a parallel run)

/**
 * Run state machine. Persisted on `state.runStatus`. Single source of truth for
 * which banners and buttons the UI should show.
 *
 *   awaiting-confirmation  Gate fired (>50 fresh queryable rows); waiting on user.
 *   running                Tasks are (or should be) executing.
 *   paused-stopped         User pressed Stop; rows kept as 'stopped' until Resume.
 *   paused-captcha         Google blocked us; throttle paused until user solves.
 *   done                   No queryable rows remain in pending/fetching.
 *
 * Transitions (only these mutate runStatus):
 *   none           → running                (fresh small run)
 *   none           → awaiting-confirmation  (fresh large run)
 *   awaiting-conf. → running                (confirmRun)
 *   running        → paused-stopped         (stopRun)
 *   running        → paused-captcha         (CAPTCHA hit during fetch)
 *   running        → done                   (last pending row completed)
 *   paused-stopped → running                (resumeRun)
 *   paused-captcha → running                (resumeAfterCaptcha)
 *   any            → fresh                  (refreshAll, force=true)
 */
export const STATUS = Object.freeze({
  AWAITING_CONFIRM: 'awaiting-confirmation',
  RUNNING: 'running',
  PAUSED_STOP: 'paused-stopped',
  PAUSED_CAPTCHA: 'paused-captcha',
  DONE: 'done',
});

// Above this many uncached queryable rows, gate the run behind a user confirmation
// (pages like camping.info have 100+ disallow rules; running them all takes 30+ min).
const CONFIRM_THRESHOLD = 50;
const MIN_DELAY_MS = 10_000;
const MAX_DELAY_MS = 30_000;

/**
 * Entry point for opening the results tab. Replays existing state if any —
 * NEVER auto-starts work. The user must press Start / Resume / Refresh.
 *
 * Broadcasts: run:meta, run:row, run:done, run:captcha, run:confirm
 */
export function startRun(host, { force = false, confirmed = false, keepCache = false } = {}) {
  if (force) activeRuns.delete(host);
  else if (activeRuns.has(host)) return activeRuns.get(host);
  const p = doRun(host, { force, confirmed, keepCache }).finally(() => activeRuns.delete(host));
  activeRuns.set(host, p);
  return p;
}

async function doRun(host, { force, confirmed, keepCache }) {
  if (force) {
    if (!keepCache) await clearCachedForHost(host);
    await clearRunState(host);
    throttle.clearQueue();
  }

  let existing = await getRunState(host);

  // Migrate legacy state written before runStatus was introduced. We can't
  // tell what state it was in, so drop it and rebuild — but keep the cache
  // so we don't re-fetch rows we already have answers for.
  if (existing && !existing.runStatus) {
    await clearRunState(host);
    existing = null;
  }

  // Existing state with no explicit user action: just replay it. Do not start
  // or restart work. The UI will show whatever banner the runStatus dictates.
  if (existing && !force && !confirmed) {
    replayState(host, existing);
    return;
  }

  // confirmRun on an awaiting-confirmation state: keep existing rows, flip to
  // running, enqueue. Don't rebuild — that would wipe cache hits already shown.
  if (existing && !force && confirmed && existing.runStatus === STATUS.AWAITING_CONFIRM) {
    existing.runStatus = STATUS.RUNNING;
    await setRunState(host, existing);
    broadcast({ type: 'run:state', host, runStatus: STATUS.RUNNING });
    replayState(host, existing);
    enqueueAllPending(host, existing);
    return;
  }

  // Fresh build (no existing state, or force).
  const robots = await fetchRobots(host);
  if (robots.status !== 'ok') {
    const state = {
      host, startedAt: Date.now(), robotsStatus: robots.status, robots,
      rules: [], runStatus: STATUS.DONE,
    };
    await setRunState(host, state);
    broadcast({ type: 'run:meta', host, robotsStatus: robots.status, robots, ruleCount: 0, startedAt: state.startedAt, runStatus: state.runStatus });
    broadcast({ type: 'run:done', host });
    return;
  }

  const parsed = parseRobots(robots.body);
  const mergedDisallows = dedupePreserveOrder([
    ...parsed.googlebot.disallows, ...parsed.wildcard.disallows,
  ]);
  const mergedAllows = dedupePreserveOrder([
    ...parsed.googlebot.allows, ...parsed.wildcard.allows,
  ]);
  const rows = normalizeAndDedupe(host, mergedDisallows, mergedAllows).map(r => ({
    ...r,
    status: r.kind === 'queryable' ? 'pending' : 'skipped',
    result: null,
  }));

  const state = {
    host, startedAt: Date.now(), robotsStatus: 'ok', rules: rows,
    runStatus: STATUS.RUNNING, // tentative; may flip to AWAITING_CONFIRM below
  };
  await setRunState(host, state);
  broadcast({ type: 'run:meta', host, robotsStatus: 'ok', ruleCount: rows.length, startedAt: state.startedAt, runStatus: state.runStatus });
  for (const row of rows) broadcast({ type: 'run:row', host, row });

  // Serve cache hits, collect the rest.
  const needsFetch = [];
  for (const row of rows) {
    if (row.kind !== 'queryable') continue;
    const cached = await getCached(host, row.query);
    if (cached) {
      row.status = 'cached';
      row.result = { count: cached.count, fetchedAt: cached.fetchedAt, approximate: !!cached.approximate };
      await persistRow(host, row);
      broadcast({ type: 'run:row', host, row });
      continue;
    }
    needsFetch.push(row);
  }

  if (needsFetch.length === 0) {
    state.runStatus = STATUS.DONE;
    await setRunState(host, state);
    broadcast({ type: 'run:state', host, runStatus: STATUS.DONE });
    broadcast({ type: 'run:done', host });
    return;
  }

  // Gate large runs behind user confirmation.
  if (!confirmed && !force && needsFetch.length > CONFIRM_THRESHOLD) {
    state.runStatus = STATUS.AWAITING_CONFIRM;
    await setRunState(host, state);
    broadcast({ type: 'run:state', host, runStatus: STATUS.AWAITING_CONFIRM });
    broadcastConfirm(host, needsFetch.length);
    return;
  }

  state.runStatus = STATUS.RUNNING;
  await setRunState(host, state);
  broadcast({ type: 'run:state', host, runStatus: STATUS.RUNNING });
  for (const row of needsFetch) throttle.enqueue(() => liveFetchTask(host, row));
}

/** Resume a run that was gated by the confirmation threshold. */
export function confirmRun(host) {
  return startRun(host, { confirmed: true });
}

/**
 * Stop a run: clear queue, mark pending/fetching rows as 'stopped',
 * flip runStatus to paused-stopped.
 *
 * Note: throttle is process-global, so this halts queued work for ALL hosts.
 */
export async function stopRun(host) {
  throttle.clearQueue();
  const state = await getRunState(host);
  if (!state) return;
  state.runStatus = STATUS.PAUSED_STOP;
  for (const row of state.rules) {
    if (row.status === 'pending' || row.status === 'fetching') {
      row.status = 'stopped';
      broadcast({ type: 'run:row', host, row });
    }
  }
  await setRunState(host, state);
  broadcast({ type: 'run:state', host, runStatus: STATUS.PAUSED_STOP });
}

/** Resume from paused-stopped: stopped rows → pending, enqueue, runStatus → running. */
export async function resumeRun(host) {
  const state = await getRunState(host);
  if (!state) return;
  state.runStatus = STATUS.RUNNING;
  for (const row of state.rules) {
    if (row.status === 'stopped' && row.kind === 'queryable') {
      row.status = 'pending';
      broadcast({ type: 'run:row', host, row });
      throttle.enqueue(() => liveFetchTask(host, row));
    }
  }
  await setRunState(host, state);
  broadcast({ type: 'run:state', host, runStatus: STATUS.RUNNING });
}

/** Resume from paused-captcha: blocked row → pending front-of-queue, throttle resume. */
export async function resumeAfterCaptcha(host) {
  const state = await getRunState(host);
  if (state) {
    state.runStatus = STATUS.RUNNING;
    const blocked = state.rules.find(r => r.status === 'blocked');
    if (blocked) {
      blocked.status = 'pending';
      broadcast({ type: 'run:row', host, row: blocked });
      throttle.enqueueFront(() => liveFetchTask(host, blocked));
    }
    await setRunState(host, state);
    broadcast({ type: 'run:state', host, runStatus: STATUS.RUNNING });
  }
  throttle.resume();
}

export async function refreshRow(host, query) {
  const state = await getRunState(host);
  if (!state) return;
  const row = state.rules.find(r => r.query === query);
  if (!row || row.kind !== 'queryable') return;
  await clearCachedQuery(host, query);
  row.status = 'pending';
  row.result = null;
  // If the run was done/stopped, an individual refresh implies the user wants
  // activity — flip to running so the spinner & Stop button reappear.
  let statusChanged = false;
  if (state.runStatus === STATUS.DONE || state.runStatus === STATUS.PAUSED_STOP) {
    state.runStatus = STATUS.RUNNING;
    statusChanged = true;
  }
  await setRunState(host, state);
  if (statusChanged) broadcast({ type: 'run:state', host, runStatus: STATUS.RUNNING });
  broadcast({ type: 'run:row', host, row });
  throttle.enqueueFront(() => liveFetchTask(host, row));
}

/**
 * Called once at SW startup. Re-enqueues pending/fetching rows for any run
 * whose runStatus is RUNNING. Paused/awaiting/done runs are NOT auto-resumed.
 */
export async function resumeAllPending() {
  const all = await chrome.storage.local.get(null);
  for (const [k, state] of Object.entries(all)) {
    if (!k.startsWith('run:')) continue;
    if (!state || !Array.isArray(state.rules)) continue;
    if (state.runStatus !== STATUS.RUNNING) continue;
    const host = state.host;
    for (const row of state.rules) {
      if ((row.status === 'pending' || row.status === 'fetching') && row.kind === 'queryable') {
        throttle.enqueue(() => liveFetchTask(host, row));
      }
    }
  }
}

/**
 * Shared task body. Fetches the count, updates row + run state, broadcasts.
 * On CAPTCHA: row → blocked, runStatus → paused-captcha, throttle paused.
 * When this row was the last pending one: runStatus → done.
 */
async function liveFetchTask(host, row) {
  row.status = 'fetching';
  await persistRow(host, row);
  broadcast({ type: 'run:row', host, row });

  const out = await fetchCount(row.query);
  if (out.captcha) {
    row.status = 'blocked';
    await persistRow(host, row);
    await setRunStatus(host, STATUS.PAUSED_CAPTCHA);
    broadcast({ type: 'run:row', host, row });
    broadcast({ type: 'run:captcha', host });
    throttle.pause();
    return;
  }
  if (typeof out.count === 'number') {
    row.status = 'live';
    row.result = { count: out.count, fetchedAt: Date.now(), approximate: !!out.approximate };
    await setCached(host, row.query, out.count, !!out.approximate);
  } else {
    row.status = 'error';
    row.errorMessage = out.error;
  }
  await persistRow(host, row);
  broadcast({ type: 'run:row', host, row });

  // Only transition to DONE from RUNNING. If the user pressed Stop while this
  // task was in flight, the run is now PAUSED_STOP and we must not overwrite it.
  // Same applies to PAUSED_CAPTCHA (set above when captcha was hit).
  const cur = await getRunState(host);
  if (cur?.runStatus === STATUS.RUNNING && await isLastPending(host)) {
    await setRunStatus(host, STATUS.DONE);
    broadcast({ type: 'run:done', host });
  }
}

/** Replay persisted state to the UI: meta, all rows, plus the appropriate banner. */
function replayState(host, state) {
  broadcast({
    type: 'run:meta', host,
    robotsStatus: state.robotsStatus, robots: state.robots,
    ruleCount: state.rules.length,
    startedAt: state.startedAt,
    runStatus: state.runStatus,
  });
  for (const row of state.rules) broadcast({ type: 'run:row', host, row });

  switch (state.runStatus) {
    case STATUS.AWAITING_CONFIRM: {
      const n = state.rules.filter(r =>
        r.kind === 'queryable' && (r.status === 'pending' || !r.status)).length;
      broadcastConfirm(host, n);
      break;
    }
    case STATUS.PAUSED_CAPTCHA:
      broadcast({ type: 'run:captcha', host });
      break;
    case STATUS.DONE:
      broadcast({ type: 'run:done', host });
      break;
    // RUNNING and PAUSED_STOP: no banner; UI derives buttons from row statuses.
  }
}

function broadcastConfirm(host, queryableCount) {
  broadcast({
    type: 'run:confirm', host, queryableCount,
    minMs: queryableCount * MIN_DELAY_MS,
    maxMs: queryableCount * MAX_DELAY_MS,
  });
}

function enqueueAllPending(host, state) {
  for (const row of state.rules) {
    if (row.kind === 'queryable' && (row.status === 'pending' || !row.status)) {
      throttle.enqueue(() => liveFetchTask(host, row));
    }
  }
}

async function persistRow(host, row) {
  const state = await getRunState(host);
  if (!state) return;
  const i = state.rules.findIndex(r => r.query === row.query && r.raw === row.raw);
  if (i >= 0) state.rules[i] = row;
  await setRunState(host, state);
}

async function setRunStatus(host, runStatus) {
  const state = await getRunState(host);
  if (!state) return;
  state.runStatus = runStatus;
  await setRunState(host, state);
  broadcast({ type: 'run:state', host, runStatus });
}

async function isLastPending(host) {
  const state = await getRunState(host);
  if (!state) return false;
  return !state.rules.some(r => r.kind === 'queryable' && (r.status === 'pending' || r.status === 'fetching' || !r.status));
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no listener (results tab closed) is fine */ });
}
