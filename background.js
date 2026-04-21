import { startRun, resumeAfterCaptcha, refreshRow, resumeAllPending, confirmRun, stopRun, resumeRun } from './lib/orchestrator.js';

// Re-enqueue any rows left pending from a run interrupted by SW kill.
try { resumeAllPending(); } catch (e) { console.warn('resumeAllPending failed', e); }

const RESULTS_PATH = 'results.html';

chrome.action.onClicked.addListener(async (tab) => {
  const host = hostOf(tab.url);
  if (!host) {
    await openResults('non-web');
    return;
  }
  await openResultsTab(host);
  startRun(host);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Async listeners must return true to keep the channel open
  (async () => {
    if (msg.type === 'startRun') {
      startRun(msg.host);
      sendResponse({ ok: true });
    } else if (msg.type === 'refreshAll') {
      startRun(msg.host, { force: true });
      sendResponse({ ok: true });
    } else if (msg.type === 'rescan') {
      startRun(msg.host, { force: true, keepCache: true });
      sendResponse({ ok: true });
    } else if (msg.type === 'refreshRow') {
      await refreshRow(msg.host, msg.query);
      sendResponse({ ok: true });
    } else if (msg.type === 'resumeAfterCaptcha') {
      resumeAfterCaptcha(msg.host);
      sendResponse({ ok: true });
    } else if (msg.type === 'confirmRun') {
      confirmRun(msg.host);
      sendResponse({ ok: true });
    } else if (msg.type === 'stopRun') {
      await stopRun(msg.host);
      sendResponse({ ok: true });
    } else if (msg.type === 'resumeRun') {
      await resumeRun(msg.host);
      sendResponse({ ok: true });
    }
  })();
  return true;
});

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host;
  } catch { return null; }
}

async function openResults(reason) {
  const url = chrome.runtime.getURL(`${RESULTS_PATH}?reason=${reason}`);
  await chrome.tabs.create({ url });
}

async function openResultsTab(host) {
  const target = chrome.runtime.getURL(`${RESULTS_PATH}?host=${encodeURIComponent(host)}`);
  // Look for an existing tab for this host
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL(`${RESULTS_PATH}*`) });
  const match = existing.find(t => t.url && t.url.includes(`host=${encodeURIComponent(host)}`));
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId) await chrome.windows.update(match.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: target });
}
