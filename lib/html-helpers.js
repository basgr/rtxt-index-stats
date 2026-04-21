/**
 * Small string/regex helpers for parsing Google's search response HTML
 * without DOMParser (which is browser-only). Sufficient for the narrow
 * set of operations we need: find element by id, get title, check substring,
 * parse locale-formatted integers.
 */

const STRIP_TAGS = /<\/?[^>]+>/g;
const COLLAPSE_WS = /\s+/g;

/**
 * Find the first element with `id="<id>"` and return its inner text
 * (with HTML tags stripped and whitespace collapsed).
 * Returns null if no such element exists.
 */
export function textOfElementById(html, id) {
  // Match opening tag with the given id, capture until the matching close.
  // Note: this is intentionally simple — Google's #result-stats is a flat
  // <div> with text + a <nobr> child, no nesting we care about.
  const escaped = id.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`<([a-zA-Z]+)[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  return m[2].replace(STRIP_TAGS, '').replace(COLLAPSE_WS, ' ').trim();
}

export function titleText(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : '';
}

export function containsAny(haystack, markers) {
  for (const m of markers) {
    if (haystack.includes(m)) return true;
  }
  return false;
}

/**
 * Parse the first integer found in a string, treating ',' '.' ' ' and
 * non-breaking space (U+00A0) and narrow no-break (U+202F) as digit separators.
 * Returns null if no digit sequence is found.
 */
export function parseLocaleNumber(text) {
  const m = text.match(/[\d][\d.,\u00A0\u202F\s]*/);
  if (!m) return null;
  const digitsOnly = m[0].replace(/[^\d]/g, '');
  if (digitsOnly === '') return null;
  return parseInt(digitsOnly, 10);
}
