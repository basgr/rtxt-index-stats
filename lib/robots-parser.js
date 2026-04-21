/**
 * Parse a robots.txt body and return the Disallow rules that apply to
 * Googlebot and to the wildcard "*" User-agent block.
 *
 * Output shape: { googlebot: string[], wildcard: string[] }
 *
 * Empty Disallow values, Allow/Sitemap/Crawl-delay/Host directives,
 * and comments are ignored. See spec §6.1.
 *
 * Grouping semantics match Google's parser: blank lines inside a group
 * are insignificant. A group is a run of consecutive `User-agent:` lines
 * followed by directives; the group ends when a new `User-agent:` line
 * appears AFTER any body directive (Disallow, Allow, Crawl-delay, …).
 * This matters for files like github.com/robots.txt that put a blank
 * line between `User-agent: *` and its first `Disallow:`.
 */
export function parse(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const groups = [];
  let current = null;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === 'user-agent') {
      // Start a new group only if the previous one has body content.
      // Consecutive User-agent lines (with optional blanks between) pile
      // into the same group — standard multi-agent block.
      if (!current || current.hasBody) {
        current = { agents: [], disallows: [], hasBody: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (directive === 'disallow') {
      if (!current) continue; // directive with no preceding user-agent: malformed
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

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function stripComment(line) {
  const i = line.indexOf('#');
  return i === -1 ? line : line.slice(0, i);
}
