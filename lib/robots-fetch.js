/**
 * Fetch robots.txt for a host and classify the outcome per spec §6.0.
 *
 * Returns one of:
 *   { status: 'ok',             body: string }
 *   { status: 'notFound' }
 *   { status: 'authRequired',   httpStatus: 401|403 }
 *   { status: 'temporaryError', httpStatus: number }
 *   { status: 'invalidContent', contentType: string }
 *   { status: 'redirectError',  message: string }
 *   { status: 'networkError',   message: string }
 *   { status: 'timeout' }
 */
const TIMEOUT_MS = 15000;
const MAX_BYTES = 500 * 1024;

export async function fetchRobots(host) {
  const url = `https://${host}/robots.txt`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow', // follow up to browser default (~20); we treat any landing as fine if same-origin enough
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { status: 'timeout' };
    return { status: 'networkError', message: e.message };
  }
  clearTimeout(timer);

  // Cross-host redirect check
  try {
    const finalHost = new URL(res.url).host;
    if (finalHost !== host) {
      return { status: 'redirectError', message: `robots.txt redirected to ${finalHost}` };
    }
  } catch {
    // ignore URL parse failures
  }

  if (res.status === 404 || res.status === 410) return { status: 'notFound' };
  if (res.status === 401 || res.status === 403) {
    return { status: 'authRequired', httpStatus: res.status };
  }
  if (res.status === 429 || res.status >= 500) {
    return { status: 'temporaryError', httpStatus: res.status };
  }
  if (!res.ok) {
    return { status: 'temporaryError', httpStatus: res.status };
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !ct.startsWith('text/')) {
    return { status: 'invalidContent', contentType: ct };
  }

  // Read up to MAX_BYTES; if larger, we still parse what we got.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      chunks.push(value.subarray(0, value.length - (total - MAX_BYTES)));
      break;
    }
    chunks.push(value);
  }
  const body = new TextDecoder('utf-8').decode(concatChunks(chunks));
  return { status: 'ok', body };
}

function concatChunks(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
