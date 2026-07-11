// /api/quiz/guess : plafond anti-farm « doux » — taux plein jusqu'à QUIZ_CAP
// par fenêtre de 6 h, puis régime réduit (~20 %, min 1) au lieu de 0. Et un
// jeton de manche ne compte qu'UNE fois (rejeu = réponse sans enregistrement).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const quizRoutes = require('../src/quiz/quiz.routes');
const { issueRoundToken } = require('../src/quiz/round-token');

const SONG = {
  id: 7, anilistId: 21, animeTitle: 'One Piece', altTitles: ['One Piece'],
  title: 'We Are!', artist: 'Hiroshi Kitadani', type: 'OP', number: 1,
  popularity: 500000, guessRate: null, guessCount: 0, seasonNumber: 0,
};

function dbUser(over = {}) {
  return {
    id: 'u1', email: 'a@b.fr', displayName: 'Timo', tokens: 0,
    quizRewardAt: null, quizRewardWindow: 0,
    ...over,
  };
}

let app;
let user;
let statWrites;
let tokenGrants;
test.before(async () => {
  app = await createApp((a) => a.use('/api/quiz', quizRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  statWrites = [];
  tokenGrants = [];
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
  prisma.song.findUnique = async ({ where }) => (where.id === SONG.id ? { ...SONG } : null);
  prisma.userSongStat.findUnique = async () => null; // jamais joué → firstCorrect
  prisma.userSongStat.upsert = async (args) => { statWrites.push(args); return {}; };
  prisma.dailyStat.upsert = async () => ({});
  prisma.user.update = async ({ data }) => {
    tokenGrants.push(data);
    return { ...user, tokens: (user.tokens || 0) + (data.tokens?.increment || 0) };
  };
  prisma.tokenTransaction.create = async ({ data }) => data;
  prisma.song.update = async () => ({}); // stats globales de difficulté (fire-and-forget)
  // Quêtes (fire-and-forget après la réponse) : neutralisées
  prisma.dailyQuest.findMany = async () => [];
  prisma.dailyQuest.updateMany = async () => ({ count: 0 });
});

function guess(roundToken) {
  return app.request('/api/quiz/guess', {
    method: 'POST',
    cookie: app.authCookie('u1'),
    body: { songId: SONG.id, guess: 'One Piece', roundToken },
  });
}

test('sous le plafond : gain plein, stats enregistrées', async () => {
  const rt = issueRoundToken({ userId: 'u1', songId: SONG.id, ranked: true });
  const r = await guess(rt);
  assert.equal(r.status, 200);
  assert.equal(r.json.correct, true);
  assert.ok(r.json.reward >= 10, `gain plein attendu, reçu ${r.json.reward}`);
  assert.equal(r.json.rewardCap.capped, false);
  assert.equal(statWrites.length, 1);
});

test('plafond atteint : gain réduit (~20 %, min 1) au lieu de 0', async () => {
  user = dbUser({ quizRewardAt: new Date(), quizRewardWindow: 300 }); // fenêtre pleine
  const rt = issueRoundToken({ userId: 'u1', songId: SONG.id, ranked: true });
  const r = await guess(rt);
  assert.equal(r.status, 200);
  assert.equal(r.json.correct, true);
  assert.ok(r.json.reward >= 1, 'jamais 0 au-delà du plafond');
  assert.ok(r.json.reward <= 4, `~20 % du gain attendu, reçu ${r.json.reward}`);
  assert.equal(r.json.rewardCap.capped, true);
  // Le compteur de fenêtre continue d'accumuler le gain réduit.
  assert.equal(tokenGrants[0].quizRewardWindow, 300 + r.json.reward);
});

test('à cheval sur le plafond : plein sur le restant, réduit sur le dépassement', async () => {
  user = dbUser({ quizRewardAt: new Date(), quizRewardWindow: 295 }); // il reste 5 à taux plein
  const rt = issueRoundToken({ userId: 'u1', songId: SONG.id, ranked: true });
  const r = await guess(rt);
  assert.equal(r.status, 200);
  // reward brut = 10 (base, popularité élevée sans bonus) : 5 pleins + ~20 % des 5 restants.
  assert.ok(r.json.reward >= 5 && r.json.reward < 10, `5 pleins + réduit attendu, reçu ${r.json.reward}`);
  assert.equal(r.json.rewardCap.capped, true);
});

test('rejeu du même jeton : réponse renvoyée mais AUCUN enregistrement', async () => {
  const rt = issueRoundToken({ userId: 'u1', songId: SONG.id, ranked: true });
  const first = await guess(rt);
  assert.equal(first.status, 200);
  assert.ok(first.json.reward > 0);
  const replay = await guess(rt);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.correct, true);
  assert.equal(replay.json.reward, 0);
  assert.equal(replay.json.answer.animeTitle, 'One Piece'); // idempotent : réponse dispo
  assert.equal(statWrites.length, 1, 'stats comptées une seule fois');
  assert.equal(tokenGrants.length, 1, 'tokens crédités une seule fois');
});

test('sans jeton de manche : refus (pas de fuite de réponse)', async () => {
  const r = await guess(undefined);
  assert.equal(r.status, 400);
  assert.equal(r.json.answer, undefined);
});
