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

test('rejects a text-similar candidate whose OWN AniList id disagrees (One Piece / THE ONE PIECE bug)', async () => {
  // « THE ONE PIECE » (remake CGI 2024, anilistId 999) n'a pas encore de
  // ressource AniList référencée sous son propre id → repli texte. Le premier
  // candidat renvoyé par la recherche est le « One Piece » classique
  // (anilistId 21 chez animethemes) : très proche textuellement (~0.82) mais
  // c'est une AUTRE œuvre, prouvée par sa propre référence AniList qui NE
  // correspond PAS à l'anilistId qu'on cherche à résoudre (999). Doit être
  // rejeté même si rien d'autre ne matche mieux.
  const classicOnePiece = {
    id: 21,
    name: 'One Piece',
    resources: [{ site: 'AniList', external_id: 21 }],
    animethemes: [{
      type: 'OP', sequence: 1,
      song: { title: 'We Are!' },
      animethemeentries: [{ videos: [{ link: 'https://example.com/op1.webm', basename: 'op1.webm' }] }],
    }],
  };
  const calls = mockFetch([{ resources: [] }, { anime: [classicOnePiece] }]);

  const themes = await fetchThemesFromAnimeThemes('THE ONE PIECE', [], 999);

  assert.equal(calls.length, 2);
  assert.deepEqual(themes, [], 'le candidat prouvé différent ne doit produire aucun thème');
});

test('accepts a text-similar candidate that has NO AniList resource known (best-effort kept)', async () => {
  const anime = {
    id: 5,
    name: 'Some Close Title',
    // Pas de resources du tout : animethemes ne sait pas à quel AniList ça
    // correspond → on ne peut pas prouver que c'est faux, l'heuristique texte
    // s'applique comme avant.
    animethemes: [{
      type: 'OP', sequence: 1,
      song: { title: 'Theme' },
      animethemeentries: [{ videos: [{ link: 'https://example.com/op1.webm', basename: 'op1.webm' }] }],
    }],
  };
  const calls = mockFetch([{ resources: [] }, { anime: [anime] }]);

  const themes = await fetchThemesFromAnimeThemes('Some Close Title', [], 999);

  assert.equal(calls.length, 2);
  assert.equal(themes[0]?.title, 'Theme');
});

test('skips the id-based lookup entirely when no anilistId is given', async () => {
  const anime = { id: 3, name: 'No Id Anime', animethemes: [] };
  const calls = mockFetch([{ anime: [anime] }]);

  await fetchThemesFromAnimeThemes('No Id Anime', []);

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/anime\?/);
});
