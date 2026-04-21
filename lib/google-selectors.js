/**
 * SINGLE source of all Google-specific markers used by google-fetch.js.
 *
 * When Google ships a redesign and counts/CAPTCHA detection breaks:
 *   1. Open https://www.google.com/search?q=site:example.com&filter=0 in a browser.
 *   2. Inspect the result-count element — update `resultStatsSelector` if the id changed.
 *   3. Trigger a CAPTCHA (run many queries fast) — update `captchaUrlPatterns`/`captchaSelectors`.
 *   4. Save the new HTML to test/fixtures/google/ and update tests.
 *
 * No regex compilation or DOM logic in this file. It is pure data.
 */
export const GOOGLE = {
  searchUrl: 'https://www.google.com/search',
  searchParams: { filter: '0' }, // filter=0 disables result deduplication

  resultStatsSelector: 'result-stats', // matched as id="result-stats" in HTML

  // Text-based fallback when id="result-stats" is absent.
  // Each entry is a string source for a regex; the regex must have a capture
  // group containing digits (with optional locale separators).
  // Matched against the response body. Stop at first match.
  resultCountPatterns: [
    'About\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+results?',          // en
    'Ungefähr\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+Ergebniss',     // de
    'Etwa\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+Ergebniss',         // de alt
    'Environ\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+résultat',       // fr
    'Circa\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+risultat',         // it
    'Aproximadamente\\s+([\\d.,\\u00A0\\u202F\\s]+?)\\s+resultado', // es
    // Single-result phrasing (no "About"):
    '\\b1\\s+result\\b',  // en — count is implicitly 1
    '\\b1\\s+Ergebnis\\b', // de
  ],

  // Substring markers in the response body indicating "0 results"
  zeroResultsMarkers: [
    'did not match any documents',
    'stimmt mit keinem Dokument',
    "n'a trouvé aucun document",
  ],

  // Substring markers in URL → CAPTCHA
  captchaUrlPatterns: [
    '/sorry/',
    'google.com/sorry',
  ],

  // Substring markers in body → CAPTCHA
  captchaBodyPatterns: [
    'id="captcha-form"',
    'action="/sorry/',
  ],

  // Substring markers in <title> → CAPTCHA
  captchaTitleMarkers: [
    'unusual',
    'ungewöhnlich',
  ],
};
