const test = require('node:test');
const assert = require('node:assert/strict');
const { everyoneResolved, availableSongWhere } = require('../src/mp/mp');

function roomWithTwoPlayers() {
  return {
    players: new Map([
      ['u1', { userId: 'u1', connected: true, eliminated: false }],
      ['u2', { userId: 'u2', connected: true, eliminated: false }],
    ]),
    current: { answers: new Map(), passed: new Set() },
    usedAnilistIds: new Set(),
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
