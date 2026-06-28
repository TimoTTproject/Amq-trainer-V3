const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRecommendations, artistTokens, isSideContent } = require('../src/quiz/recommendations');
const { englishTitleFor } = require('../src/quiz/anime-titles');

test('artistTokens splits collaborations into individual performers', () => {
  assert.deepEqual(artistTokens('LiSA'), ['lisa']);
  assert.deepEqual(artistTokens('LiSA feat. Tielle'), ['lisa', 'tielle']);
  assert.deepEqual(artistTokens('fhána × ClariS'), ['fhána', 'claris']);
  assert.deepEqual(artistTokens('Aimer & Yuki'), ['aimer', 'yuki']);
});

test('isSideContent flags movies/OVAs/specials but not the main series', () => {
  assert.equal(isSideContent('Bleach'), false);
  assert.equal(isSideContent('Gekijouban Bleach: Memories of Nobody'), true);
  assert.equal(isSideContent('Bleach: The DiamondDust Rebellion (Movie)'), true);
  assert.equal(isSideContent('Naruto OVA'), true);
  assert.equal(isSideContent('Some Anime Specials'), true);
});

test('prioritizes the main series over a movie/OVA of comparable popularity', () => {
  const likedSongs = [{ id: 1, anilistId: 10, animeTitle: 'Bleach', artist: 'Shiro Sagisu', type: 'OP' }];
  const candidates = [
    { id: 2, anilistId: 20, animeTitle: 'Gekijouban Bleach: Memories of Nobody', artist: 'Shiro Sagisu', type: 'OP', popularity: 100 },
    { id: 3, anilistId: 30, animeTitle: 'Bleach: Sennen Kessen-hen', artist: 'Shiro Sagisu', type: 'OP', popularity: 100 },
  ];
  const ranked = rankRecommendations({ likedSongs, candidates, limit: 2 });
  assert.equal(ranked[0].id, 3); // la série principale passe devant le film
});

test('recommends a same-artist track even when credited as a collaboration', () => {
  const likedSongs = [{ id: 1, anilistId: 10, animeTitle: 'A', artist: 'LiSA', type: 'OP' }];
  const candidates = [
    { id: 2, anilistId: 20, animeTitle: 'B', artist: 'LiSA feat. SAWANO', type: 'OP', popularity: 5 },
    { id: 3, anilistId: 30, animeTitle: 'C', artist: 'Someone Else', type: 'OP', popularity: 9999 },
  ];
  const ranked = rankRecommendations({ likedSongs, candidates, limit: 2 });
  assert.equal(ranked[0].id, 2); // l'artiste partagé prime sur la popularité brute
  assert.match(ranked[0].reason, /LiSA/);
});

test('prioritizes related songs and explains the recommendation', () => {
  const likedSongs = [
    { id: 1, anilistId: 10, animeTitle: 'Anime A', artist: 'LiSA', type: 'OP' },
    { id: 2, anilistId: 20, animeTitle: 'Anime B', artist: 'Aimer', type: 'ED' },
  ];
  const candidates = [
    { id: 3, anilistId: 10, animeTitle: 'Anime A', artist: 'Other', type: 'ED', popularity: 10 },
    { id: 4, anilistId: 30, animeTitle: 'Anime C', artist: 'LiSA', type: 'OP', popularity: 50 },
    { id: 5, anilistId: 40, animeTitle: 'Anime D', artist: 'Other', type: 'OP', popularity: 100 },
  ];

  const ranked = rankRecommendations({
    likedSongs,
    candidates,
    collaborativeCounts: new Map([[5, 4]]),
    limit: 3,
  });

  assert.equal(ranked[0].id, 3);
  assert.match(ranked[0].reason, /Anime A/);
  assert.ok(ranked.some((song) => song.reason.includes('joueurs')));
  assert.equal(new Set(ranked.map((song) => song.id)).size, 3);
});

test('keeps the first selection diverse', () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    id: index + 1,
    anilistId: index < 4 ? 10 : index + 10,
    animeTitle: index < 4 ? 'Anime A' : `Anime ${index}`,
    artist: index < 4 ? 'Same Artist' : `Artist ${index}`,
    type: 'OP',
    popularity: 100 - index,
  }));

  const ranked = rankRecommendations({ candidates, limit: 4 });
  assert.ok(ranked.filter((song) => song.anilistId === 10).length <= 2);
});

test('extracts the English AniList title without mistaking synonyms', () => {
  assert.equal(englishTitleFor({
    animeTitle: 'Shingeki no Kyojin',
    altTitles: ['Shingeki no Kyojin', 'Attack on Titan', '進撃の巨人', 'AoT'],
  }), 'Attack on Titan');
  assert.equal(englishTitleFor({
    animeTitle: 'Odd Taxi',
    altTitles: ['Odd Taxi', 'オッドタクシー', 'ODDTAXI'],
  }), null);
});
