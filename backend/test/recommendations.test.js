const test = require('node:test');
const assert = require('node:assert/strict');
const { rankRecommendations, artistTokens, isSideContent, songKey } = require('../src/quiz/recommendations');
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

test('deprioritizes a MOVIE via the AniList format field (no title keyword needed)', () => {
  const likedSongs = [{ id: 1, anilistId: 10, animeTitle: 'Bleach', artist: 'Shiro Sagisu', type: 'OP' }];
  const candidates = [
    // Titre neutre (l'heuristique ne le détecterait pas) mais format = MOVIE
    { id: 2, anilistId: 20, animeTitle: 'Bleach: Memories of Nobody', artist: 'Shiro Sagisu', type: 'OP', popularity: 100, format: 'MOVIE' },
    { id: 3, anilistId: 30, animeTitle: 'Bleach: Sennen Kessen-hen', artist: 'Shiro Sagisu', type: 'OP', popularity: 100, format: 'TV' },
  ];
  const ranked = rankRecommendations({ likedSongs, candidates, limit: 2 });
  assert.equal(ranked[0].id, 3); // la série TV passe devant le film
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

test('never recommends a song already in the playlist, even under a different anilistId', () => {
  // Le catalogue contient parfois un doublon du même opening rattaché à un
  // anilistId différent (film/compilation mal matché à l'import).
  const likedSongs = [
    { id: 1, anilistId: 10, animeTitle: 'Tengen Toppa Gurren Lagann', artist: 'Shouko Nakagawa', type: 'OP', number: 1 },
  ];
  const candidates = [
    { id: 2, anilistId: 999, animeTitle: 'Tengen Toppa Gurren Lagann · Parallel Works', artist: 'Shouko Nakagawa', type: 'OP', number: 1, title: 'Sorairo Days', popularity: 100 },
    { id: 3, anilistId: 30, animeTitle: 'Anime C', artist: 'Other', type: 'OP', number: 1, title: 'Some Song', popularity: 10 },
  ];
  const ranked = rankRecommendations({
    likedSongs: likedSongs.map((s) => ({ ...s, title: 'Sorairo Days' })),
    candidates,
    limit: 5,
  });
  assert.ok(!ranked.some((song) => song.id === 2));
});

test('deduplicates identical candidates catalogued under different anilistIds', () => {
  const candidates = [
    { id: 1, anilistId: 10, animeTitle: 'Anime A', artist: 'Artist', type: 'OP', number: 1, title: 'Song', popularity: 50 },
    { id: 2, anilistId: 20, animeTitle: 'Anime A Movie', artist: 'Artist', type: 'OP', number: 1, title: 'Song', popularity: 5, format: 'MOVIE' },
  ];
  const ranked = rankRecommendations({ candidates, limit: 5 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 1); // garde la version "série principale", pas le film
});

test('deprioritizes (but does not exclude) songs recently shown, so the list rotates', () => {
  const candidates = [
    { id: 1, anilistId: 10, animeTitle: 'Anime A', artist: 'Artist A', type: 'OP', popularity: 50 },
    { id: 2, anilistId: 20, animeTitle: 'Anime B', artist: 'Artist B', type: 'OP', popularity: 48 },
  ];
  // Sans historique : la popularité brute départage (id 1 devant).
  const fresh = rankRecommendations({ candidates, limit: 2 });
  assert.equal(fresh[0].id, 1);

  // Id 1 a déjà été suggéré récemment → il passe derrière, sans disparaître.
  const rotated = rankRecommendations({ candidates, recentlyShownIds: new Set([1]), limit: 2 });
  assert.equal(rotated[0].id, 2);
  assert.equal(rotated.length, 2); // toujours présent, juste rétrogradé
});

test('still recommends recently shown songs when nothing else is available', () => {
  const candidates = [{ id: 1, anilistId: 10, animeTitle: 'Anime A', artist: 'Artist A', type: 'OP', popularity: 50 }];
  const ranked = rankRecommendations({ candidates, recentlyShownIds: new Set([1]), limit: 5 });
  assert.equal(ranked.length, 1); // catalogue restreint : pas de trou dans la liste
  assert.equal(ranked[0].id, 1);
});

test('songKey ignores case/whitespace and identifies the same track regardless of anilistId', () => {
  assert.equal(
    songKey({ type: 'OP', number: 1, title: ' Sorairo Days ', artist: 'Shouko Nakagawa' }),
    songKey({ type: 'OP', number: 1, title: 'sorairo days', artist: 'shouko nakagawa' })
  );
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
