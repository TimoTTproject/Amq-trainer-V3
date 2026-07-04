// Routes du Château de l'Infini : statut, démarrage, réponse, abandon, flux vidéo.
// Tout l'état (étage, vies, réponse, chrono) est autoritaire côté serveur.
const express = require('express');
const { prisma } = require('../db');
const { requireAuth } = require('../auth/auth.middleware');
const { proxyVideo } = require('../util/stream');
const { preferredMediaUrl } = require('../storage/r2');
const { progressQuests } = require('../quests/quests');
const { preferMainContent } = require('../catalog/format');
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

// Clé de « franchise » : nom normalisé sans saison/partie/format, pour éviter que
// deux saisons d'une même série (ex. « [Oshi No Ko] » et « [Oshi No Ko] 2nd Season »)
// apparaissent comme deux propositions distinctes — ce qui rend le QCM incohérent.
function franchiseKey(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[[\]()]/g, ' ')
    .replace(/\b(\d+(st|nd|rd|th)\s+season|season\s*\d+|\d+(st|nd|rd|th)\s+cour|cour\s*\d+|part\s*\d+|the\s+final\s+season|final\s+season|the\s+final|kanketsu-?hen|s\d+|2nd|3rd|the\s+movie|movie|tv|ova|oad|special)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

// Construit un étage : une musique correcte + 3 distracteurs de franchises DISTINCTES.
// `excludeId` = son de l'étage précédent : on évite non seulement ce son mais tout
// l'anime correspondant, pour ne pas enchaîner deux sons de la même série.
async function buildFloor(excludeId) {
  // Priorité à la série principale (exclut films/OAV connus), repli si trop peu de titres.
  let where = { videoUrl: { not: null }, ...preferMainContent };
  let total = await prisma.song.count({ where });
  if (total < 4) { where = { videoUrl: { not: null } }; total = await prisma.song.count({ where }); }
  if (total < 4) return null;

  // Anime du son précédent → exclu de la bonne réponse (pas juste l'id du son).
  let prevAnilistId = null;
  if (excludeId) {
    const prev = await prisma.song.findUnique({ where: { id: excludeId }, select: { anilistId: true } });
    prevAnilistId = prev?.anilistId ?? null;
  }
  const correctWhere = {
    ...where,
    ...(excludeId ? { id: { not: excludeId } } : {}),
    ...(prevAnilistId ? { anilistId: { not: prevAnilistId } } : {}),
  };
  const correctTotal = excludeId ? await prisma.song.count({ where: correctWhere }) : total;
  const useExcl = correctTotal > 0;
  const correct = await prisma.song.findFirst({
    where: useExcl ? correctWhere : where,
    skip: Math.floor(Math.random() * (useExcl ? correctTotal : total)),
    select: { id: true, animeTitle: true },
  });
  if (!correct) return null;

  // 3 distracteurs : franchises différentes du bon anime ET entre elles.
  const usedKeys = new Set([franchiseKey(correct.animeTitle)]);
  const options = [correct.animeTitle];
  let guard = 0;
  while (options.length < 4 && guard++ < 80) {
    const s = await prisma.song.findFirst({
      where,
      skip: Math.floor(Math.random() * total),
      select: { animeTitle: true },
    });
    if (!s) continue;
    const key = franchiseKey(s.animeTitle);
    if (usedKeys.has(key)) continue; // même franchise (ou bon anime) → on saute
    usedKeys.add(key);
    options.push(s.animeTitle);
  }
  if (options.length < 4) return null;

  const shuffled = shuffle(options);
  return { songId: correct.id, options: shuffled, answer: shuffled.indexOf(correct.animeTitle) };
}

// Représentation cliente d'un étage (sans révéler la bonne réponse).
// `t` doit être unique à CHAQUE nouvelle musique, sinon le navigateur rejoue la
// vidéo en cache. Sur une mauvaise réponse l'étage garde le même numéro mais le
// son change : on combine donc étage ET vies (les vies décroissent strictement
// au sein d'un même étage → couple (floor, lives) unique pour chaque tirage).
// On n'expose ni l'URL réelle ni le songId (anti-triche QCM).
function floorPayload(run) {
  const bust = run.floorStartedAt ? new Date(run.floorStartedAt).getTime() : `${run.floor}-${run.lives}`;
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
  res.json({
    entryCost: ENTRY_COST,
    startLives: START_LIVES,
    freeAvailable: freeEntryAvailable(req.user.towerLastFreeAt),
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

  const useFree = freeEntryAvailable(req.user.towerLastFreeAt);
  if (!useFree && req.user.tokens < ENTRY_COST) {
    return res.status(400).json({ error: 'Pas assez de tokens (et entrée gratuite déjà utilisée aujourd\'hui)' });
  }

  const floor = await buildFloor();
  if (!floor) return res.status(503).json({ error: 'Catalogue insuffisant pour ce mode' });

  const run = await prisma.$transaction(async (tx) => {
    if (useFree) {
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
        floorStartedAt: null,
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
  const elapsed = run.floorStartedAt ? Date.now() - new Date(run.floorStartedAt).getTime() : Number.POSITIVE_INFINITY;
  const limitMs = timeLimitForFloor(run.floor) * 1000 + ANSWER_GRACE_MS;
  const timedOut = !!timeout || elapsed > limitMs;

  const correctIndex = run.currentAnswer;
  const correct = !timedOut && Number(choice) === correctIndex;

  if (correct) {
    progressQuests(req.user.id, 'tower', 1); // étage franchi → quête
    // Étage franchi → bonus de vie éventuel, étage suivant
    const cleared = run.floor; // on vient de franchir cet étage
    let lives = run.lives;
    const lifeGained = cleared % LIFE_BONUS_EVERY === 0 && lives < MAX_LIVES;
    if (lifeGained) lives += 1;

    const next = await buildFloor(run.currentSongId);
    if (!next) return res.status(503).json({ error: 'Catalogue insuffisant' });

    const updated = await prisma.towerRun.update({
      where: { id: run.id },
      data: {
        floor: run.floor + 1,
        lives,
        currentSongId: next.songId,
        currentOptions: next.options,
        currentAnswer: next.answer,
        floorStartedAt: null,
      },
    });
    return res.json({
      correct: true,
      correctIndex,
      songId: run.currentSongId, // son qu'on vient de jouer → permet de l'ajouter à la playlist
      lifeGained,
      status: 'active',
      next: floorPayload(updated),
    });
  }

  // Mauvaise réponse ou temps écoulé → on perd une vie
  const lives = run.lives - 1;
  if (lives > 0) {
    const next = await buildFloor(run.currentSongId);
    if (!next) return res.status(503).json({ error: 'Catalogue insuffisant' });
    const updated = await prisma.towerRun.update({
      where: { id: run.id },
      data: {
        lives,
        currentSongId: next.songId,
        currentOptions: next.options,
        currentAnswer: next.answer,
        floorStartedAt: null,
      },
    });
    return res.json({
      correct: false,
      timedOut,
      correctIndex,
      songId: run.currentSongId,
      lifeLost: true,
      status: 'active',
      next: floorPayload(updated),
    });
  }

  // Plus de vies → fin de partie
  const result = await finishRun(run);
  res.json({ correct: false, timedOut, correctIndex, songId: run.currentSongId, status: 'over', ...result });
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
    select: { videoUrl: true, audioUrl: true },
  });
  if (!preferredMediaUrl(song)) return res.status(404).end();
  if (song.audioUrl) {
    await prisma.towerRun.updateMany({
      where: {
        id: req.params.runId,
        userId: req.user.id,
        currentSongId: run.currentSongId,
        floorStartedAt: null,
      },
      data: { floorStartedAt: new Date() },
    });
    return res.redirect(302, song.audioUrl);
  }

  await proxyVideo(req, res, song.videoUrl, {
    // Le chrono serveur commence quand AnimeThemes a réellement fourni le flux,
    // pas pendant les secondes de chargement réseau.
    onReady: () => prisma.towerRun.updateMany({
      where: {
        id: req.params.runId,
        userId: req.user.id,
        currentSongId: run.currentSongId,
        floorStartedAt: null,
      },
      data: { floorStartedAt: new Date() },
    }),
  });
});

module.exports = { router };
