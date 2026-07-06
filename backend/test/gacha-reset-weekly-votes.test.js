// Réinitialisation admin des votes de vedette hebdo (après changement de raretés).
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const gachaRoutes = require('../src/gacha/gacha.routes');

function dbUser(over = {}) {
  return { id: 'u1', email: 'melfisk6@gmail.com', displayName: 'Admin', tokens: 0, ...over };
}

let app;
let user;
test.before(async () => {
  app = await createApp((a) => a.use('/api/gacha', gachaRoutes.router));
  // Dépendances de getWeeklyFeatured() (appelé en fin de route) : pool vide
  // partout → pas de bannière à construire, on vérifie juste le nettoyage.
  prisma.character.count = async () => 0;
  prisma.character.findFirst = async () => null;
  prisma.appSetting.findUnique = async () => null;
  prisma.featuredVote.groupBy = async () => [];
});
test.after(() => app.close());
test.beforeEach(() => {
  user = dbUser();
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test('reset-weekly-votes : réservé aux admins', async () => {
  user = dbUser({ email: 'joueur@example.com' });
  const res = await app.request('/api/gacha/reset-weekly-votes', { method: 'POST', cookie: app.authCookie('u1') });
  assert.equal(res.status, 403);
});

test('reset-weekly-votes : supprime les votes des 2 semaines concernées', async () => {
  let where = null;
  prisma.featuredVote.deleteMany = async (arg) => { where = arg.where; return { count: 7 }; };
  const res = await app.request('/api/gacha/reset-weekly-votes', { method: 'POST', cookie: app.authCookie('u1') });
  assert.equal(res.status, 200);
  assert.equal(res.json.deletedVotes, 7);
  assert.equal(where.week.in.length, 2);
  assert.equal(typeof res.json.week, 'number');
});
