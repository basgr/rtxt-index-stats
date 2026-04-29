import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from '../lib/robots-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, 'fixtures/robots', name), 'utf8');

test('single wildcard block: disallows go into wildcard, googlebot is empty', async () => {
  const text = await fixture('single-block.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, []);
  assert.deepEqual(result.wildcard.disallows, ['/admin/', '/api/']);
  // single-block.txt has `Allow: /api/public/` — now extracted.
  assert.deepEqual(result.wildcard.allows, ['/api/public/']);
});

test('googlebot and wildcard blocks are returned separately; bingbot ignored', async () => {
  const text = await fixture('googlebot-and-wildcard.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, ['/staging/', '/private/']);
  assert.deepEqual(result.wildcard.disallows, ['/admin/']);
});

test('BOM is stripped; comments removed; multi-agent group applies to all listed agents', async () => {
  const text = await fixture('comments-bom-multiagent.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, ['/no-ads/', '/shared/']);
  assert.deepEqual(result.wildcard.disallows, ['/']);
});

test('empty Disallow value is dropped (means allow everything)', async () => {
  const text = await fixture('empty-disallow.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, []);
  assert.deepEqual(result.wildcard.disallows, []);
});

test('empty file yields empty groups', async () => {
  const text = await fixture('empty-file.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, []);
  assert.deepEqual(result.wildcard.disallows, []);
});

test('blank line between User-agent and its first Disallow is insignificant (github.com style)', async () => {
  const text = await fixture('blank-line-in-group.txt');
  const result = parse(text);
  assert.deepEqual(result.wildcard.disallows, ['/admin', '/secret']);
  assert.deepEqual(result.googlebot.disallows, ['/gbot-only']);
});

test('User-agent value is reduced to product token (Googlebot/2.1, Googlebot Images, * junk)', async () => {
  const text = await fixture('ua-token-variants.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, ['/version-suffix', '/trailing-junk']);
  assert.deepEqual(result.wildcard.disallows, ['/global']);
});

test('common directive typos (disalow, dissallow, useragent, "user agent") are tolerated', async () => {
  const text = await fixture('directive-typos.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, [
    '/typo-disalow', '/typo-dissallow', '/typo-diasllow', '/typo-disallaw', '/typo-dissalow',
  ]);
  assert.deepEqual(result.wildcard.disallows, ['/global-typo-ua']);
});

test('bare \\r line endings (classic Mac) are recognized', () => {
  const text = 'User-agent: Googlebot\rDisallow: /mac\rUser-agent: *\rDisallow: /every\r';
  const result = parse(text);
  assert.deepEqual(result.googlebot.disallows, ['/mac']);
  assert.deepEqual(result.wildcard.disallows, ['/every']);
});

test('Allow: rules are extracted alongside Disallow: (AEM-style carve-outs)', async () => {
  const text = await fixture('allow-and-disallow.txt');
  const result = parse(text);
  // The wildcard block disallows /content/ but carves out four DAM subpaths.
  assert.deepEqual(result.wildcard.disallows, ['/content/', '/errorpages/', '/maintenance/']);
  assert.deepEqual(result.wildcard.allows, [
    '/content/dam/assets/corporate/',
    '/content/dam/assets/pricelists/',
    '/content/dam/assets/categories/',
    '/content/dam/assets/marketplace/',
  ]);
});

test('Empty Allow: value is dropped', () => {
  const text = 'User-agent: *\nDisallow: /foo\nAllow:\n';
  const result = parse(text);
  assert.deepEqual(result.wildcard.allows, []);
});

test('Allow: typos are tolerated (alow, allaw)', () => {
  const text = 'User-agent: *\nDisallow: /a\nAlow: /a/x\nAllaw: /a/y\n';
  const result = parse(text);
  assert.deepEqual(result.wildcard.allows, ['/a/x', '/a/y']);
});
