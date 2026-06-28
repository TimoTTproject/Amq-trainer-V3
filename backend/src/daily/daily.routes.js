// Défi du jour (solo classé) : même set de chansons pour tous, 1 essai/jour,
// score vitesse+exactitude autoritaire serveur, conversion en MMR solo.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { isCorrectGuess } = require('../quiz/matching');
const { tierFromMmr } = require('../mp/rank');
const { proxyVideo } = require('../util/stream');
const { preferredMediaUrl } = require('../storage/r2');
const { preferMainContent } = require('../catalog/format');
const { byId, publicCosmetic } = require('../shop/cosmetics');
const { progressQuests } = require('../quests/quests');
const {
  DAILY_SONG_COUNT, DAILY_DURATION_MS, DAILY_GRACE_MS,
  todayStr, yesterdayStr, pickDailySongIds, scoreSong, maxScore, computeSoloMmrDelta, applyMmr,
  computeStreak, streakReward,
} = require('./daily');

const router = express.Router();

// Récupère (ou crée une fois) le défi du jour : un set de chansons commun à tous.
async function getOrCreateChallenge(day) {
  const existing = await prisma.dailyChallenge.findUnique({ where: { day } });
  if (existing) return existing;

  // Candidats : catalogue jouable, priorité série principale (repli si trop peu).
  let rows = await prisma.song.findMany({
    where: { videoUrl: { not: null }, ...preferMainContent },
    select: { id: true },
    take: 4000,
  });
  if (rows.length < DAILY_SONG_COUNT) {
    rows = await prisma.song.findMany({ where: { videoUrl: { not: null } }, select: { id: true }, take: 4000 });
  }
  const songIds = pickDailySongIds(rows.map((r) => r.id), DAILY_SONG_COUNT);
  // upsert : tolère la course (2 requêtes simultanées le 1er accès du jour).
  return prisma.dailyChallenge.upsert({
    where: { day },
    update: {},
    create: { day, songIds },
  });
}

// Anti-triche : on ne révèle JAMAIS le songId au client (sinon il pourrait
// récupérer le titre via /api/quiz/{guess,answer} ou le catalogue). Le média
// passe par un proxy lié au run, et la réponse se soumet via l'état serveur.
function serveCurrentSong(run) {
  return {
    index: run.index,
    total: run.songIds.length,
    clipUrl: `/api/daily/clip?i=${run.index}`,
    durationMs: DAILY_DURATION_MS,
  };
}

// État du défi du jour pour l'utilisateur.
router.get('/status', requireAuth, async (req, res) => {
  const day = todayStr();
  const challenge = await getOrCreateChallenge(day);
  const run = await prisma.dailyRun.findUnique({ where: { userId_day: { userId: req.user.id, day } } });
  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { soloMmr: true, soloGames: true, soloBestScore: true, dailyStreak: true, dailyStreakBest: true, dailyLastDay: true },
  });
  // La série n'est « vivante » que si le dernier jour joué est aujourd'hui ou hier.
  const streakAlive = me.dailyLastDay === day || me.dailyLastDay === yesterdayStr();
  res.json({
    day,
    total: challenge.songIds.length,
    played: !!run?.finished,
    inProgress: !!run && !run.finished,
    run: run?.finished
      ? { score: run.score, correct: run.correct, total: run.songIds.length, mmrBefore: run.mmrBefore, mmrAfter: run.mmrAfter }
      : null,
    soloMmr: me.soloMmr,
    soloGames: me.soloGames,
    soloBestScore: me.soloBestScore,
    tier: me.soloGames > 0 ? tierFromMmr(me.soloMmr) : null,
    streak: streakAlive ? me.dailyStreak : 0,
    streakBest: me.dailyStreakBest,
  });
});

// Démarre (ou reprend) la tentative du jour.
router.post('/start', requireAuth, async (req, res) => {
  const day = todayStr();
  const challenge = await getOrCreateChallenge(day);
  const existing = await prisma.dailyRun.findUnique({ where: { userId_day: { userId: req.user.id, day } } });
  if (existing?.finished) return res.status(409).json({ error: 'Défi déjà terminé pour aujourd\'hui — reviens demain !' });

  let run = existing;
  if (!run) {
    run = await prisma.dailyRun.create({
      data: { userId: req.user.id, day, songIds: challenge.songIds, index: 0, songStartedAt: new Date() },
    });
  } else {
    // Reprise : on relance le chrono de la chanson en cours.
    run = await prisma.dailyRun.update({ where: { id: run.id }, data: { songStartedAt: new Date() } });
  }
  res.json(await serveCurrentSong(run));
});

// Proxy média de la chanson en cours, lié au run : ne révèle jamais le songId
// ni l'URL réelle (anti-triche). `i` ne sert qu'au cache-bust côté navigateur.
router.get('/clip', requireAuth, async (req, res) => {
  const day = todayStr();
  const run = await prisma.dailyRun.findUnique({ where: { userId_day: { userId: req.user.id, day } } });
  if (!run || run.finished) return res.status(404).end();
  const songId = run.songIds[run.index];
  if (songId == null) return res.status(404).end();
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { videoUrl: true, audioUrl: true } });
  if (!song || !preferredMediaUrl(song)) return res.status(404).end();
  if (song.audioUrl) return res.redirect(302, song.audioUrl);
  await proxyVideo(req, res, song.videoUrl);
});

// Soumet une réponse pour la chanson en cours (vide = passer). Avance d'une chanson.
// La chanson est déterminée par l'état serveur (run.index), pas par le client.
router.post('/guess', requireAuth, async (req, res) => {
  const day = todayStr();
  const { guess } = req.body || {};
  const run = await prisma.dailyRun.findUnique({ where: { userId_day: { userId: req.user.id, day } } });
  if (!run || run.finished) return res.status(400).json({ error: 'Aucune tentative en cours' });

  const songId = run.songIds[run.index];
  const song = await prisma.song.findUnique({
    where: { id: songId },
    select: { id: true, animeTitle: true, altTitles: true, title: true, artist: true, type: true, number: true },
  });
  if (!song) return res.status(404).json({ error: 'Chanson introuvable' });

  const elapsedMs = run.songStartedAt ? Date.now() - new Date(run.songStartedAt).getTime() : DAILY_DURATION_MS;
  const tooLate = elapsedMs > DAILY_DURATION_MS + DAILY_GRACE_MS;
  const correct = !tooLate && isCorrectGuess(String(guess || ''), song);
  const points = scoreSong({ correct, elapsedMs, durationMs: DAILY_DURATION_MS });

  const nextIndex = run.index + 1;
  const newScore = run.score + points;
  const newCorrect = run.correct + (correct ? 1 : 0);
  const isLast = nextIndex >= run.songIds.length;

  const answer = { animeTitle: song.animeTitle, title: song.title, artist: song.artist, type: song.type, number: song.number };

  if (!isLast) {
    const updated = await prisma.dailyRun.update({
      where: { id: run.id },
      data: { index: nextIndex, score: newScore, correct: newCorrect, songStartedAt: new Date() },
    });
    return res.json({ done: false, correct, points, answer, next: await serveCurrentSong(updated) });
  }

  // Dernière chanson → finalisation + MMR + série + récompense (transaction).
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { soloMmr: true, soloBestScore: true, dailyStreak: true, dailyStreakBest: true, dailyLastDay: true },
  });
  const before = user.soloMmr;
  const delta = computeSoloMmrDelta(before, newScore, maxScore(run.songIds.length));
  const after = applyMmr(before, delta);
  const streak = computeStreak(user.dailyLastDay, user.dailyStreak);
  const streakBest = Math.max(user.dailyStreakBest, streak);
  const reward = streakReward(streak);

  await prisma.$transaction([
    prisma.dailyRun.update({
      where: { id: run.id },
      data: { index: nextIndex, score: newScore, correct: newCorrect, finished: true, songStartedAt: null, mmrBefore: before, mmrAfter: after },
    }),
    prisma.user.update({
      where: { id: req.user.id },
      data: {
        soloMmr: after, soloGames: { increment: 1 }, soloBestScore: Math.max(user.soloBestScore, newScore),
        dailyStreak: streak, dailyStreakBest: streakBest, dailyLastDay: day,
        tokens: { increment: reward },
      },
    }),
    prisma.tokenTransaction.create({ data: { userId: req.user.id, amount: reward, reason: 'daily_reward' } }),
  ]);
  progressQuests(req.user.id, 'daily', 1); // quête « Termine le défi du jour »

  res.json({
    done: true, correct, points, answer,
    result: {
      score: newScore, correct: newCorrect, total: run.songIds.length,
      mmrBefore: before, mmrAfter: after, delta, tier: tierFromMmr(after),
      streak, streakBest, reward,
    },
  });
});

// Classement du JOUR : meilleurs scores des défis terminés aujourd'hui.
router.get('/board', requireAuth, async (req, res) => {
  const day = todayStr();
  const runs = await prisma.dailyRun.findMany({
    where: { day, finished: true },
    orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
    take: 50,
    select: { userId: true, score: true, correct: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: runs.map((r) => r.userId) } },
    select: { id: true, displayName: true, avatarUrl: true, avatarFrame: true },
  });
  const byUser = Object.fromEntries(users.map((u) => [u.id, u]));
  const top = runs.map((r, i) => {
    const u = byUser[r.userId] || {};
    return {
      rank: i + 1, userId: r.userId, displayName: u.displayName || '—',
      avatarUrl: u.avatarUrl || null, frame: publicCosmetic(byId(u.avatarFrame)),
      score: r.score, correct: r.correct, isMe: r.userId === req.user.id,
    };
  });
  // Mon rang même si hors top 50.
  let me = top.find((e) => e.isMe) || null;
  if (!me) {
    const mine = await prisma.dailyRun.findUnique({ where: { userId_day: { userId: req.user.id, day } } });
    if (mine?.finished) {
      const better = await prisma.dailyRun.count({ where: { day, finished: true, score: { gt: mine.score } } });
      me = { rank: better + 1, score: mine.score, correct: mine.correct, isMe: true };
    }
  }
  res.json({ day, players: runs.length, top, me });
});

module.exports = { router };
