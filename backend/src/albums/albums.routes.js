// Albums de cartes nommés, partageables entre joueurs — même principe que les
// Playlist de musiques (playlists.routes.js), mais pour les personnages du
// gacha : un joueur range les cartes qu'il possède dans un album (« Mes One
// Piece », « Mes 5 étoiles »...), public par défaut, que d'autres peuvent
// parcourir (onglet Découvrir) et cloner dans leur propre compte.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { rateLimit } = require('../util/ratelimit');
const { byId, publicCosmetic } = require('../shop/cosmetics');

const router = express.Router();
const MAX_NAME_LEN = 60;
const MAX_DESC_LEN = 200;
const MAX_ALBUMS_PER_USER = 30;
const PAGE_SIZE = 20;

function creatorInfo(user) {
  return {
    id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl,
    frame: publicCosmetic(byId(user.avatarFrame)),
  };
}

function cardOut(row) {
  const c = row.character;
  return {
    id: c.id, name: c.name, imageUrl: c.imageUrl, rarity: c.rarity,
    series: c.series || null,
  };
}

async function loadOwnedAlbum(id, userId) {
  const album = await prisma.cardAlbum.findUnique({ where: { id } });
  if (!album || album.userId !== userId) return null;
  return album;
}

// Mes albums (résumé + nombre de cartes). Avec ?characterId=X, ajoute `has` par
// album (cette carte y figure déjà) — utilisé par le picker « Ajouter à un album ».
router.get('/mine', requireAuth, async (req, res) => {
  const characterId = parseInt(req.query.characterId);
  const albums = await prisma.cardAlbum.findMany({
    where: { userId: req.user.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { cards: true } },
      ...(characterId ? { cards: { where: { characterId }, select: { id: true } } } : {}),
    },
  });
  res.json({
    albums: albums.map((a) => ({
      id: a.id, name: a.name, description: a.description, isPublic: a.isPublic,
      cardCount: a._count.cards, updatedAt: a.updatedAt,
      ...(characterId ? { has: a.cards.length > 0 } : {}),
    })),
  });
});

// Créer un album
router.post('/', requireAuth, rateLimit({ windowMs: 3600000, max: 20, name: 'album-create' }), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Un nom est requis' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Nom trop long (max ${MAX_NAME_LEN} caractères)` });
  const description = String(req.body?.description || '').trim().slice(0, MAX_DESC_LEN) || null;
  const isPublic = req.body?.isPublic !== false;

  const count = await prisma.cardAlbum.count({ where: { userId: req.user.id } });
  if (count >= MAX_ALBUMS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_ALBUMS_PER_USER} albums par compte` });
  }
  const album = await prisma.cardAlbum.create({
    data: { userId: req.user.id, name, description, isPublic },
  });
  res.status(201).json({ album: { id: album.id, name: album.name, description: album.description, isPublic: album.isPublic, cardCount: 0 } });
});

// Parcourir les albums publics des autres joueurs (recherche par nom ou créateur)
router.get('/public', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const q = (req.query.search || '').trim();
  const where = {
    isPublic: true,
    cards: { some: {} }, // masque les albums vides
    ...(q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { user: { displayName: { contains: q, mode: 'insensitive' } } }] }
      : {}),
  };
  const [total, albums] = await Promise.all([
    prisma.cardAlbum.count({ where }),
    prisma.cardAlbum.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        _count: { select: { cards: true } },
        user: { select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true } },
      },
    }),
  ]);
  res.json({
    albums: albums.map((a) => ({
      id: a.id, name: a.name, description: a.description,
      cardCount: a._count.cards, updatedAt: a.updatedAt,
      creator: creatorInfo(a.user),
    })),
    total, page, pages: Math.ceil(total / PAGE_SIZE),
  });
});

// Détail d'un album (propriétaire, ou n'importe qui si public)
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const album = await prisma.cardAlbum.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true } },
      cards: { orderBy: { addedAt: 'desc' }, include: { character: true } },
    },
  });
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  const isOwner = album.userId === req.user.id;
  if (!isOwner && !album.isPublic) return res.status(403).json({ error: 'Cet album est privé' });
  res.json({
    id: album.id, name: album.name, description: album.description,
    isPublic: album.isPublic, isOwner, creator: creatorInfo(album.user),
    cards: album.cards.map(cardOut),
  });
});

// Modifier un album (nom / description / visibilité) — propriétaire uniquement
router.patch('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const album = await loadOwnedAlbum(id, req.user.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  const data = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Un nom est requis' });
    if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Nom trop long (max ${MAX_NAME_LEN} caractères)` });
    data.name = name;
  }
  if (req.body?.description !== undefined) data.description = String(req.body.description || '').trim().slice(0, MAX_DESC_LEN) || null;
  if (req.body?.isPublic !== undefined) data.isPublic = !!req.body.isPublic;
  const updated = await prisma.cardAlbum.update({ where: { id }, data });
  res.json({ album: { id: updated.id, name: updated.name, description: updated.description, isPublic: updated.isPublic } });
});

// Supprimer un album — propriétaire uniquement
router.delete('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const album = await loadOwnedAlbum(id, req.user.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  await prisma.cardAlbum.delete({ where: { id } });
  res.json({ ok: true });
});

// Ajoute une carte — propriétaire uniquement, et seulement une carte possédée
// (un album range les cartes qu'on a, pas n'importe quel personnage du jeu).
router.post('/:id/cards', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const characterId = parseInt(req.body?.characterId);
  if (!characterId) return res.status(400).json({ error: 'characterId requis' });
  const album = await loadOwnedAlbum(id, req.user.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  const owned = await prisma.userCard.findUnique({
    where: { userId_characterId: { userId: req.user.id, characterId } },
  });
  if (!owned) return res.status(400).json({ error: 'Tu ne possèdes pas cette carte' });
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) return res.status(404).json({ error: 'Personnage introuvable' });
  await prisma.cardAlbumItem.upsert({
    where: { albumId_characterId: { albumId: id, characterId } },
    update: {},
    create: { albumId: id, characterId },
  });
  await prisma.cardAlbum.update({ where: { id }, data: { updatedAt: new Date() } });
  res.status(201).json({ ok: true, card: cardOut({ character }) });
});

// Retire une carte — propriétaire uniquement
router.delete('/:id/cards/:characterId', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const characterId = parseInt(req.params.characterId);
  const album = await loadOwnedAlbum(id, req.user.id);
  if (!album) return res.status(404).json({ error: 'Album introuvable' });
  await prisma.cardAlbumItem.deleteMany({ where: { albumId: id, characterId } });
  res.json({ ok: true });
});

// Clone un album public d'un autre joueur dans son propre compte — copie
// indépendante, limitée aux cartes que TU possèdes déjà (on ne peut pas cloner
// des cartes qu'on n'a pas obtenues).
router.post('/:id/clone', requireAuth, rateLimit({ windowMs: 3600000, max: 15, name: 'album-clone' }), async (req, res) => {
  const id = parseInt(req.params.id);
  const source = await prisma.cardAlbum.findUnique({ where: { id }, include: { cards: true } });
  if (!source) return res.status(404).json({ error: 'Album introuvable' });
  if (!source.isPublic && source.userId !== req.user.id) return res.status(403).json({ error: 'Cet album est privé' });

  const count = await prisma.cardAlbum.count({ where: { userId: req.user.id } });
  if (count >= MAX_ALBUMS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_ALBUMS_PER_USER} albums par compte` });
  }
  const owned = await prisma.userCard.findMany({
    where: { userId: req.user.id, characterId: { in: source.cards.map((c) => c.characterId) } },
    select: { characterId: true },
  });
  const ownedSet = new Set(owned.map((c) => c.characterId));
  const name = source.userId === req.user.id ? `${source.name} (copie)` : source.name;
  const clone = await prisma.cardAlbum.create({
    data: {
      userId: req.user.id, name: name.slice(0, MAX_NAME_LEN), description: source.description, isPublic: false,
      cards: { create: source.cards.filter((c) => ownedSet.has(c.characterId)).map((c) => ({ characterId: c.characterId })) },
    },
    include: { _count: { select: { cards: true } } },
  });
  res.status(201).json({ album: { id: clone.id, name: clone.name, description: clone.description, isPublic: clone.isPublic, cardCount: clone._count.cards } });
});

module.exports = { router };
