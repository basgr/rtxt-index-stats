/**
 * Classify a robots.txt Disallow pattern and produce a Google `site:` query.
 *
 * Returns one of:
 *   { kind: 'queryable', query: string, verifyUrl: string, raw: string }
 *   { kind: 'skipped',   reason: string, raw: string }
 *
 * See spec §6.2 for the pattern table.
 */
export function normalize(host, raw) {
  let trimmed = raw.trim();

  if (trimmed === '/' || trimmed === '*' || trimmed === '') {
    return skipped(raw, 'site-wide rule, not informative');
  }

  // Filetype suffix: /*.ext$ or *.ext$  (must be checked before $ is stripped below)
  const ftMatch = trimmed.match(/^\/?\*\.([a-zA-Z0-9]+)\$$/);
  if (ftMatch) {
    const ext = ftMatch[1].toLowerCase();
    const query = `site:${host} filetype:${ext}`;
    return queryable(raw, query, host);
  }

  // End-of-URL anchor (`$`): means "exact match only" in robots.txt. We approximate
  // via site: prefix and flag the row approximate (over-counts URLs sharing the prefix).
  let endAnchored = false;
  if (trimmed.endsWith('$')) {
    trimmed = trimmed.slice(0, -1);
    endAnchored = true;
  }

  // Plain path prefix: leading /, no wildcards in the middle, optional trailing / or /*
  // Trailing slash is PRESERVED — in robots.txt, `/foo/` and `/foo` are different
  // rules: `/foo/` only blocks URLs under `/foo/...`, `/foo` also blocks `/foo`,
  // `/foo.html`, `/foo-bar`, etc. Google `site:host/foo/` narrows to URLs with the
  // trailing slash, matching the robots rule's intent.
  const cleanPrefix = stripTrailingWildcard(trimmed);
  if (isPlainPrefix(cleanPrefix)) {
    const decoded = decodePathSafe(cleanPrefix);
    const query = `site:${host}${decoded}`;
    return queryable(raw, query, host, endAnchored);
  }

  // Query-string pattern: anything with `?`. Split into path + query parts and
  // tokenize. /*?config=foo -> site:host inurl:config inurl:foo (approximate).
  if (trimmed.includes('?')) {
    const qsQuery = buildQueryStringInurl(host, trimmed);
    if (qsQuery) return queryable(raw, qsQuery, host, true);
    // No tokens after the `?` (e.g. /web/de/shop?). The rule semantically means
    // "URLs starting with this prefix and having any query string". We can't
    // express the query-string requirement, so fall back to the plain prefix
    // and mark approximate (over-counts URLs without a `?` too).
    const pathPart = trimmed.slice(0, trimmed.indexOf('?'));
    const cleanPath = stripTrailingWildcard(pathPart);
    if (isPlainPrefix(cleanPath)) {
      const decoded = decodePathSafe(cleanPath);
      return queryable(raw, `site:${host}${decoded}`, host, true);
    }
    return skipped(raw, 'query-string wildcard');
  }

  // Any other pattern with wildcards: split on `*`, build a `site:` + `inurl:` query.
  // Handles /foo/*-bar/, */feed/*, *tracker*, /foo/*/bar/*/baz, etc. Marked approximate
  // because site: is prefix-only and inurl: is substring-only (loose match).
  if (trimmed.includes('*')) {
    const inurlQuery = buildInurlQuery(host, trimmed);
    if (inurlQuery) return queryable(raw, inurlQuery, host, true);
  }

  return skipped(raw, 'unsupported pattern shape');
}

/**
 * Build an approximate `site:host[/prefix] inurl:X inurl:Y ...` query from a
 * wildcard pattern. Splits on `*`, uses the first segment as a path prefix if
 * it starts with `/`, and treats other literal segments as `inurl:` substring
 * terms. Returns null if no usable inurl term can be extracted.
 */
function buildInurlQuery(host, trimmed) {
  const segments = trimmed.split('*');
  let sitePath = '';
  const inurlTerms = [];
  let filetype = null;
  const seen = new Set();

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i === 0 && seg.startsWith('/')) {
      sitePath = decodePathSafe(seg);
      // Bare `/` is noise in site:host/ — drop it so the query is site:host.
      if (sitePath === '/') sitePath = '';
      continue;
    }
    // Pure file-extension segment (e.g. ".jpg") → use filetype: not inurl:.
    const extMatch = seg.match(/^\.([a-zA-Z0-9]+)$/);
    if (extMatch) {
      filetype = extMatch[1].toLowerCase();
      continue;
    }
    const term = sanitizeInurlTerm(seg);
    if (term && !seen.has(term)) {
      seen.add(term);
      inurlTerms.push(term);
    }
  }

  if (inurlTerms.length === 0 && !filetype) return null;
  const parts = [`site:${host}${sitePath}`];
  if (filetype) parts.push(`filetype:${filetype}`);
  for (const t of inurlTerms) parts.push(`inurl:${t}`);
  return parts.join(' ');
}

/**
 * Build an approximate query for a `?`-containing pattern. Splits the pattern
 * at the first `?`, processes the left side as a path prefix (with optional
 * wildcards), and tokenizes the right side (the query string) by `&` and `=`
 * into `inurl:` substring terms.
 *   /*?config=foo&bar=baz  →  site:host inurl:config inurl:foo inurl:bar inurl:baz
 */
function buildQueryStringInurl(host, trimmed) {
  const qIdx = trimmed.indexOf('?');
  const pathPart = trimmed.slice(0, qIdx);
  const queryPart = trimmed.slice(qIdx + 1);

  let sitePath = '';
  if (pathPart) {
    const firstSeg = pathPart.split('*')[0];
    if (firstSeg.startsWith('/')) {
      sitePath = decodePathSafe(firstSeg);
      if (sitePath === '/') sitePath = '';
    }
  }

  const seen = new Set();
  const terms = [];
  for (const param of queryPart.split('&')) {
    for (const kv of param.split('=')) {
      const term = sanitizeInurlTerm(kv);
      if (term && !seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
  }

  if (terms.length === 0) return null;
  const parts = [`site:${host}${sitePath}`];
  for (const t of terms) parts.push(`inurl:${t}`);
  return parts.join(' ');
}

/**
 * Decode percent-encoded UTF-8, strip non-letter/non-digit chars from the
 * boundaries (Unicode-aware so non-ASCII letters like `é` are preserved),
 * then lowercase. Google's inurl: is case-insensitive, so normalizing to lower
 * gives us dedup across `?service=ajax` vs `?service=Ajax`.
 */
function sanitizeInurlTerm(s) {
  const decoded = decodePathSafe(s);
  return decoded
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .toLowerCase();
}

/**
 * Hard cap on `-inurl:` exclusions appended per row. Google's `q=` parameter
 * handles ~2K chars, each exclusion averages 40-60 chars URL-encoded, so 10
 * leaves comfortable headroom even for long path prefixes. Excess Allow
 * matches are listed in `droppedAllows` and surfaced to the UI as a warning.
 */
const MAX_ALLOW_EXCLUSIONS = 10;

/**
 * Normalize a list of Disallow patterns and merge duplicates by query string.
 * If `rawAllows` is non-empty, attribute each Allow to the longest matching
 * Disallow row (per robots.txt longest-match semantics) and append it to that
 * row's query as a `-inurl:` exclusion. The row is then marked approximate
 * (substring exclusions can over-exclude) and gains `excludedAllows` /
 * `droppedAllows` arrays for UI display.
 *
 * Returns array of {kind, query?, verifyUrl?, reason?, raw, variants,
 * excludedAllows?, droppedAllows?}.
 */
export function normalizeAndDedupe(host, rawDisallows, rawAllows = []) {
  const queryable = new Map(); // query → { ...row, variants: [] }
  const skipped = [];
  for (const raw of rawDisallows) {
    const r = normalize(host, raw);
    if (r.kind === 'queryable') {
      if (queryable.has(r.query)) {
        queryable.get(r.query).variants.push(raw);
      } else {
        queryable.set(r.query, { ...r, variants: [raw] });
      }
    } else {
      skipped.push({ ...r, variants: [raw] });
    }
  }
  // For each merged row, surface the WIDEST variant as the displayed primary
  // (so /hr/account beats /hr/account$, and the $ form goes into the badge).
  // Re-evaluate `approximate` against the widest variant, since the widest
  // pattern determines whether our `site:` query is exact or loose.
  for (const row of queryable.values()) {
    if (row.variants.length > 1) {
      row.variants.sort(byPatternWidth);
      row.raw = row.variants[0];
      const widestNorm = normalize(host, row.variants[0]);
      if (widestNorm.kind === 'queryable') row.approximate = !!widestNorm.approximate;
    }
  }

  // Apply Allow exceptions.
  const queryableRows = [...queryable.values()];
  // Attach an anchor path to each queryable row (used for longest-prefix
  // matching against allows). Rows with no anchor (site-wide, $-anchored,
  // wildcard-prefix patterns) cannot receive carve-outs.
  for (const row of queryableRows) row.__anchor = disallowAnchor(row.raw);

  const normalizedAllows = rawAllows
    .map(raw => normalizeAllow(raw))
    .filter(a => a !== null);

  for (const allow of normalizedAllows) {
    // Find all queryable rows whose anchor is a prefix of (or equals) this
    // allow's path. The row with the longest anchor wins (longest-match).
    const candidates = queryableRows.filter(row =>
      row.__anchor && (allow.path === row.__anchor || allow.path.startsWith(row.__anchor))
    );
    if (candidates.length === 0) continue; // orphan allow — drop
    candidates.sort((a, b) => b.__anchor.length - a.__anchor.length);
    const winner = candidates[0];
    if (allow.path === winner.__anchor) {
      // Allow path equals the disallow anchor → fully nullifies the rule.
      winner.__fullyAllowed = allow.raw;
    } else {
      (winner.__pendingAllows ??= []).push(allow);
    }
  }

  // Apply collected exclusions or convert to skipped if fully nullified.
  for (const row of queryableRows) {
    if (row.__fullyAllowed) {
      // Move from queryable to skipped.
      queryable.delete(row.query);
      skipped.push({
        kind: 'skipped',
        reason: `fully allowed by Allow: ${row.__fullyAllowed}`,
        raw: row.raw,
        variants: row.variants,
      });
      continue;
    }
    const pending = row.__pendingAllows;
    if (pending && pending.length) {
      const applied = pending.slice(0, MAX_ALLOW_EXCLUSIONS);
      const dropped = pending.slice(MAX_ALLOW_EXCLUSIONS);
      row.excludedAllows = applied.map(a => a.raw);
      if (dropped.length) row.droppedAllows = dropped.map(a => a.raw);
      const exclusionParts = applied.map(a => `-inurl:${a.path}`);
      row.query = `${row.query} ${exclusionParts.join(' ')}`;
      row.verifyUrl = `https://www.google.com/search?q=${encodeURIComponent(row.query)}&filter=0`;
      row.approximate = true;
    }
    delete row.__anchor;
    delete row.__pendingAllows;
    delete row.__fullyAllowed;
  }

  return [...queryable.values(), ...skipped];
}

/**
 * Extract the path prefix that a Disallow constrains, for the purpose of
 * Allow attribution. Returns null if the rule has no usable anchor (site-wide,
 * $-anchored exact-match, leading-wildcard, or pure query-string patterns).
 */
function disallowAnchor(raw) {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '*') return null;
  if (trimmed.endsWith('$')) return null; // exact match — Allows can't carve from a single URL
  // Take the substring before the first wildcard or query marker.
  const firstSpecial = trimmed.search(/[*?]/);
  const anchor = firstSpecial === -1 ? trimmed : trimmed.slice(0, firstSpecial);
  if (!anchor.startsWith('/') || anchor === '/') return null;
  return decodePathSafe(anchor);
}

/**
 * Normalize an Allow into { raw, path } if it's a plain-prefix shape
 * (the only allow shape v1 supports for query exclusions). Returns null
 * for site-wide (`/`, `*`), wildcard-bearing, query-string, or filetype
 * allows — they're silently dropped.
 */
function normalizeAllow(raw) {
  let trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '*') return null;
  if (trimmed.endsWith('$')) trimmed = trimmed.slice(0, -1);
  if (trimmed.endsWith('*/')) trimmed = trimmed.slice(0, -2);
  else if (trimmed.endsWith('/*')) trimmed = trimmed.slice(0, -1);
  else if (trimmed.endsWith('*')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.startsWith('/') || /[*?]/.test(trimmed)) return null;
  return { raw: raw.trim(), path: decodePathSafe(trimmed) };
}

/** Sort comparator: widest (most general) pattern first. */
function byPatternWidth(a, b) {
  // Patterns ending with `$` are exact-match — narrowest. Push them last.
  const aDollar = a.endsWith('$') ? 1 : 0;
  const bDollar = b.endsWith('$') ? 1 : 0;
  if (aDollar !== bDollar) return aDollar - bDollar;
  // Among equally-anchored patterns, shorter = wider/cleaner.
  return a.length - b.length;
}

function queryable(raw, query, host, approximate = false) {
  const verifyUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&filter=0`;
  return { kind: 'queryable', query, verifyUrl, raw, approximate };
}

function skipped(raw, reason) {
  return { kind: 'skipped', reason, raw };
}

function stripTrailingWildcard(s) {
  if (s.endsWith('*/')) return s.slice(0, -2); // /search*/ -> /search
  if (s.endsWith('/*')) return s.slice(0, -1); // /api/*    -> /api/ (keep slash)
  if (s.endsWith('*'))  return s.slice(0, -1); // /search*  -> /search
  return s;
}

function isPlainPrefix(s) {
  // Must start with /, contain no *, no ?, no $
  return s.startsWith('/') && !/[*?$]/.test(s);
}

/** Decode percent-encoded UTF-8 in a path. Returns the original on decode failure. */
function decodePathSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}
