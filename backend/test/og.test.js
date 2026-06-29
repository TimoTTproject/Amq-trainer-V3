const test = require('node:test');
const assert = require('node:assert/strict');
const { injectMeta, esc } = require('../src/share/og');

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
