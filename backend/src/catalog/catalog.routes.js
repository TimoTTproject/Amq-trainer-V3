// Routes catalogue : import de liste AniList + consultation
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { preferredMediaUrl } = require('../storage/r2');
const { importUserList } = require('./catalog.service');

const router = express.Router();

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeAniListUsername(value) {
  let username = String(value || '').trim();
  username = username.replace(/^@/, '');
  const profile = username.match(/^https?:\/\/(?:www\.)?anilist\.co\/user\/([^/?#]+)/i);
  if (profile) {
    try {
      username = decodeURIComponent(profile[1]);
    } catch {
      username = profile[1];
    }
  }
  return username.replace(/\/+$/, '').trim();
}

// Import de la liste AniList de l'utilisateur (SSE, avec progression).
// Pseudo : ?username=... ou, à défaut, le pseudo AniList lié au compte.
router.get('/import', requireAuth, async (req, res) => {
  const username = normalizeAniListUsername(req.query.username || req.user.anilistListName || req.user.anilistName);
  const limit = parseInt(req.query.limit) || 100000; // pas de limite : on importe toute la liste
  if (!username) {
    return res.status(400).json({ error: 'Pseudo AniList requis (?username=)' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    sseSend(res, { message: `Début de l'import pour ${username}`, progress: 0 });
    const ownsAniListProfile =
      req.user.anilistName && req.user.anilistName.toLocaleLowerCase() === username.toLocaleLowerCase();
    const result = await importUserList(
      req.user.id,
      username,
      (p) => {
        if (!closed) sseSend(res, p);
      },
      limit,
      ownsAniListProfile ? req.user.anilistToken : undefined
    );
    // Mémorise le pseudo lié au compte (liste préchargée aux sessions suivantes)
    await prisma.user.update({ where: { id: req.user.id }, data: { anilistListName: username } });
    if (!closed) {
      sseSend(res, { completed: true, ...result });
      res.end();
    }
  } catch (err) {
    console.error('Import error:', err.message);
    if (!closed) {
      const message =
        err.status === 404
          ? `Profil AniList « ${username} » introuvable. Vérifie le pseudo (pas le nom affiché) ou connecte AniList si la liste est privée.`
          : err.message;
      sseSend(res, { error: message });
      res.end();
    }
  }
});

// Catalogue perso de l'utilisateur ("ma liste")
router.get('/my-list', requireAuth, async (req, res) => {
  const entries = await prisma.userCatalogEntry.findMany({
    where: { userId: req.user.id },
    include: { song: true },
    orderBy: { song: { animeTitle: 'asc' } },
  });
  res.json({ songs: entries.map((e) => e.song) });
});

// Liste paginée + recherche du catalogue global (anime, OP n°, titre, artiste)
router.get('/list', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 50;
  const q = (req.query.search || '').trim();
  const where = q
    ? {
        OR: [
          { animeTitle: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
          { artist: { contains: q, mode: 'insensitive' } },
        ],
      }
    : {};
  const [total, songs] = await Promise.all([
    prisma.song.count({ where }),
    prisma.song.findMany({
      where,
      orderBy: [{ animeTitle: 'asc' }, { type: 'asc' }, { number: 'asc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: { id: true, animeTitle: true, type: true, number: true, title: true, artist: true, videoUrl: true, audioUrl: true },
    }),
  ]);
  res.json({
    songs: songs.map((song) => ({ ...song, videoUrl: preferredMediaUrl(song), audioUrl: undefined })),
    total,
    page,
    perPage,
    pages: Math.ceil(total / perPage),
  });
});

// Stats du catalogue global
router.get('/stats', async (req, res) => {
  const totalSongs = await prisma.song.count();
  const animes = await prisma.song.findMany({ select: { anilistId: true }, distinct: ['anilistId'] });
  res.json({ totalSongs, totalAnimes: animes.length });
});

module.exports = { router, normalizeAniListUsername };
