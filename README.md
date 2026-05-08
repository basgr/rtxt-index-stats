# Robots Disallow Checker

This extension fetches the site's robots.txt, extracts the Disallow rules that apply to Googlebot, converts each one into a Google `site:` query, and shows how many URLs Google keeps in their index under each disallowed pattern.

Because: A site can ask Googlebot not to crawl certain paths, but those URLs can still end up in the index. This tool makes it easy to spot where that's happening at scale.

![Toolbar icon](icons/icon-128.png)

---

## Table of contents

- [Install](#install)
- [The UI](#the-ui)
- [Robots.txt parsing](#robotstxt-parsing)
- [Pattern normalization: deep dive](#pattern-normalization-deep-dive)
- [Google query execution](#google-query-execution)
- [State and storage](#state-and-storage)
- [Development](#development)
- [File map](#file-map)
- [Known limitations](#known-limitations)

---

## Install

**From the Chrome Web Store (recommended):**
[Click here]([https://chromewebstore.google.com/detail/robots-disallow-checker/dbpjmgbbackcbapklemkioiincppmooi](https://basgr.io/rtxt-chrome))

One-click install, auto-updates with new releases.

**From source (for development or to run an unreleased build):**

1. Get the code: `git clone https://github.com/basgr/rtxt-index-stats.git`, or download via **<> Code > Download ZIP** and unzip.
2. Open `chrome://extensions` and toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the project directory.
4. Pin the extension. Click the toolbar icon while on any http(s) page.

---

## The UI

The results tab has five columns:

| Column | Meaning |
|---|---|
| **Pattern** | The raw Disallow line from `robots.txt`, with a `+N` badge if multiple rules collapsed into this row (hover to see the other variants). |
| **Query** | The Google search we ran. Click **↗** in the Actions column to re-run it in a real Google tab. |
| **Results** | Indexed count. A `~` prefix means the count is approximate (see [approximate results](#exact-vs-approximate)). A dash means the row hasn't been queried yet, errored, or is a "skipped" rule. |
| **Last fetched** | When the row last resolved: `pending`, `fetching`, `✓ just now`, `✓ <timestamp>` (cached), `⏸ stopped`, `⛔ CAPTCHA`, `✗ <error>`, or `⚠ <reason>` for skipped rows. |
| **Actions** | **↗** opens the Google query in a new tab. **↻** refreshes just this row (bypasses cache, goes to the front of the throttle queue). |

Header buttons:

- **⏸ Stop** — halt the run; unfinished rows become `stopped`. Visible only while a run is executing.
- **▶ Resume** — pick up where Stop left off. Visible only when there are stopped rows.
- **↺ Re-scan** — re-read `robots.txt` and rebuild the run. **Cache is kept**, so previously answered rows hit cache instantly. Useful after the site changes `robots.txt` or for re-auditing without paying the full query cost.
- **↻ Refresh all** — wipe cache and state, re-run everything. Expensive.

Banners (at most one visible at a time, driven by run state):

- **⚠ Large run** — fires when more than 50 uncached rules need to be queried. See [Rate limiting](#rate-limiting) for what that costs in time. Click *Start run* to proceed, or just close the tab.
- **⛔ CAPTCHA** — Google blocked us. See [CAPTCHA recovery](#captcha-recovery).

Footer: total indexed count across queried rows and export buttons. **📋 Copy TSV** / **📋 Copy MD** copy the visible table for pasting into a spreadsheet or doc. The total carries a `~` prefix when any contributing row is approximate. The **Only indexed (> 0)** checkbox filters zero-count, skipped, and errored rows out of the export. **🐛 Copy Debug** is only needed if a row shows `unrecognized-response` — it copies the saved Google response body so the parser can be updated.

---

## Robots.txt parsing

The fetch layer (`lib/robots-fetch.js`) handles the common failure modes explicitly so you can tell them apart on the meta row:

| `robotsStatus` | What it means |
|---|---|
| `ok` | HTTP 200, plain text body. Parsed. |
| `notFound` | HTTP 404. No crawl restrictions declared. |
| `authRequired` | HTTP 401/403. Can't evaluate. |
| `temporaryError` | 5xx, treated as inconclusive. |
| `invalidContent` | Response isn't text (often HTML soft-404). |
| `redirectError` | Too many redirects, or redirected off-host. |
| `networkError` | DNS/TLS/connection failure. |
| `timeout` | Didn't respond within 15s. |

On `ok`, the parser (`lib/robots-parser.js`) pulls out the `Disallow` and `Allow` values from every `User-agent: Googlebot` block and every `User-agent: *` block, strips BOM and inline `#` comments, and drops empty-valued lines. The two lists are concatenated and deduped in-order before being handed to the normalizer.

`Allow:` rules carve out exceptions from broader Disallows — see [Allow exceptions](#10-allow-exceptions) below. Other crawler blocks (Bingbot, etc.) and other directives (`Sitemap`, `Crawl-delay`, `Host`) are out of scope — see [Known limitations](#known-limitations).

### Compatibility with Google's reference parser

Tokenization and grouping match Google's open-source [robots.txt parser](https://github.com/google/robotstxt). Specifically:

- All three line endings work: `\n`, `\r\n`, and bare `\r` (classic Mac).
- Blank lines inside a group are insignificant. A group seals only when a new `User-agent:` follows any body directive — so files like `github.com/robots.txt` that put a blank line between `User-agent: *` and its first `Disallow:` parse correctly.
- The `User-agent:` value is reduced to its product token via `[A-Za-z_-]+`. So `Googlebot/2.1` and `Googlebot Images` both match `googlebot`. `*` is the global token even with trailing junk (`User-agent: * ignored`).
- Common directive typos are tolerated: `Disalow`, `Dissallow`, `Diasllow`, `Disallaw`, `Dissalow`, `useragent`, `user agent`. They're treated as their canonical forms — same as Google does.

What we **don't** do that Google does, and the implication:

- Google's contract: if any Googlebot-specific group exists, the `*` group is ignored entirely for Googlebot. We instead concatenate `*` + `Googlebot` rules. That gives a **conservative bias** for an audit tool — we may report a URL as Disallowed that Googlebot is in fact allowed to crawl. False positives, never false negatives. Worth keeping in mind when reading the report.

---

## Pattern normalization: deep dive

Each `Disallow` line describes a URL pattern. The normalizer in `lib/pattern-normalize.js` classifies every pattern and emits one of:

```js
{ kind: 'queryable', query, verifyUrl, raw, approximate }
{ kind: 'skipped',   reason, raw }
```

Then `normalizeAndDedupe` merges rows that produce the same query, preserving the *widest* variant as the displayed `raw` and keeping the rest in a `variants` array (rendered as the `+N` hover badge).

### Exact vs. approximate

Google's search operators don't perfectly mirror robots.txt semantics, so every row carries an `approximate` flag:

- **`site:host/path`** is a *prefix match* — it will return `/path`, `/path/`, `/path/anything/...`. For a plain-prefix disallow that's exactly what we want; the count is an **upper bound** on URLs covered by the rule.
- **`inurl:term`** is a *substring match* that's case-insensitive. When the disallow has a mid-path wildcard, we use `inurl:` to approximate — but substring matching over-matches (any URL containing `term` anywhere, not just at the wildcard position). Loose match, usually an overestimate.
- **`$` end-of-URL anchor** means *exact match only* in robots.txt. We can't express that in Google's operators, so we drop the anchor and mark the row approximate.

A `~` prefix on the Results cell signals an approximate count to the reader; hovering the cell shows the reason.

### 1. Site-wide rules → skipped

| Pattern | Why skipped |
|---|---|
| `/` | Disallows the whole site. Not informative — a `site:host` count is just "how many URLs are indexed", independent of the rule. |
| `*` | Same as `/` semantically. |
| *empty* | "Allow everything"; dropped by the parser upstream, but the normalizer also guards. |

Skipped rows show in the table with a `⚠ <reason>` status and dashes in Results.

### 2. Plain path prefix

| Pattern | Query | Approximate? |
|---|---|---|
| `/api` | `site:host/api` | no |
| `/api/` | `site:host/api/` | no |
| `/api/*` | `site:host/api/` | no |
| `/private/data` | `site:host/private/data` | no |
| `/search*` | `site:host/search` | no |
| `/de/search*` | `site:host/de/search` | no |
| `/search*/` | `site:host/search` | no |
| `/tag*/` | `site:host/tag` | no |

Trailing slashes are **preserved**, because in robots.txt `/api/` and `/api` are different rules:
- `Disallow: /api/` only blocks URLs under `/api/…` (e.g. `/api/users`).
- `Disallow: /api` blocks those plus `/api`, `/api.html`, `/api-legacy`, etc. — wider.

So `/api` becomes `site:host/api` (wide prefix) and `/api/` becomes `site:host/api/` (narrow prefix). `/api/*` is equivalent to `/api/` (the `*` matches anything including empty), so those two collapse into one row with a `+1` badge. `/api` stays in its own row.

`/search*` / `/tag*/` are trailing-wildcard patterns where there's no natural trailing slash in the prefix; they behave like broad prefixes.

This is the case where Google's `site:` operator cleanly matches the robots.txt pattern, so rows aren't marked approximate.

### 3. End-of-URL anchor (`$`)

| Pattern | Query | Approximate? |
|---|---|---|
| `/ro/cautare-harta$` | `site:host/ro/cautare-harta` | **yes** |
| `/foo$` | `site:host/foo` | **yes** |

The `$` means "this URL exactly, nothing longer." Google's `site:` can't express an exact URL, so we query the prefix and flag the row approximate — the count will include `/foo/anything` as well. Over-counts.

### 4. Filetype suffix

| Pattern | Query | Approximate? |
|---|---|---|
| `/*.pdf$` | `site:host filetype:pdf` | no |
| `*.json$` | `site:host filetype:json` | no |
| `/*.PDF$` | `site:host filetype:pdf` (lowercased) | no |
| `/img/*.jpg` | `site:host/img/ filetype:jpg` | no |
| `/img/*.PNG` | `site:host/img/ filetype:png` | no |
| `/img/*-wWIDTH*.jpg` | `site:host/img/ filetype:jpg inurl:wwidth` | yes |

Anywhere the wildcard segments include a literal `.ext`, it becomes `filetype:ext`. The pattern can be anchored at root (`*.json$`) or scoped to a subdirectory (`/img/*.jpg`). Extensions are lowercased so `*.JPG` and `*.jpg` dedupe.

### 5. Mid-path wildcard → `inurl:`

| Pattern | Query | Approximate? |
|---|---|---|
| `/private/*/edit` | `site:host/private/ inurl:edit` | yes |
| `/foo/*bar` | `site:host/foo/ inurl:bar` | yes |
| `/energieloesungen/*-form/` | `site:host/energieloesungen/ inurl:form` | yes |
| `/energieloesungen/social/*-form/` | `site:host/energieloesungen/social/ inurl:form` | yes |
| `/foo/*/bar/*/baz` | `site:host/foo/ inurl:bar inurl:baz` | yes |
| `/foo/*bar*bar` | `site:host/foo/ inurl:bar` (deduped) | yes |

The pattern is split on `*`. The first segment (if it starts with `/`) becomes a path prefix for `site:`. Every subsequent literal segment is sanitized — surrounding non-alphanumeric chars stripped, lowercased — and becomes an `inurl:` term. Duplicate terms are deduped.

Always approximate because `inurl:` is substring-based: a URL like `/private/reports/edit-history` would match `inurl:edit` even though it doesn't match the robots pattern.

### 6. Wildcard prefix

| Pattern | Query | Approximate? |
|---|---|---|
| `*/feed/*` | `site:host inurl:feed` | yes |
| `*/feed` | `site:host inurl:feed` | yes |

When the pattern doesn't start with `/`, there's no path prefix — every literal segment becomes an `inurl:` term against the full site.

### 7. Query-string patterns

| Pattern | Query | Approximate? |
|---|---|---|
| `/*?config` | `site:host inurl:config` | yes |
| `/*?config=foo` | `site:host inurl:config inurl:foo` | yes |
| `/*?ajax&wid` | `site:host inurl:ajax inurl:wid` | yes |
| `/foo/*?bar=baz` | `site:host/foo/ inurl:bar inurl:baz` | yes |
| `/*?noredirect=true&config=standalone` | `site:host inurl:noredirect inurl:true inurl:config inurl:standalone` | yes |

The pattern is split at the first `?`. The left side's first segment (if it starts with `/`) becomes the path prefix. The right side is tokenized on `&` and `=`; every non-empty token becomes an `inurl:` term.

Approximate — `inurl:` doesn't distinguish between "in the query string" and "in the path", so a URL with `/config-guide` would match `inurl:config` even though the rule targets `?config=...` URLs.

### 8. URL-encoded (UTF-8) paths

| Pattern | Query |
|---|---|
| `/ru/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA` | `site:host/ru/поиск` |
| `/bg/%D0%BB%D0%B0%D0%B3%D0%B5%D1%80/*/media$` | `site:host/bg/лагер/ inurl:media` |
| `/hu/taborhely/*/%C3%A9rdekl%C5%91dik/*` | `site:host/hu/taborhely/ inurl:érdeklődik` |

Percent-encoded UTF-8 is decoded before building the query, both in path prefixes and in `inurl:` terms. The sanitizer uses Unicode-aware regexes (`\p{L}\p{N}`) so non-ASCII letters like `é`, `ő`, Cyrillic `п`, etc. are preserved.

### 9. Unsupported

A pattern that doesn't match any of the above (e.g., `?` with no extractable tokens, wildcards with no usable suffix) is marked `skipped` with `reason: 'unsupported pattern shape'`.

### 10. Allow exceptions

A `Disallow:` rule can be carved by one or more `Allow:` rules under the same User-agent block (AEM-driven sites and many CMSes use this pattern):

```
User-agent: *
Disallow: /content/
Allow: /content/dam/assets/pricelists/
Allow: /content/dam/assets/marketplace/
```

The normalizer attributes each Allow to the longest matching Disallow path (per robots.txt longest-match semantics) and appends it to that row's query as a `-inurl:` exclusion:

| Pattern | Query | Approximate? |
|---|---|---|
| `Disallow: /content/` (with the two Allows above) | `site:host/content/ -inurl:/content/dam/assets/pricelists/ -inurl:/content/dam/assets/marketplace/` | **yes** |

The row gets a **−N** badge in the Pattern column showing how many Allows were applied (hover for the full list). The row is also flagged approximate, because `-inurl:` is substring-based — it can over-exclude URLs that contain the path fragment elsewhere.

**Cap and overflow.** Up to **10** exclusions per query (Google's `q=` parameter has a practical ~2K char limit; 10 leaves headroom). Anything beyond is listed in `droppedAllows` and surfaced as a `⚠` marker in the badge tooltip — when overflowed, the count is an upper bound for the dropped paths.

**Attribution rules.**
- An Allow path is attributed to the Disallow whose anchor (the path before any wildcard) is the longest prefix of the Allow path.
- Orphan Allows (no matching Disallow prefix) are silently dropped.
- An Allow that exactly equals a Disallow's anchor *fully nullifies* the Disallow — the row is moved to skipped with reason `fully allowed by Allow: <path>`.
- `$`-anchored Disallows have no usable anchor (they match an exact URL only), so they don't receive Allow attribution.

**v1 limitations.** Only plain-prefix Allows are applied. Allows with mid-path wildcards (`Allow: /content/*/public/`) or filetype anchors (`Allow: /*.css$`) are silently dropped — the Disallow row's count remains an upper bound for the URLs they would have carved out.

### 11. Deduplication across variants

`normalizeAndDedupe` groups rows by their Google `query` string. When multiple Disallow lines produce the same query, they collapse:

- The displayed `raw` is the *widest* variant — non-`$` beats `$`, and among equally-anchored patterns, shorter beats longer.
- Other variants go into `row.variants` and render as a `+N` hover badge.
- The row's `approximate` flag is recomputed from the widest variant. So `/hr/account$` + `/hr/account` produces one non-approximate row (the widest is `/hr/account`, which is a clean prefix).

---

## Google query execution

The fetcher (`lib/google-fetch.js`) hits `https://www.google.com/search?q=<query>&filter=0` with the browser's normal cookies and user agent. It parses the response in this priority order:

1. **CAPTCHA detection** — if the URL or body contains `sorry/index` / `captcha` / `unusual traffic` markers, return `{ captcha: true }`.
2. **HTTP 429** — treated as CAPTCHA (also triggers the throttle pause + banner).
3. **Exact count via `result-stats` marker** — the primary path. Looks for a `result-stats` attribute in either plain HTML or JS-escaped form (`\x3cdiv id=\"result-stats\">`) and pulls the first decimal-looking run out of its text.
4. **Fallback: ID-based lookup** — the older `<div id="result-stats">About 164 results</div>` form.
5. **Fallback: text pattern** — "About N results" / "N results" matching directly.
6. **Zero-result markers** — known "did not match any documents" strings → `{ count: 0 }`.
7. **Block-count fallback** — counts visible search result containers when Google doesn't show a total. Marked `approximate: true`.
8. **Unrecognized** — snapshots the body to `chrome.storage.local['debug:lastUnrecognized']` so you can click **🐛 Copy Debug** in the footer and paste it back. That's the hook for extending the parser when Google changes their HTML.

Request timeout is 30s (AbortController). On error the row goes to `error` status with the HTTP or network reason.

### Rate limiting

Queries are serialized through a single throttle (`lib/throttle.js`) with a **random 10–30 second delay** between every request. The delay is scheduled via `chrome.alarms` so the MV3 service worker can be killed between requests without losing the queue. Cache hits bypass the throttle entirely.

That cap means a 50-rule run takes **8–25 minutes** of wall time, and a 100-rule run takes **17–50 minutes**. Anything over 50 uncached rules gets gated behind the **⚠ Large run** banner so you can choose to wait or close the tab.

### CAPTCHA recovery

When Google decides our traffic looks too bot-like, it serves a CAPTCHA page. The parser detects this (URL contains `sorry/index`, body contains `unusual traffic`, or HTTP 429) and:

1. The throttle pauses — no more requests go out.
2. The blocked row gets `⛔ CAPTCHA` status.
3. The **⛔ CAPTCHA** banner shows up in the UI with two buttons.

To recover: click *Open verification page*, solve the CAPTCHA in that real Google tab, then come back to the results tab and click *Resume*. The blocked row goes to the front of the queue and the throttle resumes.

CAPTCHA is unavoidable at scale; expect to solve one or two during a large audit.

---

## State and storage

Every host has one persisted run record (`run:<host>`) and a per-query result cache (`cache:<host>:<query>`), both in `chrome.storage.local`. Results are cached for **7 days**.

The run carries a single `runStatus` — `running`, `awaiting-confirmation`, `paused-stopped`, `paused-captcha`, or `done` — that drives which banners and buttons the UI shows.

Two behaviors worth knowing:

- **Opening the tab never starts work.** The extension only fetches when you press *Start*, *Resume*, *Refresh all*, *Re-scan*, or a row's `↻`. Reopening replays the persisted state — banners, rows, and buttons reflect where the run was when you last left it.
- **Paused runs stay paused** across service-worker restarts. Only `running` rows auto-resume on SW boot.

**Re-scan** vs **Refresh all**: Re-scan re-reads `robots.txt` and rebuilds the run but keeps the result cache, so already-answered rows return instantly. Refresh all wipes the cache too and re-queries every rule from scratch.

---

## Development

```bash
npm test   # run the Node test suite (88 tests, no deps)
```

Tests use Node's built-in test runner. They cover the pattern normalizer, the robots parser, the Google-response parser, and the HTML helpers. Everything else (orchestrator, fetch, Chrome APIs) is exercised manually in Chrome.

There is no build step and no runtime dependency. The project is vanilla JS ES modules; the service worker loads `background.js` with `"type": "module"` and the results page loads `results.js` with `<script type="module">`.

---

## File map

```
rtxt-index-stats/
├── manifest.json              # MV3: permissions, action, service worker
├── background.js              # SW entry: icon click, message router, boot resume
├── results.html               # results tab markup
├── results.css                # results tab styles
├── results.js                 # results tab logic: banners, buttons, row upsert
├── icons/                     # toolbar + extension icons
├── lib/
│   ├── robots-fetch.js        # HTTP fetch + status classification
│   ├── robots-parser.js       # text → { googlebot[], wildcard[] }
│   ├── pattern-normalize.js   # disallow line → Google query (+ dedupe)
│   ├── google-fetch.js        # search request + response parsing
│   ├── google-selectors.js    # constants for result-stats markers
│   ├── html-helpers.js        # small HTML parsing utilities
│   ├── cache.js               # chrome.storage.local wrapper (7-day TTL)
│   ├── throttle.js            # chrome.alarms-backed serial queue
│   └── orchestrator.js        # run lifecycle, state machine, broadcasts
└── test/
    ├── pattern-normalize.test.js
    ├── robots-parser.test.js
    ├── google-fetch-parse.test.js
    ├── html-helpers.test.js
    └── fixtures/
```

---

## Known limitations

- **Other crawlers and other directives are out of scope.** Only `User-agent: Googlebot` and `User-agent: *` blocks are read. `Sitemap:`, `Crawl-delay:`, and `Host:` are ignored. `Allow:` IS handled for plain-prefix carve-outs (see [Allow exceptions](#10-allow-exceptions)); Allows with mid-path wildcards or filetype anchors are silently dropped, so the Disallow row's count stays an upper bound for those carve-outs.
- **Google is a prefix-matcher, robots.txt isn't quite.** See the [exact vs. approximate](#exact-vs-approximate) discussion above. Counts marked with `~` or with a `$` variant in the `+N` badge should be read as upper / lower bounds, not exact.
- **Google's result counts are inherently fuzzy.** Google sometimes reports "About N results" that changes between requests. Counts near zero and very large counts are more reliable than mid-range ones.
- **Single Chrome profile.** The fetch goes out with whatever cookies + UA the user has in Chrome. Running from a profile that's signed into Google is fine; running from one that isn't is also fine. The counts are public.

---

## Privacy

No data collection, no telemetry, no remote logging. The extension only fetches the site's `robots.txt` and runs Google search queries through your normal browser session. See [PRIVACY.md](PRIVACY.md) for details.

## License

MIT — see [LICENSE](LICENSE).
