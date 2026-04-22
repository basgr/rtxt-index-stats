/**
 * Parse a robots.txt body and return the Disallow rules that apply to
 * Googlebot and to the wildcard "*" User-agent block.
 *
 * Output shape: { googlebot: string[], wildcard: string[] }
 *
 * Empty Disallow values, Allow/Sitemap/Crawl-delay/Host directives,
 * and comments are ignored.
 *
 * Grouping + tokenization match Google's open-source reference parser:
 *   https://github.com/google/robotstxt
 * Specifically:
 *  - All three line endings (\n, \r\n, bare \r) are recognized.
 *  - Blank lines inside a group are insignificant; a group is sealed
 *    only when a new `User-agent:` follows any body directive.
 *  - The `User-agent:` value is reduced to its product token by reading
 *    `[A-Za-z_-]+`, so `Googlebot/2.1` and `Googlebot Images` both match
 *    `googlebot`. `*` is recognized as the global token even with junk
 *    after it (`User-agent: * ignored`).
 *  - Common directive typos are tolerated (`disalow`, `dissallow`,
 *    `diasllow`, `disallaw`, `dissalow`, `useragent`, `user agent`).
 */

const DISALLOW_TYPOS = new Set([
  'disallow', 'disalow', 'dissallow', 'diasllow', 'disallaw', 'dissalow',
]);

const USER_AGENT_TYPOS = new Set([
  'user-agent', 'useragent', 'user agent',
]);

export function parse(text) {
  // Bare \r is a valid line terminator per the original Mac convention and
  // Google's parser still accepts it. Match \r\n first to avoid splitting it.
  const lines = stripBom(text).split(/\r\n|\r|\n/);
  const groups = [];
  let current = null;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const directive = canonicalDirective(line.slice(0, colon));
    const value = line.slice(colon + 1).trim();

    if (directive === 'user-agent') {
      const token = uaToken(value);
      if (!token) continue;
      // Start a new group only if the previous one has body content.
      // Consecutive User-agent lines (with optional blanks between) pile
      // into the same group — standard multi-agent block.
      if (!current || current.hasBody) {
        current = { agents: [], disallows: [], hasBody: false };
        groups.push(current);
      }
      current.agents.push(token);
    } else if (directive === 'disallow') {
      if (!current) continue; // disallow with no preceding user-agent: malformed
      current.hasBody = true;
      if (value === '') continue; // empty value = "allow everything"
      current.disallows.push(value);
    } else {
      // Allow / Sitemap / Crawl-delay / Host / unknowns: not stored, but
      // they do seal the group so the next User-agent starts a new one.
      if (current) current.hasBody = true;
    }
  }

  const googlebot = [];
  const wildcard = [];
  for (const group of groups) {
    if (group.agents.includes('googlebot')) googlebot.push(...group.disallows);
    if (group.agents.includes('*')) wildcard.push(...group.disallows);
  }
  return { googlebot, wildcard };
}

/** Lowercase, trim, and map common typos to the canonical directive name. */
function canonicalDirective(raw) {
  const d = raw.trim().toLowerCase();
  if (USER_AGENT_TYPOS.has(d)) return 'user-agent';
  if (DISALLOW_TYPOS.has(d)) return 'disallow';
  return d;
}

/**
 * Reduce a User-agent value to the product token Google's parser uses for
 * matching: read [A-Za-z_-]+ from the start. `*` is a literal global token
 * and may have trailing junk we ignore.
 */
function uaToken(value) {
  const v = value.trim();
  if (v.startsWith('*')) return '*';
  const m = v.match(/[A-Za-z_-]+/);
  return m ? m[0].toLowerCase() : '';
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function stripComment(line) {
  const i = line.indexOf('#');
  return i === -1 ? line : line.slice(0, i);
}
