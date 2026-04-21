# Robots Disallow Checker

Chrome extension for SEO audits. Click the icon on any http(s) page; the extension fetches the site's `robots.txt`, extracts the Disallow rules that apply to Googlebot, converts each one into a Google `site:` query, and shows how many URLs Google has indexed under each disallowed pattern.

The point: a site can ask Google not to crawl certain paths, but those URLs can still end up in the index. This tool makes it easy to spot where that's happening at scale.

![Toolbar icon](icons/icon-128.png)

---

## Table of contents

- [Install](#install)
- [How it works](#how-it-works)
- [The UI](#the-ui)
- [Robots.txt parsing](#robotstxt-parsing)
- [Pattern normalization: deep dive](#pattern-normalization-deep-dive)
- [Google query execution](#google-query-execution)
- [Run state machine](#run-state-machine)
- [Caching and storage](#caching-and-storage)
- [Exporting results](#exporting-results)
- [Development](#development)
- [File map](#file-map)
- [Known limitations](#known-limitations)

---

## Install

1. Open `chrome://extensions` and toggle **Developer mode** (top right).
2. Click **Load unpacked** and select this directory.
3. Pin the extension. Click the toolbar icon while on any http(s) page.

No build step, no runtime dependencies. Manifest V3, service-worker background, vanilla JS ES modules.

---

## How it works

```
  ┌──────────────────┐
  │ icon click on    │
  │ example.com      │
  └───────┬──────────┘
          │
          ▼
  ┌──────────────────┐     ┌─────────────────────────────┐
  │ fetch robots.txt │────▶│ parse: Googlebot + *  blocks │
  └──────────────────┘     └───────────────┬─────────────┘
                                           │
                                           ▼
                           ┌────────────────────────────────┐
                           │ normalize each Disallow line → │
                           │ Google site:/inurl:/filetype:  │
                           │ query   (+ dedupe variants)    │
                           └───────────────┬────────────────┘
                                           │
                                           ▼
                           ┌────────────────────────────────┐
                           │ for each query: cache hit?     │
                           │   yes → use cached count       │
                           │   no  → throttled fetch (10-30s)│
                           └───────────────┬────────────────┘
                                           │
                                           ▼
                           ┌────────────────────────────────┐
                           │ results tab: pattern | query | │
                           │ count | status | actions       │
                           └────────────────────────────────┘
```

---

## The UI

The results tab has five columns:

| Column | Meaning |
|---|---|
| **Pattern** | The raw Disallow line from `robots.txt`, with a `+N` badge if multiple rules collapsed into this row (hover to see the other variants). |
| **Query** | The Google search we ran. Click **↗** in the Actions column to re-run it in a real Google tab. |
| **Results** | Indexed count. A `~` prefix means the count is approximate (see [approximate results](#exact-vs-approximate)). A dash means the row hasn't been queried yet, errored, or is a "skipped" rule. |
| **Status** | `pending`, `fetching`, `✓ just now`, `✓ <timestamp>` (cached), `⏸ stopped`, `⛔ CAPTCHA`, `✗ <error>`, or `⚠ <reason>` for skipped rows. |
| **Actions** | **↗** opens the Google query in a new tab. **↻** refreshes just this row (bypasses cache, goes to the front of the throttle queue). |

Header buttons:

- **⏸ Stop** — halt the run; unfinished rows become `stopped`. Visible only while a run is executing.
- **▶ Resume** — pick up where Stop left off. Visible only when there are stopped rows.
- **↺ Re-scan** — re-read `robots.txt` and rebuild the run. **Cache is kept**, so previously answered rows hit cache instantly. Useful after the site changes `robots.txt` or for re-auditing without paying the full query cost.
- **↻ Refresh all** — wipe cache and state, re-run everything. Expensive.

Banners (at most one visible at a time, driven by run state):

- **⚠ Large run** — fires when more than 50 uncached rules would need to be queried. Google-side rate limiting means that's >8 minutes minimum. Click *Start run* to proceed, or just close the tab.
- **⛔ CAPTCHA** — Google blocked us. Click *Open verification page*, solve the CAPTCHA in a real tab, then come back and click *Resume*.

Footer: progress bar, total indexed count across queried rows, and export buttons (TSV / Markdown / debug snapshot). The **Only indexed (> 0)** checkbox filters zero-count, skipped, and errored rows out of the export — useful for client deliverables where zeros are just noise.

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

On `ok`, the parser (`lib/robots-parser.js`) pulls out the `Disallow` values from:
- Every `User-agent: Googlebot` block.
- Every `User-agent: *` block.

It ignores other crawlers (Bingbot, etc.), ignores `Allow`, `Sitemap`, `Crawl-delay`, and `Host`, strips BOM and inline `#` comments, and drops empty-valued `Disallow:` lines (which mean "allow everything" in robots.txt semantics).

The two lists (Googlebot + wildcard) are concatenated and deduped in-order before being handed to the normalizer.

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
| `/api/` | `site:host/api` | no |
| `/api/*` | `site:host/api` | no |
| `/private/data` | `site:host/private/data` | no |
| `/search*` | `site:host/search` | no |
| `/de/search*` | `site:host/de/search` | no |
| `/search*/` | `site:host/search` | no |
| `/tag*/` | `site:host/tag` | no |

Trailing `/`, `/*`, `*`, `*/` are all stripped — they all describe the same prefix in robots.txt. The three variants `/api`, `/api/`, `/api/*` collapse into one row with a `+2` badge.

This is the only case Google's `site:` operator actually matches the robots.txt pattern semantics cleanly, which is why these rows aren't marked approximate.

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
| `/img/*.jpg` | `site:host/img filetype:jpg` | no |
| `/img/*.PNG` | `site:host/img filetype:png` | no |
| `/img/*-wWIDTH*.jpg` | `site:host/img filetype:jpg inurl:wwidth` | yes |

Anywhere the wildcard segments include a literal `.ext`, it becomes `filetype:ext`. The pattern can be anchored at root (`*.json$`) or scoped to a subdirectory (`/img/*.jpg`). Extensions are lowercased so `*.JPG` and `*.jpg` dedupe.

### 5. Mid-path wildcard → `inurl:`

| Pattern | Query | Approximate? |
|---|---|---|
| `/private/*/edit` | `site:host/private inurl:edit` | yes |
| `/foo/*bar` | `site:host/foo inurl:bar` | yes |
| `/energieloesungen/*-form/` | `site:host/energieloesungen inurl:form` | yes |
| `/energieloesungen/social/*-form/` | `site:host/energieloesungen/social inurl:form` | yes |
| `/foo/*/bar/*/baz` | `site:host/foo inurl:bar inurl:baz` | yes |
| `/foo/*bar*bar` | `site:host/foo inurl:bar` (deduped) | yes |

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
| `/foo/*?bar=baz` | `site:host/foo inurl:bar inurl:baz` | yes |
| `/*?noredirect=true&config=standalone` | `site:host inurl:noredirect inurl:true inurl:config inurl:standalone` | yes |

The pattern is split at the first `?`. The left side's first segment (if it starts with `/`) becomes the path prefix. The right side is tokenized on `&` and `=`; every non-empty token becomes an `inurl:` term.

Approximate — `inurl:` doesn't distinguish between "in the query string" and "in the path", so a URL with `/config-guide` would match `inurl:config` even though the rule targets `?config=...` URLs.

### 8. URL-encoded (UTF-8) paths

| Pattern | Query |
|---|---|
| `/ru/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA` | `site:host/ru/поиск` |
| `/bg/%D0%BB%D0%B0%D0%B3%D0%B5%D1%80/*/media$` | `site:host/bg/лагер inurl:media` |
| `/hu/taborhely/*/%C3%A9rdekl%C5%91dik/*` | `site:host/hu/taborhely inurl:érdeklődik` |

Percent-encoded UTF-8 is decoded before building the query, both in path prefixes and in `inurl:` terms. The sanitizer uses Unicode-aware regexes (`\p{L}\p{N}`) so non-ASCII letters like `é`, `ő`, Cyrillic `п`, etc. are preserved.

### 9. Unsupported

A pattern that doesn't match any of the above (e.g., `?` with no extractable tokens, wildcards with no usable suffix) is marked `skipped` with `reason: 'unsupported pattern shape'`.

### 10. Deduplication across variants

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

### CAPTCHA recovery

On CAPTCHA, the throttle pauses and the UI shows the ⛔ banner. The user solves the CAPTCHA in a normal Google tab (via the *Open verification page* button), then clicks *Resume*. The blocked row goes to the front of the queue and the throttle resumes.

---

## Run state machine

Every host has one persisted `run:<host>` record with a single authoritative `runStatus`:

```
                   ┌──────────┐
                   │  none    │
                   └────┬─────┘
                        │ icon click  (≤ 50 uncached)
                        │ icon click  (> 50 uncached)
               ┌────────┴────────────┐
               ▼                     ▼
       ┌─────────────┐      ┌────────────────────────┐
       │  running    │◀─────│ awaiting-confirmation  │
       │             │ Start│                        │
       └──┬──────────┘ Run  └────────────────────────┘
          │  ▲  ▲                ▲
   Stop   │  │  │ Resume        │ (re-open tab → replay only)
          ▼  │  │                │
       ┌──────┴──┴──┐     ┌──────┴──────────┐
       │paused-stop │     │paused-captcha   │
       └────────────┘     └─────────────────┘
          │                      ▲
   last ▼ row done               │ CAPTCHA
       ┌────────────┐            │
       │    done    │────────────┘
       └────────────┘
```

**Invariants the code enforces:**

- **Opening the tab never starts work.** doRun on an existing state replays it and exits. Only explicit user actions (`Start run`, `Resume`, `Resume after CAPTCHA`, `Refresh all`, `Re-scan`, row `↻`) enqueue fetches.
- `resumeAllPending()` on SW boot re-enqueues only rows in `running` state. A paused run stays paused across service-worker restarts.
- Banners + header buttons are all derived from `runStatus`, not from per-row scans, so they can't disagree. Every transition broadcasts a `run:state` message so the UI updates immediately.
- An in-flight fetch that completes after Stop never promotes `paused-stopped` to `done`.

---

## Caching and storage

Keys live under `chrome.storage.local`:

| Key | Shape | Purpose |
|---|---|---|
| `cache:<host>:<query>` | `{ count, fetchedAt, approximate }` | 7-day TTL result cache. Entries past TTL read as misses. |
| `run:<host>` | `{ host, startedAt, robotsStatus, robots, rules[], runStatus }` | One row per host. Drives replay + resume. |
| `debug:lastUnrecognized` | `{ url, at, body }` | Last unparseable Google response, for debugging. |

TTL is 7 days (`lib/cache.js`). Re-scan and Refresh-all share the rebuild path; only Refresh-all also wipes `cache:<host>:*`.

---

## Exporting results

The footer has two copy buttons and a filter:

- **📋 Copy TSV** — tab-separated, columns: `raw pattern`, `query`, `count`, `status`. No header row. Paste straight into a spreadsheet.
- **📋 Copy MD** — Markdown table with a header. Paste into a doc / ticket / PR description.
- **Only indexed (> 0)** — checkbox to the left of the buttons. Filters out skipped, errored, zero-count, and uncached rows so the export contains only the rules that actually have indexed URLs.

The **🐛 Copy Debug** button is only needed if some row shows `unrecognized-response` — it copies the saved HTML body so the Google-response parser can be updated.

---

## Development

```bash
npm test   # run the Node test suite (67 tests, no deps)
```

Tests use Node's built-in test runner. They cover the pattern normalizer, the robots parser, the Google-response parser, and the HTML helpers. Everything else (orchestrator, fetch, Chrome APIs) is exercised manually in Chrome.

There is no build step and no runtime dependency. The project is vanilla JS ES modules; the service worker loads `background.js` with `"type": "module"` and the results page loads `results.js` with `<script type="module">`.

---

## File map

```
robots-disallow-checker/
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

- **No Allow: handling.** `robots.txt` supports `Allow:` rules that carve exceptions out of a broader `Disallow:`. This tool treats every `Disallow` as a flat blacklist entry; it doesn't attempt to subtract Allow paths. For audit purposes that's usually fine (the count is still an *upper bound* on what's covered), but be aware.
- **Google is a prefix-matcher, robots.txt isn't quite.** See the [exact vs. approximate](#exact-vs-approximate) discussion above. Counts marked with `~` or with a `$` variant in the `+N` badge should be read as upper / lower bounds, not exact.
- **Google's result counts are inherently fuzzy.** Google sometimes reports "About N results" that changes between requests. Counts near zero and very large counts are more reliable than mid-range ones.
- **Rate limits.** Running 100+ queries takes half an hour at a minimum. A `>50` uncached-rule run is gated behind a confirmation prompt for that reason.
- **CAPTCHA is inevitable at scale.** The throttle minimizes it but doesn't eliminate it; plan to solve one or two for large audits. Use the Resume flow.
- **Single Chrome profile.** The fetch goes out with whatever cookies + UA the user has in Chrome. Running from a profile that's signed into Google is fine; running from one that isn't is also fine. The counts are public.

---

## License

MIT — see [LICENSE](LICENSE).
