const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { COSMETICS, LICENSES, ANIME_EMOTES } = require('../src/shop/cosmetics');

test('every anime license provides five card backs and five profile banners', () => {
  for (const license of LICENSES) {
    const items = COSMETICS.filter((item) => item.license === license);
    assert.equal(items.length, 10, `${license} should provide 10 cosmetics`);
    assert.equal(items.filter((item) => item.slot === 'cardBack').length, 5);
    assert.equal(items.filter((item) => item.slot === 'profileBanner').length, 5);
  }
});

test('shop cosmetic ids stay unique', () => {
  const ids = COSMETICS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('anime emotes have unique symbols and are purchasable unlocks', () => {
  assert.ok(ANIME_EMOTES.length >= 12);
  assert.equal(new Set(ANIME_EMOTES.map((item) => item.symbol)).size, ANIME_EMOTES.length);
  for (const item of ANIME_EMOTES) {
    assert.equal(item.slot, 'emote');
    assert.equal(item.unlockOnly, true);
    assert.ok(item.price > 0);
    assert.match(item.imageUrl, /^\/assets\/emotes\/.+\.svg$/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', item.imageUrl)), `${item.imageUrl} should exist`);
  }
});
