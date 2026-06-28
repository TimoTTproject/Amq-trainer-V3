const test = require('node:test');
const assert = require('node:assert/strict');
const { everyoneResolved, availableSongWhere, videoForRound } = require('../src/mp/mp');

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
