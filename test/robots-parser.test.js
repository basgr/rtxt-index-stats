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
  assert.deepEqual(result.googlebot, []);
  assert.deepEqual(result.wildcard, ['/admin/', '/api/']);
});

test('googlebot and wildcard blocks are returned separately; bingbot ignored', async () => {
  const text = await fixture('googlebot-and-wildcard.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot, ['/staging/', '/private/']);
  assert.deepEqual(result.wildcard, ['/admin/']);
});

test('BOM is stripped; comments removed; multi-agent group applies to all listed agents', async () => {
  const text = await fixture('comments-bom-multiagent.txt');
  const result = parse(text);
  // Googlebot is in the same group as AdsBot-Google → both disallows apply
  assert.deepEqual(result.googlebot, ['/no-ads/', '/shared/']);
  // wildcard block has Disallow: / which IS a real rule (not empty) → kept
  assert.deepEqual(result.wildcard, ['/']);
});

test('empty Disallow value is dropped (means allow everything)', async () => {
  const text = await fixture('empty-disallow.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot, []);
  assert.deepEqual(result.wildcard, []);
});

test('empty file yields empty groups', async () => {
  const text = await fixture('empty-file.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot, []);
  assert.deepEqual(result.wildcard, []);
});

test('blank line between User-agent and its first Disallow is insignificant (github.com style)', async () => {
  const text = await fixture('blank-line-in-group.txt');
  const result = parse(text);
  // The `*` block has a blank line between the UA line and its disallows — they must still be collected.
  assert.deepEqual(result.wildcard, ['/admin', '/secret']);
  assert.deepEqual(result.googlebot, ['/gbot-only']);
});

test('User-agent value is reduced to product token (Googlebot/2.1, Googlebot Images, * junk)', async () => {
  const text = await fixture('ua-token-variants.txt');
  const result = parse(text);
  // Googlebot/2.1 and "Googlebot Images" both produce token `googlebot`.
  assert.deepEqual(result.googlebot, ['/version-suffix', '/trailing-junk']);
  // `* extra ignored` is recognized as the global token.
  assert.deepEqual(result.wildcard, ['/global']);
  // Bingbot/3.0 is parsed as bingbot but not relevant to either output list.
});

test('common directive typos (disalow, dissallow, useragent, "user agent") are tolerated', async () => {
  const text = await fixture('directive-typos.txt');
  const result = parse(text);
  assert.deepEqual(result.googlebot, [
    '/typo-disalow', '/typo-dissallow', '/typo-diasllow', '/typo-disallaw', '/typo-dissalow',
  ]);
  assert.deepEqual(result.wildcard, ['/global-typo-ua']);
});

test('bare \\r line endings (classic Mac) are recognized', () => {
  const text = 'User-agent: Googlebot\rDisallow: /mac\rUser-agent: *\rDisallow: /every\r';
  const result = parse(text);
  assert.deepEqual(result.googlebot, ['/mac']);
  assert.deepEqual(result.wildcard, ['/every']);
});
