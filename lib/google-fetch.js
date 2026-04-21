import { GOOGLE } from './google-selectors.js';
import {
  textOfElementById,
  titleText,
  containsAny,
  parseLocaleNumber,
} from './html-helpers.js';

function tryResultCountPatterns(body) {
  for (const source of GOOGLE.resultCountPatterns) {
    const re = new RegExp(source);
    const m = body.match(re);
    if (!m) continue;
    if (!m[1]) return 1; // single-result phrasing, no capture group
    // Strip non-digits from captured group
    const digits = m[1].replace(/[^\d]/g, '');
    if (digits === '') continue;
    return parseInt(digits, 10);
  }
  return null;
}

/**
 * Find the result-stats element by substring match on the id, regardless of
 * whether the page is rendered as plain HTML or embedded as a JavaScript string
 * (where `<` becomes `\x3c` and `"` becomes `\"`). Extracts the first integer
 * found in the element's text. Handles all observed phrasings:
 *   "10 results", "About 164 results", "Ungefähr 87.500 Ergebnisse", "1 result", ...
 */
function tryResultStatsByMarker(body) {
  // Match either `result-stats">` or `result-stats\">` (escaped form in JS string).
  const re = /result-stats[\\"']*>([^<\\]*)/;
  const m = body.match(re);
  if (!m) return null;
  const numMatch = m[1].match(/\d[\d.,\u00A0\u202F\s]*/);
  if (!numMatch) return null;
  const digits = numMatch[0].replace(/[^\d]/g, '');
  if (!digits) return null;
  return parseInt(digits, 10);
}

/**
 * Last-resort heuristic: count visible result blocks. Modern Google sometimes
 * omits the exact count for low-volume queries but still renders results with
 * `data-rpos="N"` attributes. Returned as approximate (UI shows "N+").
 */
function tryResultBlockCount(body) {
  const matches = body.match(/data-rpos="\d+"/g);
  if (!matches || matches.length === 0) return null;
  // Dedupe (same rpos can appear in multiple sub-elements)
  const positions = new Set(matches.map(m => m.match(/\d+/)[0]));
  return positions.size;
}

/**
 * Parse a Google search response into a normalized result.
 *
 * Input: { url: string, body: string } — response URL (post-redirects) and body text.
 * Output (one of):
 *   { captcha: true }                 - Google asked for verification
 *   { count: number }                 - parsed count (could be 0)
 *   { error: 'unrecognized-response' } - couldn't extract count or detect CAPTCHA
 *
 * Detection order per spec §6.3.2: CAPTCHA → count → zero-results → unrecognized.
 */
export function parseSearchResponse({ url, body }) {
  // 1. CAPTCHA
  if (containsAny(url, GOOGLE.captchaUrlPatterns)) return { captcha: true };
  if (containsAny(body, GOOGLE.captchaBodyPatterns)) return { captcha: true };
  const title = titleText(body).toLowerCase();
  if (containsAny(title, GOOGLE.captchaTitleMarkers.map(s => s.toLowerCase()))) {
    return { captcha: true };
  }

  // 2. Count via id="result-stats" - substring match handles both plain HTML
  //    and JS-string-escaped form (\x3cdiv id=\"result-stats\">). This is the
  //    most reliable path for modern Google responses.
  const statsByMarker = tryResultStatsByMarker(body);
  if (statsByMarker !== null) return { count: statsByMarker };

  // 2b. Legacy id-based DOM-style lookup (kept for fixture compatibility).
  const statsText = textOfElementById(body, GOOGLE.resultStatsSelector);
  if (statsText !== null) {
    const n = parseLocaleNumber(statsText);
    if (n !== null) return { count: n };
  }

  // 2c. Locale text-pattern fallback ("About X results", "Ungefähr X Ergebnisse", ...)
  const fallbackCount = tryResultCountPatterns(body);
  if (fallbackCount !== null) return { count: fallbackCount };

  // 3. Zero results markers
  if (containsAny(body, GOOGLE.zeroResultsMarkers)) return { count: 0 };

  // 3b. Last-resort: count visible result blocks (Google sometimes hides exact counts).
  const blockCount = tryResultBlockCount(body);
  if (blockCount !== null && blockCount > 0) return { count: blockCount, approximate: true };

  // 4. Unrecognized
  return { error: 'unrecognized-response' };
}

/**
 * Fetch a Google search query and return the parsed result.
 * Sequential — call this from the throttled queue, never directly in parallel.
 *
 * Returns the same shape as parseSearchResponse, plus:
 *   { error: '<network-error-message>' } on fetch failure / timeout / non-200.
 */
export async function fetchCount(query, { timeoutMs = 30000 } = {}) {
  const params = new URLSearchParams({ q: query, ...GOOGLE.searchParams });
  const url = `${GOOGLE.searchUrl}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { error: `timeout after ${timeoutMs}ms` };
    return { error: `fetch-failed: ${e.message}` };
  }
  clearTimeout(timer);

  // Read body even on non-200 — Google often serves CAPTCHA pages with non-OK status.
  const body = await response.text().catch(() => '');
  const parsed = parseSearchResponse({ url: response.url, body });

  // If the body looks like a CAPTCHA, surface that regardless of status.
  if (parsed.captcha) return parsed;

  if (!response.ok) {
    // 429 is rate-limiting. Treat as CAPTCHA so the throttle pauses and the
    // user gets the recovery banner (Open verification page + Resume).
    if (response.status === 429) return { captcha: true };
    return { error: `http-${response.status}` };
  }

  // Persist a snapshot for unrecognized responses to aid future debugging
  if (parsed.error === 'unrecognized-response' && typeof chrome !== 'undefined' && chrome.storage) {
    try {
      await chrome.storage.local.set({
        'debug:lastUnrecognized': {
          url: response.url,
          body: body.slice(0, 200_000),
          at: Date.now(),
        },
      });
    } catch { /* storage may be unavailable in tests; ignore */ }
  }

  return parsed;
}
