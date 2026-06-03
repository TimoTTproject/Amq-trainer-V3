// Routes quiz : tirage aléatoire + feedback/notation (par utilisateur)
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');

const router = express.Router();

// Tire une musique au hasard.
// ?mode=mine (catalogue perso, défaut) | global (catalogue partagé)
router.get('/random', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'global' ? 'global' : 'mine';

  let songIds;
  if (mode === 'mine') {
    const entries = await prisma.userCatalogEntry.findMany({
      where: { userId: req.user.id },
      select: { songId: true },
    });
    songIds = entries.map((e) => e.songId);
  } else {
    const all = await prisma.song.findMany({ select: { id: true } });
    songIds = all.map((s) => s.id);
  }

  if (!songIds.length) {
    return res.status(404).json({ error: 'Aucune musique disponible pour ce mode' });
  }
  const randomId = songIds[Math.floor(Math.random() * songIds.length)];
  const song = await prisma.song.findUnique({ where: { id: randomId } });
  res.json({ song, answer: song.animeTitle });
});

// Feedback de fin de question : easy/hard/again + correct/incorrect
router.post('/feedback', requireAuth, async (req, res) => {
  const { songId, feedbackType, correct } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });

  const data = { playCount: { increment: 1 } };
  if (feedbackType === 'easy') data.easyCount = { increment: 1 };
  if (feedbackType === 'hard') data.hardCount = { increment: 1 };
  if (feedbackType === 'again') data.againCount = { increment: 1 };
  if (correct) data.correctCount = { increment: 1 };

  const createData = {
    userId: req.user.id,
    songId,
    playCount: 1,
    easyCount: feedbackType === 'easy' ? 1 : 0,
    hardCount: feedbackType === 'hard' ? 1 : 0,
    againCount: feedbackType === 'again' ? 1 : 0,
    correctCount: correct ? 1 : 0,
  };

  const stat = await prisma.userSongStat.upsert({
    where: { userId_songId: { userId: req.user.id, songId } },
    update: data,
    create: createData,
  });
  res.json({ success: true, stat });
});

// Noter une musique (1-5)
router.post('/rate', requireAuth, async (req, res) => {
  const { songId, rating } = req.body || {};
  if (!songId || rating == null) return res.status(400).json({ error: 'songId et rating requis' });
  const stat = await prisma.userSongStat.upsert({
    where: { userId_songId: { userId: req.user.id, songId } },
    update: { rating },
    create: { userId: req.user.id, songId, rating },
  });
  res.json({ success: true, stat });
});

// Stats agrégées de l'utilisateur (pour le menu Statistiques)
router.get('/stats', requireAuth, async (req, res) => {
  const stats = await prisma.userSongStat.findMany({ where: { userId: req.user.id } });
  const played = stats.reduce((s, x) => s + x.playCount, 0);
  const correct = stats.reduce((s, x) => s + x.correctCount, 0);
  res.json({ played, correct, rate: played ? Math.round((correct / played) * 100) : 0 });
});

module.exports = { router };
