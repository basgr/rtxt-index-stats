import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSearchResponse } from '../lib/google-fetch.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, 'fixtures/google', name), 'utf8');

test('parses result-stats count from typical English results page', async () => {
  const html = await fixture('results-en.html');
  const result = parseSearchResponse({ url: 'https://www.google.com/search?q=site:x', body: html });
  assert.deepEqual(result, { count: 1240 });
});

test('parses German results page', async () => {
  const html = await fixture('results-de.html');
  const result = parseSearchResponse({ url: 'https://www.google.com/search?q=site:x', body: html });
  assert.deepEqual(result, { count: 87500 });
});

test('detects zero-results marker', async () => {
  const html = await fixture('zero-results-en.html');
  const result = parseSearchResponse({ url: 'https://www.google.com/search?q=site:x', body: html });
  assert.deepEqual(result, { count: 0 });
});

test('detects CAPTCHA form in body', async () => {
  const html = await fixture('captcha-form.html');
  const result = parseSearchResponse({ url: 'https://www.google.com/search?q=site:x', body: html });
  assert.deepEqual(result, { captcha: true });
});

test('detects CAPTCHA via /sorry/ redirect URL even with empty body', () => {
  const result = parseSearchResponse({ url: 'https://www.google.com/sorry/index', body: '<html></html>' });
  assert.deepEqual(result, { captcha: true });
});

test('unrecognized response when neither stats nor zero markers present', () => {
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body: '<html><body>weird</body></html>' });
  assert.deepEqual(result, { error: 'unrecognized-response' });
});

test('falls back to "About X results" text pattern when no #result-stats', () => {
  const body = '<html><body><div>About 1,234 results (0.42 seconds)</div></body></html>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 1234 });
});

test('falls back to "Ungefähr X Ergebnisse" German pattern', () => {
  const body = '<html><body><div>Ungefähr 87.500 Ergebnisse (0,38 Sekunden)</div></body></html>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 87500 });
});

test('falls back to single-result "1 result" phrasing', () => {
  const body = '<html><body><div>1 result (0.42 seconds)</div></body></html>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 1 });
});

test('falls back to single-result "1 Ergebnis" German phrasing', () => {
  const body = '<html><body><div>1 Ergebnis (0,38 Sekunden)</div></body></html>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 1 });
});

test('falls back to counting visible result blocks when no count text present', () => {
  const body = '<html><body><div data-rpos="0">r1</div><div data-rpos="1">r2</div><div data-rpos="2">r3</div></body></html>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 3, approximate: true });
});

test('result-stats marker: "10 results" without "About" prefix', () => {
  const body = '<div id="result-stats">10 results<nobr> (0,18s)</nobr></div>';
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 10 });
});

test('result-stats marker: escaped JS-string form (\x3c, \\")', () => {
  const body = String.raw`<script>x="\x3cdiv id=\"result-stats\">10 results\x3cnobr> (0,18s)\x3c/nobr>\x3c/div>";</script>`;
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 10 });
});

test('result-stats marker: escaped JS-string form with "About"', () => {
  const body = String.raw`<script>x="\x3cdiv id=\"result-stats\">About 164 results\x3cnobr>";</script>`;
  const result = parseSearchResponse({ url: 'https://www.google.com/search', body });
  assert.deepEqual(result, { count: 164 });
});
