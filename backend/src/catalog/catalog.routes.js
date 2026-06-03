// Routes catalogue : import de liste AniList + consultation
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { importUserList } = require('./catalog.service');

const router = express.Router();

function sseSend(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Import de la liste AniList de l'utilisateur (SSE, avec progression).
// Pseudo : ?username=... ou, à défaut, le pseudo AniList lié au compte.
router.get('/import', requireAuth, async (req, res) => {
  const username = req.query.username || req.user.anilistName;
  const limit = parseInt(req.query.limit) || 1000;
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
    const result = await importUserList(
      req.user.id,
      username,
      (p) => {
        if (!closed) sseSend(res, p);
      },
      limit
    );
    if (!closed) {
      sseSend(res, { completed: true, ...result });
      res.end();
    }
  } catch (err) {
    console.error('Import error:', err.message);
    if (!closed) {
      sseSend(res, { error: err.message });
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

// Stats du catalogue global
router.get('/stats', async (req, res) => {
  const totalSongs = await prisma.song.count();
  const animes = await prisma.song.findMany({ select: { anilistId: true }, distinct: ['anilistId'] });
  res.json({ totalSongs, totalAnimes: animes.length });
});

module.exports = { router };
