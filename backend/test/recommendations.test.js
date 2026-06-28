const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRecommendations } = require('../src/quiz/recommendations');
const { englishTitleFor } = require('../src/quiz/anime-titles');

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
