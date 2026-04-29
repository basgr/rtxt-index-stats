# Privacy Policy

_Last updated: April 2026_

This page describes what data Robots Disallow Checker handles, and what it does not.

## What the extension does

When you click the extension icon on an http(s) page, it:

1. Fetches that site's `robots.txt` file (a public document).
2. Constructs Google `site:` search URLs for each Disallow rule.
3. Uses your normal browser session to query those URLs against `https://www.google.com/search` and reads the indexed-result count from the response.
4. Stores the parsed rules and resulting counts on your device only (via `chrome.storage.local`).

## Data collected

**None.** The extension does not collect, transmit, or share any personal data. There is no analytics, no telemetry, no remote logging, no third-party data brokers.

## Data stored locally on your device

The following is written to `chrome.storage.local` and never leaves your machine:

- **Cached query results** — the Google indexed count for each Disallow rule, with a 7-day expiry. Used to avoid re-querying the same rule.
- **Per-host run state** — which rules have been queried, fetched, stopped, etc. Used to resume an audit if you close and reopen the results tab.
- **Last unrecognized Google response** (debugging only) — captured when the response parser fails on a new page format, so the user can copy and report it. Cleared on the next successful parse.

You can clear all stored data at any time via Chrome → Settings → Extensions → Robots Disallow Checker → Site access / Erase, or by uninstalling the extension.

## Network requests

The extension makes two kinds of outbound requests:

1. `GET https://<host-you-clicked>/robots.txt` — the site you're auditing. This is a public file every web crawler fetches.
2. `GET https://www.google.com/search?q=<site:host/...>` — submitted with your normal Chrome cookies and User-Agent, exactly as if you'd typed the query into Google yourself. Google's own privacy policy applies to those requests.

No data is ever sent to any other server.

## Permissions

| Permission | Why we need it |
|---|---|
| `tabs` | Open the results tab and find an existing one for the host you're auditing. |
| `storage` | Cache results and persist run state across service-worker restarts (see above). |
| `alarms` | Schedule the 10–30 second throttle delay between Google requests so the MV3 service worker can be killed between requests without losing the queue. |
| `host_permissions: <all_urls>` | Fetch `robots.txt` from any http(s) site you choose to audit. Used only when you click the extension icon. |
| `host_permissions: https://www.google.com/*` | Issue the `site:` search queries that produce the indexed counts. |

## Source code

The full source is open on GitHub: <https://github.com/basgr/rtxt-index-stats>. The data-handling claims above can be verified directly in `lib/cache.js`, `lib/google-fetch.js`, and `lib/robots-fetch.js`.

## Contact

For privacy questions or to report a bug: open an issue at <https://github.com/basgr/rtxt-index-stats/issues>.
