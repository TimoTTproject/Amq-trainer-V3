// Tests de routes : /api/playlists (listes nommées, partage entre joueurs) — sans BDD.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakePrisma, createApp } = require('./helpers/api');

const prisma = fakePrisma();
const playlistsRoutes = require('../src/playlists/playlists.routes');

const OWNER = { id: 'u1', email: 'a@b.fr', displayName: 'Timo' };
const OTHER = { id: 'u2', email: 'b@b.fr', displayName: 'Kana' };

function song(over = {}) {
  return { id: 5, animeTitle: 'Bleach', type: 'OP', number: 1, title: 'Song', artist: 'Artist', videoUrl: 'https://x/y.webm', format: 'TV', coverUrl: null, ...over };
}
function playlist(over = {}) {
  return { id: 1, userId: OWNER.id, name: 'Openings énergiques', description: null, isPublic: true, createdAt: new Date(), updatedAt: new Date(), ...over };
}

let app;
test.before(async () => {
  app = await createApp((a) => a.use('/api/playlists', playlistsRoutes.router));
});
test.after(() => app.close());
test.beforeEach(() => {
  prisma.user.findUnique = async ({ where }) => {
    if (where.id === OWNER.id) return OWNER;
    if (where.id === OTHER.id) return OTHER;
    return null;
  };
});

test('mine : liste les playlists du compte avec leur nombre de sons', async () => {
  prisma.playlist.findMany = async () => [{ ...playlist(), _count: { songs: 3 } }];
  const res = await app.request('/api/playlists/mine', { cookie: app.authCookie(OWNER.id) });
  assert.equal(res.status, 200);
  assert.equal(res.json.playlists[0].songCount, 3);
});

test('création : refuse un nom vide, accepte un nom valide', async () => {
  const empty = await app.request('/api/playlists', { method: 'POST', cookie: app.authCookie(OWNER.id), body: { name: '  ' } });
  assert.equal(empty.status, 400);

  prisma.playlist.count = async () => 0;
  prisma.playlist.create = async ({ data }) => ({ id: 42, ...data });
  const ok = await app.request('/api/playlists', {
    method: 'POST', cookie: app.authCookie(OWNER.id), body: { name: 'Ma liste', isPublic: false },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.playlist.id, 42);
  assert.equal(ok.json.playlist.isPublic, false);
});

test('création : plafond de listes par compte', async () => {
  prisma.playlist.count = async () => 30;
  const res = await app.request('/api/playlists', { method: 'POST', cookie: app.authCookie(OWNER.id), body: { name: 'Trop' } });
  assert.equal(res.status, 400);
});

test('détail : 403 si privée et pas propriétaire, 200 si publique', async () => {
  prisma.playlist.findUnique = async () => ({ ...playlist({ isPublic: false }), user: OWNER, songs: [] });
  const forbidden = await app.request('/api/playlists/1', { cookie: app.authCookie(OTHER.id) });
  assert.equal(forbidden.status, 403);

  prisma.playlist.findUnique = async () => ({ ...playlist({ isPublic: true }), user: OWNER, songs: [{ song: song(), addedAt: new Date() }] });
  const ok = await app.request('/api/playlists/1', { cookie: app.authCookie(OTHER.id) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.isOwner, false);
  assert.equal(ok.json.songs.length, 1);
  assert.equal(ok.json.creator.displayName, 'Timo');
});

test('modification/suppression : 404 si pas propriétaire (fuite d\'existence évitée)', async () => {
  prisma.playlist.findUnique = async () => playlist({ userId: OTHER.id });
  const patch = await app.request('/api/playlists/1', { method: 'PATCH', cookie: app.authCookie(OWNER.id), body: { name: 'x' } });
  assert.equal(patch.status, 404);
  const del = await app.request('/api/playlists/1', { method: 'DELETE', cookie: app.authCookie(OWNER.id) });
  assert.equal(del.status, 404);
});

test('modification : renomme correctement', async () => {
  prisma.playlist.findUnique = async () => playlist();
  prisma.playlist.update = async ({ data }) => ({ ...playlist(), ...data });
  const res = await app.request('/api/playlists/1', { method: 'PATCH', cookie: app.authCookie(OWNER.id), body: { name: 'Nouveau nom' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.playlist.name, 'Nouveau nom');
});

test('ajout de son : owner only, 404 si musique inconnue', async () => {
  prisma.playlist.findUnique = async () => playlist();
  prisma.song.findUnique = async () => null;
  const notFound = await app.request('/api/playlists/1/songs', { method: 'POST', cookie: app.authCookie(OWNER.id), body: { songId: 999 } });
  assert.equal(notFound.status, 404);

  prisma.song.findUnique = async () => song();
  prisma.playlistSong.upsert = async () => ({});
  prisma.playlist.update = async () => ({});
  const ok = await app.request('/api/playlists/1/songs', { method: 'POST', cookie: app.authCookie(OWNER.id), body: { songId: 5 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.song.id, 5);

  // Un non-propriétaire ne peut pas ajouter
  const forbidden = await app.request('/api/playlists/1/songs', { method: 'POST', cookie: app.authCookie(OTHER.id), body: { songId: 5 } });
  assert.equal(forbidden.status, 404);
});

test('import-favorites : refuse si la playlist de favoris est vide', async () => {
  prisma.userSongStat.findMany = async () => [];
  const res = await app.request('/api/playlists/import-favorites', { method: 'POST', cookie: app.authCookie(OWNER.id), body: {} });
  assert.equal(res.status, 400);
});

test('import-favorites : crée une liste à partir des favoris actuels', async () => {
  prisma.userSongStat.findMany = async () => [{ songId: 5 }, { songId: 6 }, { songId: 7 }];
  prisma.playlist.count = async () => 0;
  let createdData = null;
  prisma.playlist.create = async ({ data }) => { createdData = data; return { id: 7, name: data.name, description: data.description, isPublic: data.isPublic, _count: { songs: 3 } }; };
  const res = await app.request('/api/playlists/import-favorites', {
    method: 'POST', cookie: app.authCookie(OWNER.id), body: { name: 'Mes favoris', isPublic: false },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.playlist.songCount, 3);
  assert.equal(createdData.userId, OWNER.id);
  assert.equal(createdData.songs.create.length, 3);
});

test('import-favorites : nom par défaut si non fourni', async () => {
  prisma.userSongStat.findMany = async () => [{ songId: 1 }];
  prisma.playlist.count = async () => 0;
  let createdData = null;
  prisma.playlist.create = async ({ data }) => { createdData = data; return { id: 8, ...data, _count: { songs: 1 } }; };
  const res = await app.request('/api/playlists/import-favorites', { method: 'POST', cookie: app.authCookie(OWNER.id), body: {} });
  assert.equal(res.status, 201);
  assert.equal(createdData.name, 'Ma playlist');
});

test('clone : copie une liste publique dans son propre compte, privée par défaut', async () => {
  prisma.playlist.findUnique = async () => ({ ...playlist({ userId: OTHER.id, isPublic: true }), songs: [{ songId: 5 }, { songId: 6 }] });
  prisma.playlist.count = async () => 0;
  let createdData = null;
  prisma.playlist.create = async ({ data }) => { createdData = data; return { id: 99, name: data.name, description: data.description, isPublic: data.isPublic, _count: { songs: 2 } }; };
  const res = await app.request('/api/playlists/1/clone', { method: 'POST', cookie: app.authCookie(OWNER.id) });
  assert.equal(res.status, 201);
  assert.equal(createdData.userId, OWNER.id);
  assert.equal(createdData.isPublic, false); // clone privé par défaut, l'utilisateur choisit ensuite
  assert.equal(createdData.songs.create.length, 2);
});

test('clone : refuse de cloner une liste privée d\'autrui', async () => {
  prisma.playlist.findUnique = async () => ({ ...playlist({ userId: OTHER.id, isPublic: false }), songs: [] });
  const res = await app.request('/api/playlists/1/clone', { method: 'POST', cookie: app.authCookie(OWNER.id) });
  assert.equal(res.status, 403);
});

test('playlists : 401 sans session', async () => {
  const res = await app.request('/api/playlists/mine');
  assert.equal(res.status, 401);
});
