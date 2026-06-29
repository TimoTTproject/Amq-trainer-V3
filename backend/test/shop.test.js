const test = require('node:test');
const assert = require('node:assert/strict');
const { COSMETICS, LICENSES } = require('../src/shop/cosmetics');

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
