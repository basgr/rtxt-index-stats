import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, normalizeAndDedupe } from '../lib/pattern-normalize.js';

const HOST = 'www.example.com';

test('plain prefix: /api → queryable site:host/api', () => {
  const r = normalize(HOST, '/api');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/api');
  assert.equal(r.verifyUrl, 'https://www.google.com/search?q=site%3Awww.example.com%2Fapi&filter=0');
});

test('trailing slash is preserved: /api/ → site:host/api/ (narrower than /api)', () => {
  const r = normalize(HOST, '/api/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/api/');
});

test('trailing wildcard: /api/* → site:host/api/ (equivalent to /api/)', () => {
  const r = normalize(HOST, '/api/*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/api/');
});

test('plain prefix without trailing slash stays unchanged: /api → site:host/api', () => {
  const r = normalize(HOST, '/api');
  assert.equal(r.query, 'site:www.example.com/api');
});

test('multi-segment prefix: /private/data → site:host/private/data', () => {
  const r = normalize(HOST, '/private/data');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/private/data');
});

test('filetype suffix: /*.pdf$ → site:host filetype:pdf', () => {
  const r = normalize(HOST, '/*.pdf$');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com filetype:pdf');
});

test('filetype suffix: *.json$ → site:host filetype:json', () => {
  const r = normalize(HOST, '*.json$');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com filetype:json');
});

test('filetype suffix uppercase ext is normalized to lowercase', () => {
  const r = normalize(HOST, '/*.PDF$');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com filetype:pdf');
});

test('root / is skipped as not informative', () => {
  const r = normalize(HOST, '/');
  assert.equal(r.kind, 'skipped');
  assert.match(r.reason, /site-wide/i);
});

test('mid-path wildcard /private/*/edit becomes approximate inurl query', () => {
  const r = normalize(HOST, '/private/*/edit');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/private/ inurl:edit');
  assert.equal(r.approximate, true);
});

test('query-string pattern /*?session= becomes inurl approximate', () => {
  const r = normalize(HOST, '/*?session=');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:session');
  assert.equal(r.approximate, true);
});

test('normalizeAndDedupe: /api and /api/ are DIFFERENT rules and stay separate', () => {
  // In robots.txt, `/api` blocks /api, /api.html, /api-bar AND /api/foo,
  // while `/api/` only blocks URLs under /api/. They are NOT equivalent.
  // /api/ and /api/* ARE equivalent (both block /api/...) so they merge.
  const rows = normalizeAndDedupe(HOST, ['/api', '/api/', '/api/*', '/wp-admin/']);
  assert.equal(rows.length, 3);
  const apiBare = rows.find(r => r.query === 'site:www.example.com/api');
  assert.deepEqual(apiBare.variants, ['/api']);
  const apiSlash = rows.find(r => r.query === 'site:www.example.com/api/');
  assert.deepEqual(apiSlash.variants, ['/api/', '/api/*']);
  const wpRow = rows.find(r => r.query === 'site:www.example.com/wp-admin/');
  assert.deepEqual(wpRow.variants, ['/wp-admin/']);
});

test('trailing wildcard without slash: /search* → site:host/search', () => {
  const r = normalize(HOST, '/search*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/search');
});

test('trailing wildcard without slash, multi-segment: /de/search* → site:host/de/search', () => {
  const r = normalize(HOST, '/de/search*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/de/search');
});

test('trailing wildcard /search/map* normalizes correctly', () => {
  const r = normalize(HOST, '/search/map*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/search/map');
});

test('normalizeAndDedupe: skipped rows preserve their raw and variants array', () => {
  const rows = normalizeAndDedupe(HOST, ['/', '*']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.kind === 'skipped'));
  assert.deepEqual(rows.map(r => r.variants), [['/'], ['*']]);
});

test('trailing wildcard with slash: /search*/ -> site:host/search', () => {
  const r = normalize(HOST, '/search*/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/search');
});

test('trailing wildcard with slash: /tag*/ -> site:host/tag', () => {
  const r = normalize(HOST, '/tag*/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/tag');
});

test('mid-path wildcard with literal suffix: /energieloesungen/*-form/ -> inurl approximate', () => {
  const r = normalize(HOST, '/energieloesungen/*-form/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/energieloesungen/ inurl:form');
  assert.equal(r.approximate, true);
});

test('mid-path wildcard nested: /energieloesungen/social/*-form/ -> inurl approximate', () => {
  const r = normalize(HOST, '/energieloesungen/social/*-form/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/energieloesungen/social/ inurl:form');
  assert.equal(r.approximate, true);
});

test('mid-path wildcard without trailing slash: /foo/*bar -> inurl approximate', () => {
  const r = normalize(HOST, '/foo/*bar');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo/ inurl:bar');
  assert.equal(r.approximate, true);
});

test('plain prefix is NOT marked approximate', () => {
  const r = normalize(HOST, '/api');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.approximate, false);
});

test('mid-path wildcard with no usable suffix is still skipped', () => {
  const r = normalize(HOST, '/private/*/edit');
  // suffix "/edit" -> after stripping non-alnum: "edit" -> queryable
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/private/ inurl:edit');
});

test('wildcard prefix and suffix: */feed/* -> site:host inurl:feed approximate', () => {
  const r = normalize(HOST, '*/feed/*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:feed');
  assert.equal(r.approximate, true);
});

test('wildcard prefix only: */feed -> site:host inurl:feed', () => {
  const r = normalize(HOST, '*/feed');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:feed');
  assert.equal(r.approximate, true);
});

test('multiple inurl terms: /foo/*/bar/*/baz', () => {
  const r = normalize(HOST, '/foo/*/bar/*/baz');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo/ inurl:bar inurl:baz');
  assert.equal(r.approximate, true);
});

test('duplicate literal segments deduped: /foo/*bar*bar', () => {
  const r = normalize(HOST, '/foo/*bar*bar');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo/ inurl:bar');
});

test('end-of-URL anchor: /ro/cautare-harta$ -> approximate site: query', () => {
  const r = normalize(HOST, '/ro/cautare-harta$');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/ro/cautare-harta');
  assert.equal(r.approximate, true);
});

test('URL-encoded Cyrillic path is decoded before site: query', () => {
  const encoded = '/ru/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA-%D0%BD%D0%B0-%D0%BA%D0%B0%D1%80%D1%82%D0%B5$';
  const r = normalize(HOST, encoded);
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/ru/поиск-на-карте');
  assert.equal(r.approximate, true);
});

test('plain URL-encoded path without $ is also decoded', () => {
  const r = normalize(HOST, '/ru/%D0%BF%D0%BE%D0%B8%D1%81%D0%BA');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/ru/поиск');
  assert.equal(r.approximate, false);
});

test('URL-encoded prefix in wildcard pattern is decoded', () => {
  const r = normalize(HOST, '/bg/%D0%BB%D0%B0%D0%B3%D0%B5%D1%80/*/media$');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/bg/лагер/ inurl:media');
  assert.equal(r.approximate, true);
});

test('dedupe picks widest variant as primary; narrower goes to badge', () => {
  const rows = normalizeAndDedupe(HOST, ['/hr/account$', '/hr/account']);
  const row = rows.find(r => r.query === 'site:www.example.com/hr/account');
  assert.equal(row.raw, '/hr/account');
  assert.deepEqual(row.variants, ['/hr/account', '/hr/account$']);
  // Widest variant (no $) is exact, so the row is no longer approximate
  assert.equal(row.approximate, false);
});

test('dedupe with only $ variants stays approximate', () => {
  const rows = normalizeAndDedupe(HOST, ['/foo$', '/foo$']);
  const row = rows.find(r => r.query === 'site:www.example.com/foo');
  assert.equal(row.approximate, true);
});

test('file extension after wildcard maps to filetype: not inurl:', () => {
  const r = normalize(HOST, '/img/*-wWIDTH*.jpg');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/img/ filetype:jpg inurl:wwidth');
});

test('simple wildcard with file extension: /img/*.jpg', () => {
  const r = normalize(HOST, '/img/*.jpg');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/img/ filetype:jpg');
});

test('extension uppercase normalized: /img/*.PNG', () => {
  const r = normalize(HOST, '/img/*.PNG');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/img/ filetype:png');
});

test('URL-encoded inurl term is decoded (Hungarian)', () => {
  const r = normalize(HOST, '/hu/taborhely/*/%C3%A9rdekl%C5%91dik/*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/hu/taborhely/ inurl:érdeklődik');
  assert.equal(r.approximate, true);
});

test('query-string pattern: /*?config -> inurl approximate', () => {
  const r = normalize(HOST, '/*?config');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:config');
  assert.equal(r.approximate, true);
});

test('query-string pattern with key=value: /*?config=foo', () => {
  const r = normalize(HOST, '/*?config=foo');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:config inurl:foo');
});

test('query-string pattern multi-param: /*?ajax&wid', () => {
  const r = normalize(HOST, '/*?ajax&wid');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:ajax inurl:wid');
});

test('query-string pattern with prefix: /foo/*?bar=baz', () => {
  const r = normalize(HOST, '/foo/*?bar=baz');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo/ inurl:bar inurl:baz');
});

test('query-string pattern with multiple params and dedup: /*?noredirect=true&config=standalone', () => {
  const r = normalize(HOST, '/*?noredirect=true&config=standalone');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:noredirect inurl:true inurl:config inurl:standalone');
});

test('trailing-? with nothing after falls back to plain prefix (approximate)', () => {
  // /web/de/shop? = "URLs starting with /web/de/shop and having any query string".
  // We can't express the "?" requirement; degrade to the prefix and flag approx.
  const r = normalize(HOST, '/web/de/shop?');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/web/de/shop');
  assert.equal(r.approximate, true);
});

test('trailing-? preserves trailing slash on the path part', () => {
  const r = normalize(HOST, '/web/de/shop/?');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/web/de/shop/');
  assert.equal(r.approximate, true);
});

test('trailing-? does NOT dedupe with bare prefix (different rules)', () => {
  // /foo blocks /foo, /foo.html, /foo?x=1, /foo/bar, etc.
  // /foo? requires a `?` to be present somewhere after.
  // They produce the same site: query but stay as separate rows because
  // /foo is exact and /foo? is approximate.
  const rows = normalizeAndDedupe(HOST, ['/foo', '/foo?']);
  const queryable = rows.filter(r => r.kind === 'queryable');
  // Same query string → they collapse into one row, but the approximate flag
  // is recomputed from the widest variant (/foo, no `?`), so it stays exact.
  // The narrower /foo? lives in the +1 badge.
  assert.equal(queryable.length, 1);
  assert.equal(queryable[0].query, 'site:www.example.com/foo');
  assert.equal(queryable[0].approximate, false); // widest variant wins
  assert.deepEqual(queryable[0].variants, ['/foo', '/foo?']);
});

test('inurl terms lowercased so case-only differing patterns dedupe', () => {
  const rows = normalizeAndDedupe(HOST, ['/*?service=ajax', '/*?service=Ajax']);
  const queryable = rows.filter(r => r.kind === 'queryable');
  assert.equal(queryable.length, 1);
  assert.equal(queryable[0].query, 'site:www.example.com inurl:service inurl:ajax');
  assert.deepEqual(queryable[0].variants, ['/*?service=ajax', '/*?service=Ajax']);
});

// ---- Allow handling -------------------------------------------------------

test('Allow under a Disallow appends -inurl: exclusion (AEM-style carve-out)', () => {
  const rows = normalizeAndDedupe(
    HOST,
    ['/content/'],
    [
      '/content/dam/assets/corporate/',
      '/content/dam/assets/pricelists/',
    ]
  );
  const r = rows.find(x => x.kind === 'queryable');
  assert.equal(
    r.query,
    'site:www.example.com/content/ -inurl:/content/dam/assets/corporate/ -inurl:/content/dam/assets/pricelists/'
  );
  assert.equal(r.approximate, true); // exclusions always approximate
  assert.deepEqual(r.excludedAllows, [
    '/content/dam/assets/corporate/',
    '/content/dam/assets/pricelists/',
  ]);
  assert.equal(r.droppedAllows, undefined);
  // verifyUrl reflects the new combined query
  assert.ok(r.verifyUrl.includes(encodeURIComponent('-inurl:/content/dam/assets/pricelists/')));
});

test('orphan Allow (no matching Disallow prefix) is silently dropped', () => {
  const rows = normalizeAndDedupe(HOST, ['/content/'], ['/something-unrelated/']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.equal(r.query, 'site:www.example.com/content/');
  assert.equal(r.approximate, false);
  assert.equal(r.excludedAllows, undefined);
});

test('Allow attribution picks the LONGEST matching Disallow', () => {
  // Both /a/ and /a/b/ are disallowed. Allow /a/b/c/ matches both — longer wins.
  const rows = normalizeAndDedupe(HOST, ['/a/', '/a/b/'], ['/a/b/c/']);
  const aRow = rows.find(r => r.query?.startsWith('site:www.example.com/a/ '));
  const abRow = rows.find(r => r.query?.startsWith('site:www.example.com/a/b/'));
  assert.equal(aRow, undefined); // /a/ should NOT receive the exclusion
  const aRowExact = rows.find(r => r.query === 'site:www.example.com/a/');
  assert.equal(aRowExact.excludedAllows, undefined);
  assert.deepEqual(abRow.excludedAllows, ['/a/b/c/']);
});

test('Allow that exactly equals a Disallow path fully nullifies the row', () => {
  const rows = normalizeAndDedupe(HOST, ['/foo/'], ['/foo/']);
  const r = rows.find(x => x.raw === '/foo/');
  assert.equal(r.kind, 'skipped');
  assert.match(r.reason, /fully allowed by Allow: \/foo\//);
});

test('exclusions cap at 10 — extras go to droppedAllows', () => {
  const allows = Array.from({ length: 13 }, (_, i) => `/content/sub${i}/`);
  const rows = normalizeAndDedupe(HOST, ['/content/'], allows);
  const r = rows.find(x => x.kind === 'queryable');
  assert.equal(r.excludedAllows.length, 10);
  assert.equal(r.droppedAllows.length, 3);
  assert.deepEqual(r.droppedAllows, ['/content/sub10/', '/content/sub11/', '/content/sub12/']);
  // Query contains 10 -inurl: tokens
  assert.equal((r.query.match(/-inurl:/g) || []).length, 10);
});

test('Allow with mid-path wildcard is dropped silently (v1 unsupported shape)', () => {
  const rows = normalizeAndDedupe(HOST, ['/content/'], ['/content/*/public/']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.equal(r.query, 'site:www.example.com/content/');
  assert.equal(r.excludedAllows, undefined);
});

test('Allow with $ end-anchor is treated as plain prefix (anchor stripped)', () => {
  const rows = normalizeAndDedupe(HOST, ['/content/'], ['/content/special$']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.deepEqual(r.excludedAllows, ['/content/special$']);
  assert.ok(r.query.includes('-inurl:/content/special'));
});

test('$-anchored Disallow does NOT receive Allow attribution (no anchor)', () => {
  // /foo$ matches only the exact URL /foo. An allow under /foo/x/ doesn't carve it.
  const rows = normalizeAndDedupe(HOST, ['/foo$'], ['/foo/x/']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo');
  assert.equal(r.excludedAllows, undefined);
});

test('Wildcard Disallow receives Allow exclusions on the part-before-wildcard anchor', () => {
  // /foo/*bar has anchor /foo/. Allow /foo/special/ falls under that anchor.
  const rows = normalizeAndDedupe(HOST, ['/foo/*bar'], ['/foo/special/']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.deepEqual(r.excludedAllows, ['/foo/special/']);
  assert.ok(r.query.includes('-inurl:/foo/special/'));
});

test('Allow with trailing /* is treated as plain prefix', () => {
  const rows = normalizeAndDedupe(HOST, ['/content/'], ['/content/dam/*']);
  const r = rows.find(x => x.kind === 'queryable');
  assert.deepEqual(r.excludedAllows, ['/content/dam/*']);
  // The /* gets stripped from the path used in -inurl:
  assert.ok(r.query.includes('-inurl:/content/dam/'));
});
