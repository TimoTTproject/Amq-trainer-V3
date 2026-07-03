const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchThemesFromAnimeThemes } = require('../src/catalog/catalog.service');

const originalFetch = global.fetch;

function mockFetch(responses) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => responses.shift() };
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('resolves the anime by AniList id first — no ambiguous title search needed', async () => {
  const anime = {
    id: 1,
    name: 'Tengen Toppa Gurren Lagann',
    animethemes: [
      {
        type: 'OP',
        sequence: 1,
        song: { title: 'Sorairo Days', artists: [{ name: 'Shouko Nakagawa' }] },
        animethemeentries: [{ videos: [{ link: 'https://example.com/op1.webm', basename: 'op1.webm' }] }],
      },
    ],
  };
  const calls = mockFetch([{ resources: [{ site: 'AniList', external_id: 2001, anime: [anime] }] }]);

  const themes = await fetchThemesFromAnimeThemes('Tengen Toppa Gurren Lagann', [], 2001);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/resources\?/);
  assert.match(calls[0], /filter%5Bsite%5D=AniList/);
  assert.match(calls[0], /filter%5Bexternal_id%5D=2001/);
  assert.equal(themes.length, 1);
  assert.equal(themes[0].title, 'Sorairo Days');
  assert.equal(themes[0].artist, 'Shouko Nakagawa');
});

test('falls back to the fuzzy title search when animethemes.moe has no AniList resource for this id', async () => {
  const anime = {
    id: 2,
    name: 'Some Anime',
    animethemes: [
      {
        type: 'OP',
        sequence: 1,
        song: { title: 'A Song' },
        animethemeentries: [{ videos: [{ link: 'https://example.com/op1.webm', basename: 'op1.webm' }] }],
      },
    ],
  };
  // 1ère requête : lookup par anilistId, aucune ressource → repli sur la recherche par titre.
  const calls = mockFetch([{ resources: [] }, { anime: [anime] }]);

  const themes = await fetchThemesFromAnimeThemes('Some Anime', [], 999);

  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/resources\?/);
  assert.match(calls[1], /\/anime\?/);
  assert.equal(themes[0].title, 'A Song');
});

test('skips the id-based lookup entirely when no anilistId is given', async () => {
  const anime = { id: 3, name: 'No Id Anime', animethemes: [] };
  const calls = mockFetch([{ anime: [anime] }]);

  await fetchThemesFromAnimeThemes('No Id Anime', []);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/anime\?/);
});
