// Routes quiz : tirage, validation de réponse (+ tokens), feedback, notation
const express = require('express');
const stringSimilarity = require('string-similarity');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');

const router = express.Router();

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// La réponse est correcte si elle correspond à l'un des titres acceptés
// (romaji/anglais/natif/synonymes), avec tolérance aux fautes de frappe.
function isCorrectGuess(guess, song) {
  const g = norm(guess);
  if (g.length < 3) return false;
  const candidates = [song.animeTitle, ...(song.altTitles || [])]
    .map(norm)
    .filter((t) => t.length);
  return candidates.some(
    (t) =>
      t === g ||
      stringSimilarity.compareTwoStrings(t, g) >= 0.82 || // fautes de frappe
      (g.length >= 5 && (t.includes(g) || g.includes(t))) // sous-titre significatif
  );
}

// Récompense en tokens pour une bonne réponse
function computeReward(song, firstCorrect) {
  if (!firstCorrect) return 2; // rejeu : petite récompense (anti-farm)
  let reward = 10;
  const p = song.popularity || 0;
  if (p < 50000) reward += 5; // anime peu connu = plus difficile
  else if (p < 150000) reward += 2;
  return reward;
}

// Tire une musique au hasard. La réponse n'est PAS renvoyée (anti-triche).
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
  const song = await prisma.song.findUnique({
    where: { id: randomId },
    select: { id: true, videoUrl: true },
  });
  res.json({ song });
});

// Valide la réponse côté serveur, attribue les tokens et révèle l'anime.
router.post('/guess', requireAuth, async (req, res) => {
  const { songId, guess } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });

  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });

  const correct = isCorrectGuess(guess, song);

  const userId = req.user.id;
  const prev = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId, songId } },
  });
  const firstCorrect = correct && (!prev || prev.correctCount === 0);
  const reward = correct ? computeReward(song, firstCorrect) : 0;

  const result = await prisma.$transaction(async (tx) => {
    await tx.userSongStat.upsert({
      where: { userId_songId: { userId, songId } },
      update: {
        playCount: { increment: 1 },
        ...(correct ? { correctCount: { increment: 1 } } : {}),
      },
      create: { userId, songId, playCount: 1, correctCount: correct ? 1 : 0 },
    });
    let tokens = req.user.tokens;
    if (reward > 0) {
      const u = await tx.user.update({
        where: { id: userId },
        data: { tokens: { increment: reward } },
      });
      tokens = u.tokens;
      await tx.tokenTransaction.create({
        data: { userId, amount: reward, reason: firstCorrect ? 'quiz_first_correct' : 'quiz_correct' },
      });
    }
    return { tokens };
  });

  res.json({
    correct,
    reward,
    tokens: result.tokens,
    answer: {
      animeTitle: song.animeTitle,
      title: song.title,
      artist: song.artist,
      type: song.type,
      number: song.number,
    },
  });
});

// Feedback de difficulté : easy/hard/again
router.post('/feedback', requireAuth, async (req, res) => {
  const { songId, feedbackType } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });

  const inc = {};
  if (feedbackType === 'easy') inc.easyCount = { increment: 1 };
  if (feedbackType === 'hard') inc.hardCount = { increment: 1 };
  if (feedbackType === 'again') inc.againCount = { increment: 1 };

  const stat = await prisma.userSongStat.upsert({
    where: { userId_songId: { userId: req.user.id, songId } },
    update: inc,
    create: {
      userId: req.user.id,
      songId,
      easyCount: feedbackType === 'easy' ? 1 : 0,
      hardCount: feedbackType === 'hard' ? 1 : 0,
      againCount: feedbackType === 'again' ? 1 : 0,
    },
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

// Stats agrégées de l'utilisateur
router.get('/stats', requireAuth, async (req, res) => {
  const stats = await prisma.userSongStat.findMany({ where: { userId: req.user.id } });
  const played = stats.reduce((s, x) => s + x.playCount, 0);
  const correct = stats.reduce((s, x) => s + x.correctCount, 0);
  res.json({ played, correct, rate: played ? Math.round((correct / played) * 100) : 0 });
});

module.exports = { router };
