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
 * Normalize a list of patterns and merge duplicates by query string.
 * Returns array of {kind, query?, verifyUrl?, reason?, raw, variants}.
 * `variants` lists all raw patterns that collapsed into this row.
 */
export function normalizeAndDedupe(host, rawPatterns) {
  const queryable = new Map(); // query → { ...row, variants: [] }
  const skipped = [];
  for (const raw of rawPatterns) {
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
  return [...queryable.values(), ...skipped];
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
