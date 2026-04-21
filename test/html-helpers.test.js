import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textOfElementById,
  titleText,
  containsAny,
  parseLocaleNumber,
} from '../lib/html-helpers.js';

test('textOfElementById finds inner text by id', () => {
  const html = '<div id="x">hello <b>world</b></div>';
  assert.equal(textOfElementById(html, 'x'), 'hello world');
});

test('textOfElementById returns null when id missing', () => {
  assert.equal(textOfElementById('<div>no id</div>', 'x'), null);
});

test('titleText extracts <title> contents', () => {
  assert.equal(titleText('<html><head><title>Hi</title></head></html>'), 'Hi');
});

test('titleText returns empty string when no title', () => {
  assert.equal(titleText('<html></html>'), '');
});

test('containsAny matches when any marker is in the body', () => {
  assert.equal(containsAny('foo bar baz', ['nope', 'bar']), true);
  assert.equal(containsAny('foo bar baz', ['nope', 'never']), false);
});

test('parseLocaleNumber strips digits across en/de/fr separators', () => {
  assert.equal(parseLocaleNumber('About 1,234 results'), 1234);
  assert.equal(parseLocaleNumber('Ungefähr 1.234 Ergebnisse'), 1234);
  assert.equal(parseLocaleNumber('Environ 1\u00A0234 résultats'), 1234);
  assert.equal(parseLocaleNumber('0 results'), 0);
  assert.equal(parseLocaleNumber('no digits here'), null);
});
