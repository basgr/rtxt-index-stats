/**
 * Sequential, randomized-delay queue using chrome.alarms (so the MV3 service
 * worker can be killed between fetches without losing work).
 *
 * Usage:
 *   throttle.enqueue(async () => { ... });
 *
 * Queue is process-global. Persistence across SW restarts is the orchestrator's
 * job (it re-enqueues pending rows from chrome.storage when the SW comes back).
 */
const MIN_DELAY = 10_000;
const MAX_DELAY = 30_000;
const ALARM_NAME = 'rdc-throttle-tick';

const queue = [];
let running = false;
let alarmListenerInstalled = false;

function ensureAlarmListener() {
  if (alarmListenerInstalled) return;
  alarmListenerInstalled = true;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) tick();
  });
}

function randDelay() {
  return Math.floor(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
}

export function enqueue(fn) {
  ensureAlarmListener();
  queue.push(fn);
  if (!running) tick();
}

/** Enqueue at the FRONT of the queue (for user-initiated refresh / CAPTCHA retry). */
export function enqueueFront(fn) {
  ensureAlarmListener();
  queue.unshift(fn);
  if (!running) tick();
}

export function clearQueue() {
  queue.length = 0;
  running = false;
  chrome.alarms.clear(ALARM_NAME);
}

let paused = false;
export function pause() { paused = true; }
export function resume() {
  paused = false;
  if (queue.length && !running) tick();
}

async function tick() {
  if (paused) { running = false; return; }
  const next = queue.shift();
  if (!next) { running = false; return; }
  running = true;
  try { await next(); } catch (e) { console.error('[rdc/throttle] task threw', e); }

  if (queue.length === 0) { running = false; return; }
  // schedule the next tick via alarm so SW survives idle kill
  chrome.alarms.create(ALARM_NAME, { when: Date.now() + randDelay() });
}
