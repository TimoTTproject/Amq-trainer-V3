// Routes quiz : tirage, validation de réponse (+ tokens), feedback, notation
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { issueRoundToken, verifyRoundToken, consumeRound } = require('./round-token');
const { isCorrectGuess } = require('./matching');

const router = express.Router();

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
  // Sources d'entraînement (toujours hors classé)
  const source = ['review', 'missed', 'liked'].includes(req.query.source) ? req.query.source : null;

  let songIds;
  if (source) {
    const where = { userId: req.user.id };
    if (source === 'review') where.againCount = { gt: 0 };
    else if (source === 'missed') { where.playCount = { gt: 0 }; where.correctCount = 0; }
    else where.liked = true;
    const stats = await prisma.userSongStat.findMany({ where, select: { songId: true } });
    songIds = stats.map((s) => s.songId);
  } else if (mode === 'mine') {
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
    return res.status(404).json({ error: source ? 'Aucune musique dans cette catégorie pour l\'instant' : 'Aucune musique disponible pour ce mode' });
  }
  const randomId = songIds[Math.floor(Math.random() * songIds.length)];
  const song = await prisma.song.findUnique({
    where: { id: randomId },
    select: { id: true, videoUrl: true },
  });
  // Jeton lié à cette manche : c'est lui qui décidera du classé à la validation.
  const roundToken = issueRoundToken({ userId: req.user.id, songId: song.id, ranked });
  const stat = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId: req.user.id, songId: song.id } },
    select: { liked: true },
  });
  res.json({ song, roundToken, liked: !!stat?.liked });
});

// Like / unlike d'une musique (playlist perso)
router.post('/like', requireAuth, async (req, res) => {
  const { songId, liked } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });
  const stat = await prisma.userSongStat.upsert({
    where: { userId_songId: { userId: req.user.id, songId } },
    update: { liked: !!liked },
    create: { userId: req.user.id, songId, liked: !!liked },
  });
  res.json({ liked: stat.liked });
});

// Compteurs pour le centre d'entraînement
router.get('/training-stats', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const [review, missed, liked, mine] = await Promise.all([
    prisma.userSongStat.count({ where: { userId, againCount: { gt: 0 } } }),
    prisma.userSongStat.count({ where: { userId, playCount: { gt: 0 }, correctCount: 0 } }),
    prisma.userSongStat.count({ where: { userId, liked: true } }),
    prisma.userCatalogEntry.count({ where: { userId } }),
  ]);
  res.json({ review, missed, liked, mine });
});

// Playlist perso : les musiques likées
router.get('/playlist', requireAuth, async (req, res) => {
  const stats = await prisma.userSongStat.findMany({
    where: { userId: req.user.id, liked: true },
    include: { song: true },
    orderBy: { id: 'desc' },
  });
  res.json({
    songs: stats.map((s) => ({
      id: s.song.id, animeTitle: s.song.animeTitle, type: s.song.type, number: s.song.number,
      title: s.song.title, artist: s.song.artist, videoUrl: s.song.videoUrl,
    })),
  });
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
