// Routes quiz : tirage, validation de réponse (+ tokens), feedback, notation
const express = require('express');
const stringSimilarity = require('string-similarity');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { issueRoundToken, verifyRoundToken, consumeRound } = require('./round-token');

const router = express.Router();

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Distance de Levenshtein (nombre de corrections entre deux chaînes)
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// La réponse est correcte si elle correspond à l'un des titres acceptés
// (romaji/anglais/natif/synonymes), avec tolérance aux petites fautes.
function isCorrectGuess(guess, song) {
  const g = norm(guess);
  if (g.length < 3) return false;
  const candidates = [song.animeTitle, ...(song.altTitles || [])]
    .map(norm)
    .filter((t) => t.length);
  return candidates.some((t) => {
    if (t === g) return true;
    // sous-titre significatif (gère les saisons/parties : "attack on titan" ⊂ "...season 3")
    if (g.length >= 5 && (t.includes(g) || g.includes(t))) return true;
    // 1-2 petites fautes : distance d'édition faible et proportionnée à la longueur
    const dist = editDistance(g, t);
    if (dist <= 2 && dist / Math.max(g.length, t.length) <= 0.25) return true;
    // filet de sécurité : similarité globale
    return stringSimilarity.compareTwoStrings(t, g) >= 0.82;
  });
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
// ?ranked=true|false : fige le mode classé côté serveur (jeton de manche).
router.get('/random', requireAuth, async (req, res) => {
  const mode = req.query.mode === 'global' ? 'global' : 'mine';
  const ranked = req.query.ranked !== 'false'; // défaut : classé

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
  // Jeton lié à cette manche : c'est lui qui décidera du classé à la validation.
  const roundToken = issueRoundToken({ userId: req.user.id, songId: song.id, ranked });
  res.json({ song, roundToken });
});

// Valide la réponse côté serveur, attribue les tokens et révèle l'anime.
router.post('/guess', requireAuth, async (req, res) => {
  const { songId, guess } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });

  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });

  const userId = req.user.id;
  const correct = isCorrectGuess(guess, song);

  // Le mode classé est décidé par le jeton de manche émis au tirage, pas par le
  // client. Sans jeton valide et non rejoué pour CETTE manche → aucun token.
  const round = verifyRoundToken(req.body?.roundToken, { userId, songId });
  const ranked = !!(round && round.ranked && consumeRound(round));

  const prev = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId, songId } },
  });
  const firstCorrect = correct && (!prev || prev.correctCount === 0);
  // Les tokens ne sont gagnés qu'en mode classé
  const reward = correct && ranked ? computeReward(song, firstCorrect) : 0;

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

// Révèle la réponse sans scorer (mode entraînement uniquement).
// Exige un jeton de manche d'entraînement : impossible de révéler une manche classée.
router.get('/answer/:songId', requireAuth, async (req, res) => {
  const songId = parseInt(req.params.songId);
  const round = verifyRoundToken(req.query.roundToken, { userId: req.user.id, songId });
  if (!round || round.ranked) {
    return res.status(403).json({ error: 'Révélation indisponible en mode classé' });
  }
  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });
  res.json({
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
