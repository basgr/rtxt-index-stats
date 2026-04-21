/**
 * Parse a robots.txt body and return the Disallow rules that apply to
 * Googlebot and to the wildcard "*" User-agent block.
 *
 * Output shape: { googlebot: string[], wildcard: string[] }
 *
 * Empty Disallow values, Allow/Sitemap/Crawl-delay/Host directives,
 * and comments are ignored. See spec §6.1.
 */
export function parse(text) {
  const lines = stripBom(text).split(/\r?\n/);
  const groups = [];
  let current = null;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (line === '') {
      // blank line ends the current group
      current = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === 'user-agent') {
      if (!current) {
        current = { agents: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (directive === 'disallow') {
      if (!current) continue; // disallow with no preceding user-agent: malformed, ignore
      if (value === '') continue; // empty value = "allow everything", drop
      current.disallows.push(value);
    }
    // all other directives ignored
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
