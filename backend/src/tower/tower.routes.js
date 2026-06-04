// Routes du Château de l'Infini : statut, démarrage, réponse, abandon, flux vidéo.
// Tout l'état (étage, vies, réponse, chrono) est autoritaire côté serveur.
const express = require('express');
const { Readable } = require('stream');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { isAdmin } = require('../admin/admin');
const {
  ENTRY_COST,
  START_LIVES,
  MAX_LIVES,
  LIFE_BONUS_EVERY,
  ANSWER_GRACE_MS,
  timeLimitForFloor,
  computeReward,
  freeEntryAvailable,
  shuffle,
} = require('./tower');

const router = express.Router();

// animethemes renvoie 403 sans User-Agent identifiable
const ANIMETHEMES_HEADERS = {
  'User-Agent': 'AnimeMusicQuiz/1.0 (+https://github.com/local/amq)',
  Accept: '*/*',
};

// Construit un étage : une musique correcte + 3 distracteurs (animes distincts).
async function buildFloor() {
  const where = { videoUrl: { not: null } };
  const total = await prisma.song.count({ where });
  if (total < 4) return null;

  const correct = await prisma.song.findFirst({
    where,
    skip: Math.floor(Math.random() * total),
    select: { id: true, animeTitle: true },
  });
  if (!correct) return null;

  const titles = new Set([correct.animeTitle]);
  let guard = 0;
  while (titles.size < 4 && guard++ < 40) {
    const s = await prisma.song.findFirst({
      where,
      skip: Math.floor(Math.random() * total),
      select: { animeTitle: true },
    });
    if (s) titles.add(s.animeTitle);
  }
  if (titles.size < 4) return null;

  const options = shuffle([...titles]);
  return { songId: correct.id, options, answer: options.indexOf(correct.animeTitle) };
}

// Représentation cliente d'un étage (sans révéler la bonne réponse).
// `t` change à chaque nouvelle musique (floorStartedAt) → URL unique, sinon le
// navigateur rejoue la vidéo en cache (même runId d'un étage à l'autre).
function floorPayload(run) {
  const bust = run.floorStartedAt ? new Date(run.floorStartedAt).getTime() : run.floor;
  return {
    runId: run.id,
    floor: run.floor,
    lives: run.lives,
    options: run.currentOptions,
    timeLimit: timeLimitForFloor(run.floor),
    clipUrl: `/api/tower/clip/${run.id}?t=${bust}`,
  };
}

// Statut : entrée gratuite dispo, coût, record, partie en cours éventuelle
router.get('/status', requireAuth, async (req, res) => {
  const active = await prisma.towerRun.findFirst({
    where: { userId: req.user.id, status: 'active' },
    orderBy: { startedAt: 'desc' },
  });
  const admin = isAdmin(req.user);
  res.json({
    entryCost: admin ? 0 : ENTRY_COST,
    startLives: START_LIVES,
    freeAvailable: admin || freeEntryAvailable(req.user.towerLastFreeAt),
    admin,
    bestFloor: req.user.towerBestFloor || 0,
    tokens: req.user.tokens,
    activeRun: active ? floorPayload(active) : null,
  });
});

// Démarre une partie : entrée gratuite du jour, sinon débit de tokens
router.post('/start', requireAuth, async (req, res) => {
  const userId = req.user.id;

  const existing = await prisma.towerRun.findFirst({ where: { userId, status: 'active' } });
  if (existing) return res.json({ resumed: true, ...floorPayload(existing) });

  const admin = isAdmin(req.user); // entrée libre illimitée pour les tests
  const useFree = !admin && freeEntryAvailable(req.user.towerLastFreeAt);
  if (!admin && !useFree && req.user.tokens < ENTRY_COST) {
    return res.status(400).json({ error: 'Pas assez de tokens (et entrée gratuite déjà utilisée aujourd\'hui)' });
  }

  const floor = await buildFloor();
  if (!floor) return res.status(503).json({ error: 'Catalogue insuffisant pour ce mode' });

  const run = await prisma.$transaction(async (tx) => {
    if (admin) {
      // ni débit, ni consommation de l'entrée gratuite
    } else if (useFree) {
      await tx.user.update({ where: { id: userId }, data: { towerLastFreeAt: new Date() } });
    } else {
      await tx.user.update({ where: { id: userId }, data: { tokens: { decrement: ENTRY_COST } } });
      await tx.tokenTransaction.create({ data: { userId, amount: -ENTRY_COST, reason: 'tower_entry' } });
    }
    return tx.towerRun.create({
      data: {
        userId,
        floor: 1,
        lives: START_LIVES,
        status: 'active',
        currentSongId: floor.songId,
        currentOptions: floor.options,
        currentAnswer: floor.answer,
        floorStartedAt: new Date(),
      },
    });
  });

  const tokens = (await prisma.user.findUnique({ where: { id: userId }, select: { tokens: true } })).tokens;
  res.json({ usedFree: useFree, tokens, ...floorPayload(run) });
});

// Termine une partie : crédite la récompense selon les étages franchis
async function finishRun(run) {
  const cleared = run.floor - 1; // étages réussis (l'étage courant a échoué)
  const reward = computeReward(cleared);
  const userId = run.userId;

  const tokens = await prisma.$transaction(async (tx) => {
    await tx.towerRun.update({
      where: { id: run.id },
      data: { status: 'over', finishedAt: new Date(), lives: 0 },
    });
    const data = {};
    if (run.floor > (await tx.user.findUnique({ where: { id: userId }, select: { towerBestFloor: true } })).towerBestFloor) {
      data.towerBestFloor = run.floor;
    }
    if (reward > 0) {
      data.tokens = { increment: reward };
      await tx.tokenTransaction.create({ data: { userId, amount: reward, reason: 'tower_reward' } });
    }
    const u = Object.keys(data).length
      ? await tx.user.update({ where: { id: userId }, data })
      : await tx.user.findUnique({ where: { id: userId } });
    return u.tokens;
  });

  return { cleared, reward, tokens, bestFloor: Math.max(run.floor, 0) };
}

// Répond à l'étage en cours. body: { runId, choice (0-3), timeout? }
router.post('/answer', requireAuth, async (req, res) => {
  const { runId, choice, timeout } = req.body || {};
  const run = await prisma.towerRun.findFirst({
    where: { id: runId, userId: req.user.id, status: 'active' },
  });
  if (!run) return res.status(404).json({ error: 'Aucune partie en cours' });
  if (run.currentAnswer == null) return res.status(409).json({ error: 'Étage invalide' });

  // Chrono vérifié côté serveur (le client ne peut pas tricher en désactivant le timer)
  const elapsed = run.floorStartedAt ? Date.now() - new Date(run.floorStartedAt).getTime() : 0;
  const limitMs = timeLimitForFloor(run.floor) * 1000 + ANSWER_GRACE_MS;
  const timedOut = !!timeout || elapsed > limitMs;

  const correctIndex = run.currentAnswer;
  const correct = !timedOut && Number(choice) === correctIndex;

  if (correct) {
    // Étage franchi → bonus de vie éventuel, étage suivant
    const cleared = run.floor; // on vient de franchir cet étage
    let lives = run.lives;
    const lifeGained = cleared % LIFE_BONUS_EVERY === 0 && lives < MAX_LIVES;
    if (lifeGained) lives += 1;

    const next = await buildFloor();
    if (!next) return res.status(503).json({ error: 'Catalogue insuffisant' });

    const updated = await prisma.towerRun.update({
      where: { id: run.id },
      data: {
        floor: run.floor + 1,
        lives,
        currentSongId: next.songId,
        currentOptions: next.options,
        currentAnswer: next.answer,
        floorStartedAt: new Date(),
      },
    });
    return res.json({
      correct: true,
      correctIndex,
      lifeGained,
      status: 'active',
      next: floorPayload(updated),
    });
  }

  // Mauvaise réponse ou temps écoulé → on perd une vie
  const lives = run.lives - 1;
  if (lives > 0) {
    const next = await buildFloor();
    if (!next) return res.status(503).json({ error: 'Catalogue insuffisant' });
    const updated = await prisma.towerRun.update({
      where: { id: run.id },
      data: {
        lives,
        currentSongId: next.songId,
        currentOptions: next.options,
        currentAnswer: next.answer,
        floorStartedAt: new Date(),
      },
    });
    return res.json({
      correct: false,
      timedOut,
      correctIndex,
      lifeLost: true,
      status: 'active',
      next: floorPayload(updated),
    });
  }

  // Plus de vies → fin de partie
  const result = await finishRun(run);
  res.json({ correct: false, timedOut, correctIndex, status: 'over', ...result });
});

// Abandonne la partie en cours (crédite la récompense des étages déjà franchis)
router.post('/abandon', requireAuth, async (req, res) => {
  const run = await prisma.towerRun.findFirst({
    where: { id: req.body?.runId, userId: req.user.id, status: 'active' },
  });
  if (!run) return res.status(404).json({ error: 'Aucune partie en cours' });
  const result = await finishRun(run);
  res.json({ status: 'over', ...result });
});

// Flux vidéo de l'étage en cours, proxifié pour masquer le titre (anti-triche QCM).
// Le client lit /api/tower/clip/:runId, jamais l'URL réelle de la musique.
router.get('/clip/:runId', requireAuth, async (req, res) => {
  const run = await prisma.towerRun.findFirst({
    where: { id: req.params.runId, userId: req.user.id, status: 'active' },
    select: { currentSongId: true },
  });
  if (!run?.currentSongId) return res.status(404).end();
  const song = await prisma.song.findUnique({
    where: { id: run.currentSongId },
    select: { videoUrl: true },
  });
  if (!song?.videoUrl) return res.status(404).end();

  try {
    const headers = { ...ANIMETHEMES_HEADERS };
    if (req.headers.range) headers.Range = req.headers.range; // seek / lecture partielle
    const upstream = await fetch(song.videoUrl, { headers });
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('Cache-Control', 'no-store'); // une question = un flux, jamais mis en cache
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('tower clip proxy error:', err.message);
    if (!res.headersSent) res.status(502).end();
  }
});

module.exports = { router };
