const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { injectMeta, esc, versionize, BUILD_ID } = require('../src/share/og');

const SAMPLE = `<!doctype html><html><head>
<title>Anime Music Quiz — Devine l'anime à son opening</title>
<meta name="description" content="desc par défaut" />
<meta property="og:title" content="AMQ" />
<meta property="og:description" content="desc OG" />
<meta property="og:url" content="https://amqtrainer.fr" />
<meta name="twitter:title" content="AMQ" />
<meta name="twitter:description" content="desc tw" />
</head><body></body></html>`;

test('injectMeta replaces title, descriptions and url', () => {
  const out = injectMeta(SAMPLE, { title: 'Gorooo · AMQ', description: 'Profil de Gorooo', url: 'https://amqtrainer.fr/?u=42' });
  assert.match(out, /<title>Gorooo · AMQ<\/title>/);
  assert.match(out, /property="og:title" content="Gorooo · AMQ"/);
  assert.match(out, /name="twitter:title" content="Gorooo · AMQ"/);
  assert.match(out, /property="og:description" content="Profil de Gorooo"/);
  assert.match(out, /property="og:url" content="https:\/\/amqtrainer\.fr\/\?u=42"/);
});

test('injectMeta escapes HTML-dangerous characters in user content', () => {
  const out = injectMeta(SAMPLE, { title: 'a"<b>&', description: 'x' });
  assert.match(out, /content="a&quot;&lt;b&gt;&amp;"/);
  assert.doesNotMatch(out, /content="a"<b>&"/);
});

test('esc handles quotes and angle brackets', () => {
  assert.equal(esc('a"<>&'), 'a&quot;&lt;&gt;&amp;');
  assert.equal(esc(null), '');
});

test('versionize injecte le build ID sans script inline interdit par la CSP', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const out = versionize(html);
  assert.match(out, new RegExp(`data-build-id="${BUILD_ID}"`));
  assert.match(out, new RegExp(`bootstrap\\.js\\?v=${BUILD_ID}`));
  assert.doesNotMatch(out, /<script(?![^>]*\bsrc=)[^>]*>/i);
});
