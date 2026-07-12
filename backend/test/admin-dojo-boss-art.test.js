// Tests de route : POST /api/admin/dojo/generate-boss-art — génération IA
// (OpenAI) des portraits de gardiens du Dojo. La génération réelle (appel
// réseau OpenAI + upload R2) n'est pas mockée ici : sans OPENAI_API_KEY dans
// l'environnement de test, tout palier sans art déjà en base échoue de
// façon déterministe et rapide (avant tout appel réseau) avec
// code: 'missing_api_key' — ce qui suffit à vérifier que la route ne
// plante jamais et rapporte l'échec par palier sans bloquer les autres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const adminRoutes = require('../src/admin/admin.routes');

const ADMIN = { id: 'admin1', email: 'melfisk6@gmail.com', displayName: 'Admin' };

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/admin', adminRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  delete process.env.OPENAI_API_KEY; // garantit le chemin d'échec déterministe décrit ci-dessus
  prisma.user.findUnique = async () => ADMIN;
  prisma.character.findMany = async () => [
    { id: 202, name: 'Roronoa Zoro', imageUrl: 'https://cdn.example/zoro.jpg', seriesId: null, series: 'One Piece' },
  ];
});

test('refuse un palier de décor inconnu', async () => {
  const res = await app.request('/api/admin/dojo/generate-boss-art', {
    method: 'POST', cookie: app.authCookie('admin1'), body: { theme: 'inexistant' },
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /inconnu/);
});

test('palier déjà généré (sans force) : sauté, aucune tentative de génération', async () => {
  prisma.dojoBossArt.findUnique = async () => ({ imageUrl: 'https://r2.example/dojo-boss-art/wood-202.png' });
  const res = await app.request('/api/admin/dojo/generate-boss-art', {
    method: 'POST', cookie: app.authCookie('admin1'), body: { theme: 'wood' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].status, 'skipped');
  assert.equal(res.json.results[0].characterId, 202);
});

test('palier sans art existant : tente la génération, échoue proprement sans clé API (pas de crash)', async () => {
  prisma.dojoBossArt.findUnique = async () => null;
  const res = await app.request('/api/admin/dojo/generate-boss-art', {
    method: 'POST', cookie: app.authCookie('admin1'), body: { theme: 'wood' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.results.length, 1);
  assert.equal(res.json.results[0].status, 'error');
  assert.equal(res.json.results[0].code, 'missing_api_key');
});

test('sans theme précisé, boucle sur tous les paliers de décor (10)', async () => {
  prisma.dojoBossArt.findUnique = async () => null;
  const res = await app.request('/api/admin/dojo/generate-boss-art', {
    method: 'POST', cookie: app.authCookie('admin1'), body: {},
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.results.length, 10);
  res.json.results.forEach((r) => assert.equal(r.status, 'error')); // toujours sans clé API ici
});
