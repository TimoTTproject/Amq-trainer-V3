const test = require('node:test');
const assert = require('node:assert/strict');
const {
  everyoneResolved, availableSongWhere, videoForRound, rawReward, unlockedEmoteSymbols, MP_GAME_CAP,
  skipVotesNeeded, skipVoteCount, publishGlobalChatSystem, reactGlobalChatMessage,
} = require('../src/mp/mp');

test('chat global : une annonce de recrutement précieux est structurée côté serveur',()=>{
  const message=publishGlobalChatSystem({type:'recruit',rarity:'mythic',player:'Melfisk',character:'Rustang',text:'Melfisk a recruté Rustang · MYTHIQUE'});
  assert.equal(message.system,true);
  assert.equal(message.type,'recruit');
  assert.equal(message.rarity,'mythic');
  assert.equal(message.player,'Melfisk');
  assert.equal(message.character,'Rustang');
  assert.ok(Number.isFinite(message.ts));
});

test('chat global : les réactions communautaires sont validées et basculent par joueur',()=>{
  const message=publishGlobalChatSystem({type:'prestige',player:'Parialo',prestigeLevel:3,stage:140,reward:4,text:'Parialo atteint le Prestige 3'});
  assert.ok(message.id);
  assert.deepEqual(reactGlobalChatMessage({messageId:message.id,emoji:'🔥',userId:'u1'}).reactions,{'🔥':1});
  assert.deepEqual(reactGlobalChatMessage({messageId:message.id,emoji:'🔥',userId:'u2'}).reactions,{'🔥':2});
  assert.deepEqual(reactGlobalChatMessage({messageId:message.id,emoji:'🔥',userId:'u1'}).reactions,{'🔥':1});
  assert.equal(reactGlobalChatMessage({messageId:message.id,emoji:'💀',userId:'u3'}),null);
});

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

test('coop is openings-only, whatever the room setting says', () => {
  const room = roomWithTwoPlayers();
  room.mode = 'coop';
  room.settings.themeType = 'ED'; // le réglage du salon est ignoré en coop
  assert.deepEqual(availableSongWhere(room), {
    videoUrl: { not: null },
    type: 'OP',
  });
  room.settings.themeType = 'all';
  assert.equal(availableSongWhere(room).type, 'OP');
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
  assert.ok(unlocked.some((item) => item.id === 'emote-naruto' && item.imageUrl.endsWith('/emotes/sharingan.svg')));
  assert.ok(unlocked.some((item) => item.id === 'emote-death-note' && item.imageUrl.endsWith('/emotes/death-note.svg')));
});

test('vote-skip needs a strict majority of active (connected, non-eliminated) players', () => {
  const room = roomWithTwoPlayers();
  assert.equal(skipVotesNeeded(room), 2); // 2 joueurs → les 2 (moitié seule n'est pas une majorité)
  room.players.set('u3', { userId: 'u3', connected: true, eliminated: false });
  assert.equal(skipVotesNeeded(room), 2); // 3 joueurs → 2 votes
  room.players.get('u2').connected = false; // déconnecté → hors quorum
  assert.equal(skipVotesNeeded(room), 2); // 2 actifs restants (u1, u3) → les 2
});

test('vote-skip always requires at least one vote, even with zero eligible players', () => {
  const room = roomWithTwoPlayers();
  room.players.get('u1').eliminated = true;
  room.players.get('u2').eliminated = true;
  assert.equal(skipVotesNeeded(room), 1); // jamais 0 (pas de skip automatique)
});

test('skipVoteCount only counts votes from currently eligible players', () => {
  const room = roomWithTwoPlayers();
  room.current.skipVotes = new Set(['u1']);
  assert.equal(skipVoteCount(room), 1);
  room.current.skipVotes.add('u2');
  assert.equal(skipVoteCount(room), 2);
  // u2 se déconnecte : son vote antérieur ne compte plus tant qu'il n'est pas revenu.
  room.players.get('u2').connected = false;
  assert.equal(skipVoteCount(room), 1);
  // Un joueur éliminé ne peut pas non plus faire pencher le quorum.
  room.players.get('u1').eliminated = true;
  assert.equal(skipVoteCount(room), 0);
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
