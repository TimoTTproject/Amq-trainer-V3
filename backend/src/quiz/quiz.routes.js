// Routes quiz : tirage, validation de réponse (+ tokens), feedback, notation
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { issueRoundToken, verifyRoundToken, consumeRound } = require('./round-token');
const { isCorrectGuess } = require('./matching');
const { proxyVideo } = require('../util/stream');
const { rateLimit } = require('../util/ratelimit');
const { progressQuests, todayStr } = require('../quests/quests');
const { rankRecommendations } = require('./recommendations');

const router = express.Router();

// Multiplicateur de récompense selon le niveau d'aide (Duo/Carré/Cash)
const LEVEL_MULT = { cash: 1, carre: 0.5, duo: 0.3 };
const LEVEL_COUNT = { carre: 4, duo: 2 };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Propositions pour Carré/Duo : bonne réponse + distracteurs (animes distincts)
async function buildChoices(song, count) {
  const titles = new Set([song.animeTitle]);
  const total = await prisma.song.count();
  let guard = 0;
  while (titles.size < count && guard++ < 40) {
    const s = await prisma.song.findFirst({
      skip: Math.floor(Math.random() * total),
      select: { animeTitle: true },
    });
    if (s) titles.add(s.animeTitle);
  }
  return shuffle([...titles]);
}

// Répétition espacée : prochaine échéance selon la série de bonnes réponses.
const SRS_STEPS = [1, 2, 4, 8, 16, 32, 60]; // jours
function nextSrs(streak, correct) {
  if (!correct) return { srsStreak: 0, srsInterval: 0, srsDueAt: new Date(Date.now() + 10 * 60 * 1000) }; // revoir vite
  const s = (streak || 0) + 1;
  const interval = SRS_STEPS[Math.min(s - 1, SRS_STEPS.length - 1)];
  return { srsStreak: s, srsInterval: interval, srsDueAt: new Date(Date.now() + interval * 86400000) };
}

// Liste de révision automatique : sons mal maîtrisés (taux de réussite faible),
// jamais trouvés, ou marqués « À revoir » manuellement. Liée au compte.
async function getReviewSongIds(userId) {
  const stats = await prisma.userSongStat.findMany({
    where: { userId, OR: [{ playCount: { gt: 0 } }, { againCount: { gt: 0 } }] },
    select: { songId: true, playCount: true, correctCount: true, againCount: true },
  });
  return stats
    .filter(
      (s) =>
        s.againCount > 0 || // marqué manuellement
        (s.playCount > 0 && s.correctCount === 0) || // jamais trouvé
        (s.playCount >= 2 && s.correctCount * 2 < s.playCount) // < 50% de réussite
    )
    .map((s) => s.songId);
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
  // Sources d'entraînement (toujours hors classé)
  const source = ['review', 'missed', 'liked', 'due', 'series'].includes(req.query.source) ? req.query.source : null;
  // Filtre type de thème : 'OP' | 'ED' | (rien = les deux)
  const typeFilter = ['OP', 'ED'].includes(req.query.type) ? req.query.type : null;

  let song = null;
  if (!source && mode === 'global') {
    // Perf : on évite de charger tous les ids → count + skip aléatoire
    const where = { videoUrl: { not: null }, ...(typeFilter ? { type: typeFilter } : {}) };
    const total = await prisma.song.count({ where });
    if (!total) return res.status(404).json({ error: 'Aucune musique disponible' });
    song = await prisma.song.findFirst({ where, skip: Math.floor(Math.random() * total), select: { id: true, videoUrl: true } });
  } else {
    let songIds;
    if (source === 'review') {
      songIds = await getReviewSongIds(req.user.id);
    } else if (source === 'due') {
      const stats = await prisma.userSongStat.findMany({
        where: { userId: req.user.id, srsDueAt: { not: null, lte: new Date() } },
        select: { songId: true },
      });
      songIds = stats.map((s) => s.songId);
    } else if (source === 'series') {
      const series = (req.query.series || '').trim();
      const rows = await prisma.song.findMany({ where: { animeTitle: series, videoUrl: { not: null }, ...(typeFilter ? { type: typeFilter } : {}) }, select: { id: true } });
      songIds = rows.map((r) => r.id);
    } else if (source) {
      const where = { userId: req.user.id };
      if (source === 'missed') { where.playCount = { gt: 0 }; where.correctCount = 0; }
      else where.liked = true;
      const stats = await prisma.userSongStat.findMany({ where, select: { songId: true } });
      songIds = stats.map((s) => s.songId);
    } else {
      const entries = await prisma.userCatalogEntry.findMany({ where: { userId: req.user.id }, select: { songId: true } });
      songIds = entries.map((e) => e.songId);
    }
    // Filtre OP/ED sur les ids retenus (sauf déjà filtré pour 'series')
    if (typeFilter && source !== 'series' && songIds.length) {
      const f = await prisma.song.findMany({ where: { id: { in: songIds }, type: typeFilter }, select: { id: true } });
      songIds = f.map((s) => s.id);
    }
    if (!songIds.length) {
      return res.status(404).json({ error: source ? 'Aucune musique dans cette catégorie pour l\'instant' : 'Aucune musique disponible pour ce mode' });
    }
    const randomId = songIds[Math.floor(Math.random() * songIds.length)];
    song = await prisma.song.findUnique({ where: { id: randomId }, select: { id: true, videoUrl: true } });
  }
  if (!song) return res.status(404).json({ error: 'Aucune musique disponible' });
  // Jeton lié à cette manche (niveau « cash » par défaut = texte libre, gain plein).
  const roundToken = issueRoundToken({ userId: req.user.id, songId: song.id, ranked, level: 'cash' });
  const stat = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId: req.user.id, songId: song.id } },
    select: { liked: true },
  });
  // On ne renvoie PAS l'URL .webm (anti-triche) : le client lit le flux proxifié.
  res.json({ song: { id: song.id }, roundToken, liked: !!stat?.liked });
});

// Flux vidéo de la manche, proxifié (le titre ne fuite pas par l'URL). Le jeton
// de manche doit correspondre à cet utilisateur et cette musique.
router.get('/clip/:songId', requireAuth, async (req, res) => {
  const songId = parseInt(req.params.songId);
  const round = verifyRoundToken(req.query.rt, { userId: req.user.id, songId });
  if (!round) return res.status(403).end();
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { videoUrl: true } });
  if (!song?.videoUrl) return res.status(404).end();
  await proxyVideo(req, res, song.videoUrl);
});

// Passe en Carré (4) ou Duo (2) : verrouille le niveau (gain réduit) dans un
// nouveau jeton et renvoie les propositions. L'ancien jeton est consommé pour
// empêcher de revenir au gain « cash » après avoir vu les propositions.
router.post('/choices', requireAuth, rateLimit({ max: 120, name: 'choices' }), async (req, res) => {
  const level = req.body?.level === 'duo' ? 'duo' : 'carre';
  const round = verifyRoundToken(req.body?.roundToken, { userId: req.user.id });
  if (!round) return res.status(400).json({ error: 'Manche invalide' });
  if (!(await consumeRound(round))) return res.status(409).json({ error: 'Manche déjà jouée' });

  const song = await prisma.song.findUnique({ where: { id: round.sid } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });

  const options = await buildChoices(song, LEVEL_COUNT[level]);
  const roundToken = issueRoundToken({ userId: req.user.id, songId: round.sid, ranked: round.ranked, level });
  res.json({ options, roundToken, level });
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
  if (stat.liked) progressQuests(req.user.id, 'like', 1);
  res.json({ liked: stat.liked });
});

// Compteurs pour le centre d'entraînement
router.get('/training-stats', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const [reviewIds, missed, liked, mine, due, scheduled, mastered] = await Promise.all([
    getReviewSongIds(userId),
    prisma.userSongStat.count({ where: { userId, playCount: { gt: 0 }, correctCount: 0 } }),
    prisma.userSongStat.count({ where: { userId, liked: true } }),
    prisma.userCatalogEntry.count({ where: { userId } }),
    prisma.userSongStat.count({ where: { userId, srsDueAt: { not: null, lte: now } } }),
    prisma.userSongStat.count({ where: { userId, srsDueAt: { not: null } } }),
    prisma.userSongStat.count({ where: { userId, srsInterval: { gte: 30 } } }),
  ]);
  res.json({ review: reviewIds.length, missed, liked, mine, due, scheduled, mastered });
});

// Recherche de séries (animes) pour l'entraînement ciblé
router.get('/series', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ series: [] });
  const rows = await prisma.song.findMany({
    where: { animeTitle: { contains: q, mode: 'insensitive' }, videoUrl: { not: null } },
    distinct: ['animeTitle'],
    select: { animeTitle: true },
    take: 20,
    orderBy: { animeTitle: 'asc' },
  });
  res.json({ series: rows.map((r) => r.animeTitle) });
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

// Recommandations personnalisées : proximité de contenu + goûts collectifs
// anonymisés + popularité. Aucun service externe ni profilage nominatif.
router.get('/playlist/recommendations', requireAuth, rateLimit({ max: 30, name: 'playlist-recommendations' }), async (req, res) => {
  const userId = req.user.id;
  const likedStats = await prisma.userSongStat.findMany({
    where: { userId, liked: true },
    include: { song: true },
    take: 500,
  });
  const likedSongs = likedStats.map((stat) => stat.song);
  const likedIds = likedSongs.map((song) => song.id);
  const artists = [...new Set(likedSongs.map((song) => song.artist).filter(Boolean))];
  const anilistIds = [...new Set(likedSongs.map((song) => song.anilistId))];

  let collaborativeCounts = new Map();
  if (likedIds.length) {
    try {
      const neighbors = await prisma.userSongStat.groupBy({
        by: ['userId'],
        where: { liked: true, songId: { in: likedIds }, userId: { not: userId } },
        _count: { songId: true },
        orderBy: { _count: { songId: 'desc' } },
        take: 40,
      });
      if (neighbors.length) {
        const coLikes = await prisma.userSongStat.groupBy({
          by: ['songId'],
          where: {
            liked: true,
            userId: { in: neighbors.map((row) => row.userId) },
            songId: { notIn: likedIds },
          },
          _count: { userId: true },
          orderBy: { _count: { userId: 'desc' } },
          take: 120,
        });
        collaborativeCounts = new Map(coLikes.map((row) => [row.songId, row._count.userId]));
      }
    } catch (err) {
      // Les recommandations de contenu restent disponibles même si l'agrégat
      // collaboratif n'est pas supporté ou rencontre une donnée inattendue.
      console.warn('Collaborative recommendations unavailable:', err.message);
    }
  }

  const baseWhere = { videoUrl: { not: null } };
  if (likedIds.length) baseWhere.id = { notIn: likedIds };
  const tasteSignals = [];
  if (artists.length) tasteSignals.push({ artist: { in: artists } });
  if (anilistIds.length) tasteSignals.push({ anilistId: { in: anilistIds } });
  if (collaborativeCounts.size) tasteSignals.push({ id: { in: [...collaborativeCounts.keys()] } });

  const select = {
    id: true, anilistId: true, animeTitle: true, type: true, number: true,
    title: true, artist: true, videoUrl: true, popularity: true,
  };
  let tasteCandidates = [];
  let popularCandidates = [];
  try {
    [tasteCandidates, popularCandidates] = await Promise.all([
      tasteSignals.length
        ? prisma.song.findMany({
            where: { ...baseWhere, OR: tasteSignals },
            select,
            orderBy: { popularity: 'desc' },
            take: 250,
          })
        : [],
      prisma.song.findMany({
        where: baseWhere,
        select,
        orderBy: { popularity: 'desc' },
        take: 80,
      }),
    ]);
  } catch (err) {
    console.warn('Personalized candidate query unavailable:', err.message);
    popularCandidates = await prisma.song.findMany({
      where: { videoUrl: { not: null } },
      select,
      orderBy: { popularity: 'desc' },
      take: 200,
    });
    const likedSet = new Set(likedIds);
    popularCandidates = popularCandidates.filter((song) => !likedSet.has(song.id));
  }

  const byId = new Map([...tasteCandidates, ...popularCandidates].map((song) => [song.id, song]));
  const recommendations = rankRecommendations({
    likedSongs,
    candidates: [...byId.values()],
    collaborativeCounts,
    limit: 8,
  });
  res.json({
    recommendations,
    personalized: likedSongs.length > 0,
  });
});

// Valide la réponse côté serveur, attribue les tokens et révèle l'anime.
router.post('/guess', requireAuth, rateLimit({ max: 120, name: 'guess' }), async (req, res) => {
  const { songId, guess } = req.body || {};
  if (!songId) return res.status(400).json({ error: 'songId requis' });

  const song = await prisma.song.findUnique({ where: { id: songId } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });

  const userId = req.user.id;
  const correct = isCorrectGuess(guess, song);

  // Le mode classé est décidé par le jeton de manche émis au tirage, pas par le
  // client. Sans jeton valide et non rejoué pour CETTE manche → aucun token.
  const round = verifyRoundToken(req.body?.roundToken, { userId, songId });
  const ranked = !!(round && round.ranked && (await consumeRound(round)));

  const prev = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId, songId } },
  });
  const firstCorrect = correct && (!prev || prev.correctCount === 0);
  // Les tokens ne sont gagnés qu'en mode classé, pondérés par le niveau (cash/carré/duo)
  const mult = LEVEL_MULT[round?.level] ?? 1;
  const reward = correct && ranked ? Math.max(1, Math.round(computeReward(song, firstCorrect) * mult)) : 0;
  const srs = nextSrs(prev?.srsStreak, correct); // planification répétition espacée

  const result = await prisma.$transaction(async (tx) => {
    await tx.userSongStat.upsert({
      where: { userId_songId: { userId, songId } },
      update: {
        playCount: { increment: 1 },
        ...(correct ? { correctCount: { increment: 1 } } : {}),
        srsStreak: srs.srsStreak, srsInterval: srs.srsInterval, srsDueAt: srs.srsDueAt,
      },
      create: {
        userId, songId, playCount: 1, correctCount: correct ? 1 : 0,
        srsStreak: srs.srsStreak, srsInterval: srs.srsInterval, srsDueAt: srs.srsDueAt,
      },
    });
    // Stat quotidienne (graphe de progression)
    const day = todayStr();
    await tx.dailyStat.upsert({
      where: { userId_day: { userId, day } },
      update: { played: { increment: 1 }, ...(correct ? { correct: { increment: 1 } } : {}) },
      create: { userId, day, played: 1, correct: correct ? 1 : 0 },
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

  if (correct) progressQuests(userId, 'correct', 1);

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
