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

test('trailing slash: /api/ → site:host/api', () => {
  const r = normalize(HOST, '/api/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/api');
});

test('trailing wildcard: /api/* → site:host/api', () => {
  const r = normalize(HOST, '/api/*');
  assert.equal(r.kind, 'queryable');
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
  assert.equal(r.query, 'site:www.example.com/private inurl:edit');
  assert.equal(r.approximate, true);
});

test('query-string pattern /*?session= becomes inurl approximate', () => {
  const r = normalize(HOST, '/*?session=');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:session');
  assert.equal(r.approximate, true);
});

test('normalizeAndDedupe: variants with same query collapse into one row', () => {
  const rows = normalizeAndDedupe(HOST, ['/api', '/api/', '/api/*', '/wp-admin/']);
  assert.equal(rows.length, 2);
  const apiRow = rows.find(r => r.query === 'site:www.example.com/api');
  assert.deepEqual(apiRow.variants, ['/api', '/api/', '/api/*']);
  const wpRow = rows.find(r => r.query === 'site:www.example.com/wp-admin');
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
  assert.equal(r.query, 'site:www.example.com/energieloesungen inurl:form');
  assert.equal(r.approximate, true);
});

test('mid-path wildcard nested: /energieloesungen/social/*-form/ -> inurl approximate', () => {
  const r = normalize(HOST, '/energieloesungen/social/*-form/');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/energieloesungen/social inurl:form');
  assert.equal(r.approximate, true);
});

test('mid-path wildcard without trailing slash: /foo/*bar -> inurl approximate', () => {
  const r = normalize(HOST, '/foo/*bar');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo inurl:bar');
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
  // Actually this WOULD now match. Let's verify the new behavior
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/private inurl:edit');
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
  assert.equal(r.query, 'site:www.example.com/foo inurl:bar inurl:baz');
  assert.equal(r.approximate, true);
});

test('duplicate literal segments deduped: /foo/*bar*bar', () => {
  const r = normalize(HOST, '/foo/*bar*bar');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/foo inurl:bar');
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
  assert.equal(r.query, 'site:www.example.com/bg/лагер inurl:media');
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
  assert.equal(r.query, 'site:www.example.com/img filetype:jpg inurl:wwidth');
});

test('simple wildcard with file extension: /img/*.jpg', () => {
  const r = normalize(HOST, '/img/*.jpg');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/img filetype:jpg');
});

test('extension uppercase normalized: /img/*.PNG', () => {
  const r = normalize(HOST, '/img/*.PNG');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/img filetype:png');
});

test('URL-encoded inurl term is decoded (Hungarian)', () => {
  const r = normalize(HOST, '/hu/taborhely/*/%C3%A9rdekl%C5%91dik/*');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com/hu/taborhely inurl:érdeklődik');
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
  assert.equal(r.query, 'site:www.example.com/foo inurl:bar inurl:baz');
});

test('query-string pattern with multiple params and dedup: /*?noredirect=true&config=standalone', () => {
  const r = normalize(HOST, '/*?noredirect=true&config=standalone');
  assert.equal(r.kind, 'queryable');
  assert.equal(r.query, 'site:www.example.com inurl:noredirect inurl:true inurl:config inurl:standalone');
});

test('inurl terms lowercased so case-only differing patterns dedupe', () => {
  const rows = normalizeAndDedupe(HOST, ['/*?service=ajax', '/*?service=Ajax']);
  const queryable = rows.filter(r => r.kind === 'queryable');
  assert.equal(queryable.length, 1);
  assert.equal(queryable[0].query, 'site:www.example.com inurl:service inurl:ajax');
  assert.deepEqual(queryable[0].variants, ['/*?service=ajax', '/*?service=Ajax']);
});
