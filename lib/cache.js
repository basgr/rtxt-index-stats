/**
 * Cache wrapper over chrome.storage.local.
 * Keys are namespaced as `cache:<host>:<query>`.
 * TTL: 7 days. Entries beyond TTL are returned as misses (not auto-deleted —
 * a subsequent set overwrites them).
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const key = (host, query) => `cache:${host}:${query}`;

export async function getCached(host, query) {
  const k = key(host, query);
  const obj = await chrome.storage.local.get(k);
  const entry = obj[k];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry; // { count, fetchedAt }
}

export async function setCached(host, query, count, approximate = false) {
  const k = key(host, query);
  await chrome.storage.local.set({
    [k]: { count, fetchedAt: Date.now(), approximate },
  });
}

export async function clearCachedForHost(host) {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith(`cache:${host}:`));
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

export async function clearCachedQuery(host, query) {
  await chrome.storage.local.remove(key(host, query));
}

export async function getRunState(host) {
  const k = `run:${host}`;
  const obj = await chrome.storage.local.get(k);
  return obj[k] || null;
}

export async function setRunState(host, state) {
  await chrome.storage.local.set({ [`run:${host}`]: state });
}

export async function clearRunState(host) {
  await chrome.storage.local.remove(`run:${host}`);
}
