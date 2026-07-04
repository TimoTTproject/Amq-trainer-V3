// Listes de lecture nommées, partageables entre joueurs. Distinct de « Ma
// playlist » (UserSongStat.liked, cœur ❤ utilisé partout dans le quiz/reco) :
// une Playlist est une liste que le joueur crée volontairement, publique par
// défaut, que les autres peuvent parcourir (onglet Découvrir) et cloner dans
// leur propre compte (copie indépendante, pas de lien vivant avec l'original).
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rateLimit } = require('../util/ratelimit');
const { preferredMediaUrl } = require('../storage/r2');
const { byId, publicCosmetic } = require('../shop/cosmetics');

const router = express.Router();
const MAX_NAME_LEN = 60;
const MAX_DESC_LEN = 200;
const MAX_PLAYLISTS_PER_USER = 30;
const PAGE_SIZE = 20;

function creatorInfo(user) {
  return {
    id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl,
    frame: publicCosmetic(byId(user.avatarFrame)),
  };
}

function songOut(row) {
  const s = row.song;
  return {
    id: s.id, animeTitle: s.animeTitle, type: s.type, number: s.number,
    title: s.title, artist: s.artist, format: s.format || null, coverUrl: s.coverUrl || null,
    videoUrl: preferredMediaUrl(s),
  };
}

async function loadOwnedPlaylist(id, userId) {
  const playlist = await prisma.playlist.findUnique({ where: { id } });
  if (!playlist || playlist.userId !== userId) return null;
  return playlist;
}

// Mes listes (résumé + nombre de sons)
router.get('/mine', requireAuth, async (req, res) => {
  const playlists = await prisma.playlist.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { songs: true } } },
  });
  res.json({
    playlists: playlists.map((p) => ({
      id: p.id, name: p.name, description: p.description, isPublic: p.isPublic,
      songCount: p._count.songs, updatedAt: p.updatedAt,
    })),
  });
});

// Créer une liste
router.post('/', requireAuth, rateLimit({ windowMs: 3600000, max: 20, name: 'playlist-create' }), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Un nom est requis' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Nom trop long (max ${MAX_NAME_LEN} caractères)` });
  const description = String(req.body?.description || '').trim().slice(0, MAX_DESC_LEN) || null;
  const isPublic = req.body?.isPublic !== false;

  const count = await prisma.playlist.count({ where: { userId: req.user.id } });
  if (count >= MAX_PLAYLISTS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_PLAYLISTS_PER_USER} listes par compte` });
  }
  const playlist = await prisma.playlist.create({
    data: { userId: req.user.id, name, description, isPublic },
  });
  res.status(201).json({ playlist: { id: playlist.id, name: playlist.name, description: playlist.description, isPublic: playlist.isPublic, songCount: 0 } });
});

// Importe la playlist de favoris ❤ (UserSongStat.liked) dans une NOUVELLE liste
// nommée — copie ponctuelle, pas de lien vivant (les favoris continuent leur vie
// à part, comme avant ; la liste créée est un instantané au moment de l'import).
router.post('/import-favorites', requireAuth, rateLimit({ windowMs: 3600000, max: 10, name: 'playlist-import-favorites' }), async (req, res) => {
  const name = String(req.body?.name || '').trim() || 'Ma playlist';
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Nom trop long (max ${MAX_NAME_LEN} caractères)` });
  const description = String(req.body?.description || '').trim().slice(0, MAX_DESC_LEN) || null;
  const isPublic = req.body?.isPublic !== false;

  const count = await prisma.playlist.count({ where: { userId: req.user.id } });
  if (count >= MAX_PLAYLISTS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_PLAYLISTS_PER_USER} listes par compte` });
  }
  const liked = await prisma.userSongStat.findMany({ where: { userId: req.user.id, liked: true }, select: { songId: true } });
  if (!liked.length) {
    return res.status(400).json({ error: 'Ta playlist de favoris est vide — like des sons pendant le quiz avant d\'importer.' });
  }
  const playlist = await prisma.playlist.create({
    data: {
      userId: req.user.id, name, description, isPublic,
      songs: { create: liked.map((s) => ({ songId: s.songId })) },
    },
    include: { _count: { select: { songs: true } } },
  });
  res.status(201).json({
    playlist: { id: playlist.id, name: playlist.name, description: playlist.description, isPublic: playlist.isPublic, songCount: playlist._count.songs },
  });
});

// Parcourir les listes publiques des autres joueurs (recherche par nom ou créateur)
router.get('/public', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const q = (req.query.search || '').trim();
  const where = {
    isPublic: true,
    songs: { some: {} }, // masque les listes vides (pas encore utiles à découvrir)
    ...(q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { user: { displayName: { contains: q, mode: 'insensitive' } } }] }
      : {}),
  };
  const [total, playlists] = await Promise.all([
    prisma.playlist.count({ where }),
    prisma.playlist.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        _count: { select: { songs: true } },
        user: { select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true } },
      },
    }),
  ]);
  res.json({
    playlists: playlists.map((p) => ({
      id: p.id, name: p.name, description: p.description,
      songCount: p._count.songs, updatedAt: p.updatedAt,
      creator: creatorInfo(p.user),
    })),
    total, page, pages: Math.ceil(total / PAGE_SIZE),
  });
});

// Détail d'une liste (propriétaire, ou n'importe qui si publique)
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const playlist = await prisma.playlist.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true } },
      songs: { orderBy: { addedAt: 'desc' }, include: { song: true } },
    },
  });
  if (!playlist) return res.status(404).json({ error: 'Liste introuvable' });
  const isOwner = playlist.userId === req.user.id;
  if (!isOwner && !playlist.isPublic) return res.status(403).json({ error: 'Cette liste est privée' });
  res.json({
    id: playlist.id, name: playlist.name, description: playlist.description,
    isPublic: playlist.isPublic, isOwner, creator: creatorInfo(playlist.user),
    songs: playlist.songs.map(songOut),
  });
});

// Modifier une liste (nom / description / visibilité) — propriétaire uniquement
router.patch('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const playlist = await loadOwnedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Liste introuvable' });
  const data = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Un nom est requis' });
    if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Nom trop long (max ${MAX_NAME_LEN} caractères)` });
    data.name = name;
  }
  if (req.body?.description !== undefined) data.description = String(req.body.description || '').trim().slice(0, MAX_DESC_LEN) || null;
  if (req.body?.isPublic !== undefined) data.isPublic = !!req.body.isPublic;
  const updated = await prisma.playlist.update({ where: { id }, data });
  res.json({ playlist: { id: updated.id, name: updated.name, description: updated.description, isPublic: updated.isPublic } });
});

// Supprimer une liste — propriétaire uniquement
router.delete('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const playlist = await loadOwnedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Liste introuvable' });
  await prisma.playlist.delete({ where: { id } });
  res.json({ ok: true });
});

// Ajoute un son — propriétaire uniquement
router.post('/:id/songs', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const songId = parseInt(req.body?.songId);
  if (!songId) return res.status(400).json({ error: 'songId requis' });
  const playlist = await loadOwnedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Liste introuvable' });
  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });
  await prisma.playlistSong.upsert({
    where: { playlistId_songId: { playlistId: id, songId } },
    update: {},
    create: { playlistId: id, songId },
  });
  await prisma.playlist.update({ where: { id }, data: { updatedAt: new Date() } });
  res.status(201).json({ ok: true, song: songOut({ song }) });
});

// Retire un son — propriétaire uniquement
router.delete('/:id/songs/:songId', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const songId = parseInt(req.params.songId);
  const playlist = await loadOwnedPlaylist(id, req.user.id);
  if (!playlist) return res.status(404).json({ error: 'Liste introuvable' });
  await prisma.playlistSong.deleteMany({ where: { playlistId: id, songId } });
  res.json({ ok: true });
});

// Clone une liste publique d'un autre joueur dans son propre compte (copie
// indépendante : les évolutions futures de l'originale ne se répercutent pas).
router.post('/:id/clone', requireAuth, rateLimit({ windowMs: 3600000, max: 15, name: 'playlist-clone' }), async (req, res) => {
  const id = parseInt(req.params.id);
  const source = await prisma.playlist.findUnique({ where: { id }, include: { songs: true } });
  if (!source) return res.status(404).json({ error: 'Liste introuvable' });
  if (!source.isPublic && source.userId !== req.user.id) return res.status(403).json({ error: 'Cette liste est privée' });

  const count = await prisma.playlist.count({ where: { userId: req.user.id } });
  if (count >= MAX_PLAYLISTS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_PLAYLISTS_PER_USER} listes par compte` });
  }
  const name = source.userId === req.user.id ? `${source.name} (copie)` : source.name;
  const clone = await prisma.playlist.create({
    data: {
      userId: req.user.id, name: name.slice(0, MAX_NAME_LEN), description: source.description, isPublic: false,
      songs: { create: source.songs.map((s) => ({ songId: s.songId })) },
    },
    include: { _count: { select: { songs: true } } },
  });
  res.status(201).json({ playlist: { id: clone.id, name: clone.name, description: clone.description, isPublic: clone.isPublic, songCount: clone._count.songs } });
});

module.exports = { router };
