const test = require('node:test');
const assert = require('node:assert/strict');
const { everyoneResolved, availableSongWhere, videoForRound, rawReward, unlockedEmoteSymbols, MP_GAME_CAP } = require('../src/mp/mp');

test('rawReward = bonnes réponses ×2 + bonus de placement, plafonné par partie', () => {
  assert.equal(rawReward({ correct: 0 }, 1), 20); // 0 + bonus 1er
  assert.equal(rawReward({ correct: 5 }, 1), 30); // 10 + 20
  assert.equal(rawReward({ correct: 3 }, 2), 16); // 6 + 10
  assert.equal(rawReward({ correct: 1 }, 4), 2); // placement >3 → pas de bonus
  assert.equal(rawReward({ correct: 100 }, 1), MP_GAME_CAP); // plafonné
});

function roomWithTwoPlayers() {
  return {
    players: new Map([
      ['u1', { userId: 'u1', connected: true, eliminated: false }],
      ['u2', { userId: 'u2', connected: true, eliminated: false }],
    ]),
    current: { answers: new Map(), passed: new Set() },
    usedAnilistIds: new Set(),
    settings: { themeType: 'all' },
  };
}

test('ends a round when every player answered or passed', () => {
  const room = roomWithTwoPlayers();
  room.current.answers.set('u1', { correct: false, points: 0 });
  assert.equal(everyoneResolved(room), false);
  room.current.passed.add('u2');
  assert.equal(everyoneResolved(room), true);
});

test('excludes every anime already played in the match', () => {
  const room = roomWithTwoPlayers();
  assert.deepEqual(availableSongWhere(room), { videoUrl: { not: null } });
  room.usedAnilistIds.add(21);
  room.usedAnilistIds.add(42);
  assert.deepEqual(availableSongWhere(room), {
    videoUrl: { not: null },
    anilistId: { notIn: [21, 42] },
  });
});

test('filters multiplayer songs by opening or ending', () => {
  const room = roomWithTwoPlayers();
  room.settings.themeType = 'ED';
  assert.deepEqual(availableSongWhere(room), {
    videoUrl: { not: null },
    type: 'ED',
  });
});

test('limits quick matches to the combined song lists of present players', () => {
  const room = roomWithTwoPlayers();
  room.songPoolIds = [12, 34, 56];
  assert.deepEqual(availableSongWhere(room), {
    videoUrl: { not: null },
    id: { in: [12, 34, 56] },
  });
});

test('adds only purchased anime emotes to the free multiplayer reactions', () => {
  const free = unlockedEmoteSymbols([]);
  const unlocked = unlockedEmoteSymbols(['emote-naruto', 'emote-death-note', 'unknown']);
  assert.equal(unlocked.length, free.length + 2);
  assert.ok(unlocked.some((item) => item.id === 'emote-naruto' && item.imageUrl.endsWith('/official/sharingan.png')));
  assert.ok(unlocked.some((item) => item.id === 'emote-death-note' && item.imageUrl.endsWith('/official/death-note.jpg')));
});

test('serves the preloaded song only for the upcoming round', () => {
  const room = {
    round: 2,
    current: null,
    nextSong: { videoUrl: 'next.webm' },
    revealSong: { videoUrl: 'current.webm' },
    revealUntil: Date.now() + 1000,
  };
  assert.equal(videoForRound(room, 2), 'current.webm');
  assert.equal(videoForRound(room, 3), 'next.webm');
  assert.equal(videoForRound(room, 4), null);
});
