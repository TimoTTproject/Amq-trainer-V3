// POST /api/quiz/report-song — signalement "ce son ne correspond pas"
// (bouton Château/Multi). Confiance identique à /like : songId vient du
// client mais n'est révélé qu'après la réponse (anti-triche déjà en place),
// donc sûr à accepter tel quel — c'est un simple signal de revue.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const quizRoutes = require('../src/quiz/quiz.routes');

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/quiz', quizRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async () => ({ id: 'u1', email: 'a@b.fr', displayName: 'Timo' });
});

test('report-song : refuse sans songId', async () => {
  const res = await app.request('/api/quiz/report-song', {
    method: 'POST', cookie: app.authCookie('u1'), body: {},
  });
  assert.equal(res.status, 400);
});

test('report-song : crée un SongReport avec le contexte fourni (tronqué), la note tronquée', async () => {
  let created = null;
  prisma.songReport.create = async (args) => { created = args.data; return { id: 1, ...args.data }; };
  const res = await app.request('/api/quiz/report-song', {
    method: 'POST', cookie: app.authCookie('u1'), body: { songId: 42, context: 'tower', note: 'x'.repeat(400) },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(created.userId, 'u1');
  assert.equal(created.songId, 42);
  assert.equal(created.context, 'tower');
  assert.equal(created.note.length, 300);
});

test('report-song : contexte par défaut "quiz" si absent', async () => {
  let created = null;
  prisma.songReport.create = async (args) => { created = args.data; return { id: 1, ...args.data }; };
  const res = await app.request('/api/quiz/report-song', {
    method: 'POST', cookie: app.authCookie('u1'), body: { songId: 5 },
  });
  assert.equal(res.status, 200);
  assert.equal(created.context, 'quiz');
  assert.equal(created.note, null);
});
