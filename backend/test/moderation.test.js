// Modération : un compte banni (bannedAt posé) est refusé par requireAuth ET
// requirePlayer (403 explicite), et les routes admin ban/mute posent les champs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const { requireAuth, requirePlayer } = require('../src/auth/auth.middleware');
const express = require('express');

let app;
let user;
test.before(async () => {
  app = await createApp((a) => {
    const r = express.Router();
    r.get('/auth', requireAuth, (req, res) => res.json({ ok: true }));
    r.get('/player', requirePlayer, (req, res) => res.json({ ok: true }));
    a.use('/api/t', r);
  });
});
test.after(() => app.close());
test.beforeEach(() => {
  user = { id: 'u1', displayName: 'Timo', bannedAt: null };
  prisma.user.findUnique = async ({ where }) => (where.id === 'u1' ? user : null);
});

test('compte sain : accès normal', async () => {
  const r = await app.request('/api/t/auth', { cookie: app.authCookie('u1') });
  assert.equal(r.status, 200);
});

test('compte banni : 403 explicite sur requireAuth et requirePlayer', async () => {
  user.bannedAt = new Date();
  const a = await app.request('/api/t/auth', { cookie: app.authCookie('u1') });
  assert.equal(a.status, 403);
  assert.match(a.json.error, /suspendu/i);
  const p = await app.request('/api/t/player', { cookie: app.authCookie('u1') });
  assert.equal(p.status, 403);
});
