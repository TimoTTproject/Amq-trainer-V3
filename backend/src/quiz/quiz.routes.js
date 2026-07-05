// Routes quiz : tirage, validation de réponse (+ tokens), feedback, notation
const express = require('express');
const { prisma } = require('../db');
const { requireAuth, requirePlayer } = require('../auth/auth.middleware');
const { issueRoundToken, verifyRoundToken, consumeRound } = require('./round-token');
const { isCorrectGuess } = require('./matching');
const { englishTitleFor } = require('./anime-titles');
const { proxyVideo } = require('../util/stream');
const { rateLimit } = require('../util/ratelimit');
const { progressQuests, todayStr } = require('../quests/quests');
const { rankRecommendations, artistTokens, isSideContent } = require('./recommendations');
const { preferMainContent, isMainFormat } = require('../catalog/format');
const { preferredMediaUrl } = require('../storage/r2');

const router = express.Router();

// Multiplicateur de récompense selon le niveau d'aide (Duo/Carré/Cash)
const LEVEL_MULT = { cash: 1, carre: 0.5, duo: 0.3 };
const LEVEL_COUNT = { carre: 4, duo: 2 };
// Anti-répétition des recommandations playlist : au-delà de « pas intéressé »
// (exclusion permanente), on déprioritise aussi ce qui a déjà été suggéré
// récemment, pour que la liste tourne au lieu de rester figée.
const REC_SHOWN_COOLDOWN_MS = 3 * 24 * 3600 * 1000; // 3 jours
let seriesSearchCache = { expiresAt: 0, entries: [] };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Propositions pour Carré/Duo : bonne réponse + distracteurs (animes distincts).
// `titlePool`, quand fourni, restreint les distracteurs au catalogue/à la source
// d'où vient la question (sinon des animes piochés dans tout le catalogue global
// se distinguent trop facilement de ceux que le joueur a réellement dans sa liste,
// ce qui trahit la bonne réponse par élimination). On complète avec le catalogue
// global si ce périmètre ne contient pas assez d'animes distincts.
// L'identité de chaque candidat reste le titre romaji (clé stable, unique par
// anime) mais l'affichage laisse le CLIENT choisir l'ordre anglais/japonais
// (cf. `settings.titleLang`, comme l'autocomplete) : on renvoie donc titre +
// titre anglais + numéro de saison (S1/S2… calculé via les relations AniList,
// cf. backfillSeasonsBatch), plutôt qu'un libellé déjà figé côté serveur.
async function buildChoices(song, count, titlePool = null) {
  const byTitle = new Map([
    [song.animeTitle, { altTitles: song.altTitles || [], seasonNumber: song.seasonNumber || 0 }],
  ]);
  if (titlePool && titlePool.length) {
    for (const t of shuffle(titlePool)) {
      if (byTitle.size >= count) break;
      if (t.animeTitle !== song.animeTitle) {
        byTitle.set(t.animeTitle, { altTitles: t.altTitles || [], seasonNumber: t.seasonNumber || 0 });
      }
    }
  }
  if (byTitle.size < count) {
    // Un seul aller-retour DB (une tranche contiguë prise à un offset aléatoire,
    // puis dédoublonnée en mémoire) au lieu d'aller chercher jusqu'à 40 lignes
    // une par une avec un skip aléatoire à chaque fois (ça multipliait les
    // requêtes séquentielles et pouvait ralentir tout le site sous charge).
    const total = await prisma.song.count();
    if (total > 0) {
      const batchSize = Math.min(total, 200);
      const skip = Math.floor(Math.random() * Math.max(1, total - batchSize + 1));
      const rows = await prisma.song.findMany({
        skip, take: batchSize,
        select: { animeTitle: true, altTitles: true, seasonNumber: true },
      });
      for (const s of shuffle(rows)) {
        if (byTitle.size >= count) break;
        if (!byTitle.has(s.animeTitle)) byTitle.set(s.animeTitle, { altTitles: s.altTitles || [], seasonNumber: s.seasonNumber || 0 });
      }
    }
  }
  const options = [...byTitle].map(([animeTitle, { altTitles, seasonNumber }]) => ({
    title: animeTitle,
    englishTitle: englishTitleFor({ animeTitle, altTitles }),
    seasonNumber,
  }));
  return shuffle(options);
}

// Résout l'ensemble des ids de musiques d'un mode/source d'entraînement pour un
// utilisateur — partagé entre le tirage (/random) et les distracteurs Carré/Duo
// (/choices), pour que les deux piochent dans exactement le même périmètre.
// Renvoie aussi `titleRows` (animeTitle/altTitles/seasonNumber) quand on les a
// déjà sous la main sans requête supplémentaire (cas 'mine'/'series', les plus
// courants) : /choices les réutilise directement au lieu de re-scanner les
// mêmes ids une seconde fois pour construire les distracteurs Carré/Duo.
async function resolveSourceSongIds({ userId, source, series, typeFilter }) {
  let songIds;
  let titleRows = null;
  if (source === 'review') {
    songIds = await getReviewSongIds(userId);
  } else if (source === 'due') {
    const stats = await prisma.userSongStat.findMany({
      where: { userId, srsDueAt: { not: null, lte: new Date() } },
      select: { songId: true },
    });
    songIds = stats.map((s) => s.songId);
  } else if (source === 'series') {
    const rows = await prisma.song.findMany({
      where: { animeTitle: series || '', videoUrl: { not: null }, ...(typeFilter ? { type: typeFilter } : {}) },
      select: { id: true, animeTitle: true, altTitles: true, seasonNumber: true },
    });
    songIds = rows.map((r) => r.id);
    titleRows = rows;
  } else if (source) {
    const where = { userId };
    if (source === 'missed') { where.playCount = { gt: 0 }; where.correctCount = 0; }
    else where.liked = true;
    const stats = await prisma.userSongStat.findMany({ where, select: { songId: true } });
    songIds = stats.map((s) => s.songId);
  } else {
    const entries = await prisma.userCatalogEntry.findMany({ where: { userId }, select: { songId: true } });
    songIds = entries.map((e) => e.songId);
  }
  // Filtre OP/ED sur les ids retenus (sauf déjà filtré pour 'series') : invalide
  // titleRows (les lignes déjà en main ne correspondent plus au sous-ensemble filtré).
  if (typeFilter && source !== 'series' && songIds.length) {
    const f = await prisma.song.findMany({ where: { id: { in: songIds }, type: typeFilter }, select: { id: true } });
    songIds = f.map((s) => s.id);
    titleRows = null;
  }
  // Ma liste (mode normal) : priorise la série principale et exclut films/OAV/
  // spéciaux — par le format quand il est connu, sinon d'après le TITRE (gère les
  // morceaux non tagués `format: null`, qui passaient avant). Repli si ça vide tout.
  if (!source && songIds.length) {
    const rows = await prisma.song.findMany({
      where: { id: { in: songIds } },
      select: { id: true, animeTitle: true, format: true, altTitles: true, seasonNumber: true },
    });
    const main = rows.filter((s) => (s.format ? isMainFormat(s.format) : !isSideContent(s.animeTitle)));
    if (main.length) { songIds = main.map((s) => s.id); titleRows = main; }
  }
  return { ids: songIds, titleRows };
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

// Récompense de base en tokens pour une bonne réponse (avant vitesse/niveau)
function computeReward(song, firstCorrect) {
  if (!firstCorrect) return 2; // rejeu : petite récompense (anti-farm)
  let reward = 10;
  const p = song.popularity || 0;
  if (p < 50000) reward += 5; // anime peu connu = plus difficile
  else if (p < 150000) reward += 2;
  return reward;
}

// Bonus de vitesse (solo classé) : gain plein pendant un court délai de grâce
// (le temps de charger l'extrait et de réfléchir), puis décroissance linéaire
// jusqu'à un plancher. Référence = `sat` du jeton de manche (signé, non falsifiable).
const SPEED = { graceSec: 5, floorAtSec: 25, floor: 0.4 };
function speedMultiplier(elapsedSec) {
  if (!(elapsedSec > SPEED.graceSec)) return 1;
  if (elapsedSec >= SPEED.floorAtSec) return SPEED.floor;
  const t = (elapsedSec - SPEED.graceSec) / (SPEED.floorAtSec - SPEED.graceSec);
  return 1 - t * (1 - SPEED.floor);
}

// Récompense maximale affichable (vitesse pleine) au niveau d'aide courant, pour
// alimenter la jauge « tokens en jeu » côté client sans révéler la popularité brute.
function maxRewardFor(song, firstCorrect, level) {
  return Math.max(1, Math.round(computeReward(song, firstCorrect) * (LEVEL_MULT[level] ?? 1)));
}

// Plafond anti-farm du quiz solo : au plus QUIZ_CAP tokens par fenêtre glissante.
const QUIZ_CAP = 300;
const QUIZ_WINDOW_MS = 6 * 3600 * 1000; // 6 heures
// État de la fenêtre courante d'un utilisateur (depuis req.user).
function quizCapState(user) {
  const now = Date.now();
  const start = user.quizRewardAt ? new Date(user.quizRewardAt).getTime() : 0;
  const active = now - start < QUIZ_WINDOW_MS;
  const used = active ? (user.quizRewardWindow || 0) : 0;
  return { active, used, left: Math.max(0, QUIZ_CAP - used), resetAt: (active ? start : now) + QUIZ_WINDOW_MS };
}

// Tire une musique au hasard. La réponse n'est PAS renvoyée (anti-triche).
// ?mode=mine (catalogue perso, défaut) | global (catalogue partagé)
// ?ranked=true|false : fige le mode classé côté serveur (jeton de manche).
router.get('/random', requirePlayer, async (req, res) => {
  const guest = !!req.user.isGuest;
  const mode = guest || req.query.mode === 'global' ? 'global' : 'mine';
  const ranked = !guest && req.query.ranked !== 'false'; // les invités jouent sans gains
  // Sources d'entraînement (toujours hors classé)
  const source = !guest && ['review', 'missed', 'liked', 'due', 'series'].includes(req.query.source) ? req.query.source : null;
  // Filtre type de thème : 'OP' | 'ED' | (rien = les deux)
  const typeFilter = ['OP', 'ED'].includes(req.query.type) ? req.query.type : null;

  const series = source === 'series' ? (req.query.series || '').trim() : undefined;
  let song = null;
  if (!source && mode === 'global') {
    // Perf : on évite de charger tous les ids → count + skip aléatoire.
    // Priorité à la série principale (exclut films/OAV connus), avec repli si vide.
    const baseFilter = { videoUrl: { not: null }, ...(typeFilter ? { type: typeFilter } : {}) };
    let where = { ...baseFilter, ...preferMainContent };
    let total = await prisma.song.count({ where });
    if (!total) { where = baseFilter; total = await prisma.song.count({ where }); }
    if (!total) return res.status(404).json({ error: 'Aucune musique disponible' });
    song = await prisma.song.findFirst({ where, skip: Math.floor(Math.random() * total), select: { id: true, videoUrl: true, audioUrl: true, popularity: true } });
  } else {
    const { ids: songIds } = await resolveSourceSongIds({ userId: req.user.id, source, series, typeFilter });
    if (!songIds.length) {
      return res.status(404).json({ error: source ? 'Aucune musique dans cette catégorie pour l\'instant' : 'Aucune musique disponible pour ce mode' });
    }
    const randomId = songIds[Math.floor(Math.random() * songIds.length)];
    song = await prisma.song.findUnique({ where: { id: randomId }, select: { id: true, videoUrl: true, audioUrl: true, popularity: true } });
  }
  if (!song) return res.status(404).json({ error: 'Aucune musique disponible' });
  // Jeton lié à cette manche (niveau « cash » par défaut = texte libre, gain plein).
  // mode/source/series sont mémorisés pour piocher les distracteurs Carré/Duo dans
  // le même périmètre que la question (cf. /choices).
  const roundToken = issueRoundToken({ userId: req.user.id, songId: song.id, ranked, level: 'cash', mode, source, series });
  const stat = guest
    ? null
    : await prisma.userSongStat.findUnique({
        where: { userId_songId: { userId: req.user.id, songId: song.id } },
        select: { liked: true, rankedCorrectCount: true },
      });
  const firstCorrect = !stat || stat.rankedCorrectCount === 0;
  // Infos pour la jauge « tokens en jeu » : récompense max au niveau cash, et la
  // courbe de vitesse. `timed` = false en entraînement/rejeu (gain figé, sans chrono).
  const reward = {
    max: ranked ? maxRewardFor(song, firstCorrect, 'cash') : 0,
    timed: ranked && firstCorrect,
    grace: SPEED.graceSec, floorAt: SPEED.floorAtSec, floor: SPEED.floor,
  };
  // Compteur du plafond anti-farm (affiché côté client), seulement en classé.
  let rewardCap;
  if (ranked && !guest) {
    const cap = quizCapState(req.user);
    rewardCap = { used: cap.used, max: QUIZ_CAP, resetAt: cap.resetAt };
  }
  // On ne renvoie PAS l'URL .webm (anti-triche) : le client lit le flux proxifié.
  res.json({ song: { id: song.id }, roundToken, liked: !!stat?.liked, reward, ...(rewardCap ? { rewardCap } : {}) });
});

// Flux vidéo de la manche, proxifié (le titre ne fuite pas par l'URL). Le jeton
// de manche doit correspondre à cet utilisateur et cette musique.
router.get('/clip/:songId', requirePlayer, async (req, res) => {
  const songId = parseInt(req.params.songId);
  const round = verifyRoundToken(req.query.rt, { userId: req.user.id, songId });
  if (!round) return res.status(403).end();
  const song = await prisma.song.findUnique({ where: { id: songId }, select: { videoUrl: true, audioUrl: true } });
  if (!preferredMediaUrl(song)) return res.status(404).end();
  if (song.audioUrl) return res.redirect(302, song.audioUrl);
  await proxyVideo(req, res, song.videoUrl);
});

// Passe en Carré (4) ou Duo (2) : verrouille le niveau (gain réduit) dans un
// nouveau jeton et renvoie les propositions. L'ancien jeton est consommé pour
// empêcher de revenir au gain « cash » après avoir vu les propositions.
router.post('/choices', requirePlayer, rateLimit({ max: 120, name: 'choices' }), async (req, res) => {
  const level = req.body?.level === 'duo' ? 'duo' : 'carre';
  const round = verifyRoundToken(req.body?.roundToken, { userId: req.user.id });
  if (!round) return res.status(400).json({ error: 'Manche invalide' });
  if (!(await consumeRound(round))) return res.status(409).json({ error: 'Manche déjà jouée' });

  const song = await prisma.song.findUnique({ where: { id: round.sid } });
  if (!song) return res.status(404).json({ error: 'Musique introuvable' });

  // Distracteurs pris dans le même périmètre que la question (catalogue perso /
  // source d'entraînement) : sinon des animes purement aléatoires du catalogue
  // global se distinguent trop facilement de ceux que le joueur connaît vraiment,
  // ce qui trahit la bonne réponse par élimination.
  let titlePool = null;
  if (round.mode === 'mine' || round.source) {
    const { ids, titleRows } = await resolveSourceSongIds({ userId: req.user.id, source: round.source || null, series: round.series, typeFilter: null });
    // titleRows est déjà rempli pour les cas les plus courants (mode 'mine',
    // source 'series') par resolveSourceSongIds — sinon (sources basées sur
    // UserSongStat, qui n'a pas ces colonnes) on va les chercher ici.
    const rows = titleRows || (ids.length
      ? await prisma.song.findMany({ where: { id: { in: ids } }, select: { animeTitle: true, altTitles: true, seasonNumber: true } })
      : []);
    if (rows.length) {
      const seen = new Map();
      for (const r of rows) if (!seen.has(r.animeTitle)) seen.set(r.animeTitle, { altTitles: r.altTitles || [], seasonNumber: r.seasonNumber || 0 });
      titlePool = [...seen].map(([animeTitle, v]) => ({ animeTitle, ...v }));
    }
  }

  const options = await buildChoices(song, LEVEL_COUNT[level], titlePool);
  // Préserve `sat` : le chrono de vitesse court depuis le début de la manche, pas
  // depuis le passage en Carré/Duo. mode/source/series aussi, pour un éventuel
  // second appel (Duo → Carré n'existe pas actuellement mais reste cohérent).
  const roundToken = issueRoundToken({
    userId: req.user.id, songId: round.sid, ranked: round.ranked, level, startedAt: round.sat,
    mode: round.mode, source: round.source, series: round.series,
  });
  let reward;
  if (round.ranked) {
    const stat = await prisma.userSongStat.findUnique({
      where: { userId_songId: { userId: req.user.id, songId: round.sid } },
      select: { rankedCorrectCount: true },
    });
    reward = { max: maxRewardFor(song, !stat || stat.rankedCorrectCount === 0, level) };
  }
  res.json({ options, roundToken, level, reward });
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

// Rafraîchit (si expiré) le cache des séries : titre + synonymes normalisés de
// chaque anime distinct du catalogue. Partagé par /series (recherche serveur,
// entraînement ciblé) et /series-all (liste complète, autocomplétion de réponse).
async function ensureSeriesSearchCache() {
  if (seriesSearchCache.expiresAt >= Date.now()) return;
  const rows = await prisma.song.findMany({
    where: { videoUrl: { not: null } },
    select: { anilistId: true, animeTitle: true, altTitles: true, popularity: true, seasonNumber: true },
    orderBy: { popularity: 'desc' },
  });
  const uniqueRows = [...new Map(rows.map((row) => [row.anilistId, row])).values()];
  seriesSearchCache = {
    expiresAt: Date.now() + 5 * 60 * 1000,
    entries: uniqueRows.map((row) => {
      const englishTitle = englishTitleFor(row);
      return {
        title: row.animeTitle,
        englishTitle,
        seasonNumber: row.seasonNumber || 0,
        popularity: row.popularity || 0,
        searchTitles: [row.animeTitle, ...(row.altTitles || [])].map((title) => title.toLocaleLowerCase()),
      };
    }),
  };
}

// Liste complète (titre + synonymes normalisés) pour l'autocomplétion de réponse
// pendant le quiz : chargée UNE FOIS côté client puis filtrée localement (cf.
// anime-autocomplete.js), pour éliminer l'aller-retour réseau à chaque frappe —
// c'est ce qui rendait l'autocomplétion perceptiblement plus lente que sur AMQ,
// qui filtre entièrement côté client (indépendant de la qualité de connexion).
router.get('/series-all', requirePlayer, async (req, res) => {
  await ensureSeriesSearchCache();
  res.json({
    entries: seriesSearchCache.entries.map(({ title, englishTitle, seasonNumber, popularity, searchTitles }) => ({
      title, englishTitle, seasonNumber, popularity, searchTitles,
    })),
  });
});

// Recherche de séries (animes) pour l'entraînement ciblé
router.get('/series', requirePlayer, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json({ series: [], suggestions: [] });
  await ensureSeriesSearchCache();
  const needle = q.toLocaleLowerCase();
  // Un seul passage par entrée pour calculer l'index de correspondance (au lieu de
  // le refaire à chaque comparaison du tri, ce qui rend la frappe saccadée quand le
  // catalogue grossit) : on décore, on trie sur ces valeurs déjà calculées, on retire.
  const suggestions = seriesSearchCache.entries
    .map((entry) => {
      let matchIndex = Number.MAX_SAFE_INTEGER;
      for (const title of entry.searchTitles) {
        const index = title.indexOf(needle);
        if (index >= 0 && index < matchIndex) matchIndex = index;
      }
      return { entry, matchIndex };
    })
    .filter(({ matchIndex }) => matchIndex !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a.matchIndex - b.matchIndex || b.entry.popularity - a.entry.popularity || a.entry.title.localeCompare(b.entry.title))
    .slice(0, 20)
    .map(({ entry }) => entry);
  res.json({
    series: suggestions.map((entry) => entry.title),
    suggestions: suggestions.map(({ title, englishTitle }) => ({ title, englishTitle })),
  });
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
      title: s.song.title, artist: s.song.artist, videoUrl: preferredMediaUrl(s.song),
      format: s.song.format || null, // TV/MOVIE/OVA… → icône côté client
      coverUrl: s.song.coverUrl || null, // jaquette AniList (identité par licence)
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
  // Sons que l'utilisateur a explicitement retirés des recommandations (« pas intéressé »)
  const hiddenStats = await prisma.userSongStat.findMany({ where: { userId, recHidden: true }, select: { songId: true } });
  const excludeIds = [...new Set([...likedIds, ...hiddenStats.map((s) => s.songId)])];
  // Sons suggérés récemment (hors dismiss) : déprioritisés (pas exclus) pour que
  // la sélection tourne au lieu de rester figée sur le même classement déterministe.
  const shownRecently = await prisma.userSongStat.findMany({
    where: { userId, recShownAt: { gte: new Date(Date.now() - REC_SHOWN_COOLDOWN_MS) } },
    select: { songId: true },
  });
  const recentlyShownIds = new Set(shownRecently.map((s) => s.songId));
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

  // Interprètes individuels de la playlist (chanteurs/groupes), par fréquence —
  // sert à retrouver leurs autres morceaux même crédités différemment (feat., collab…).
  const tokenFreq = new Map();
  for (const song of likedSongs) {
    for (const t of artistTokens(song.artist)) tokenFreq.set(t, (tokenFreq.get(t) || 0) + 1);
  }
  const topArtistTokens = [...tokenFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .filter((t) => t.length >= 3) // évite les sous-chaînes trop courtes/bruyantes
    .slice(0, 20);

  const baseWhere = { videoUrl: { not: null } };
  if (excludeIds.length) baseWhere.id = { notIn: excludeIds };
  const tasteSignals = [];
  if (artists.length) tasteSignals.push({ artist: { in: artists } });
  for (const tok of topArtistTokens) tasteSignals.push({ artist: { contains: tok, mode: 'insensitive' } });
  if (anilistIds.length) tasteSignals.push({ anilistId: { in: anilistIds } });
  if (collaborativeCounts.size) tasteSignals.push({ id: { in: [...collaborativeCounts.keys()] } });

  const select = {
    id: true, anilistId: true, animeTitle: true, type: true, number: true,
    title: true, artist: true, videoUrl: true, audioUrl: true, popularity: true, format: true, coverUrl: true,
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
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 8));
  const recommendations = rankRecommendations({
    likedSongs,
    candidates: [...byId.values()],
    collaborativeCounts,
    recentlyShownIds,
    limit,
  });
  res.json({
    recommendations: recommendations.map((song) => ({
      ...song,
      videoUrl: preferredMediaUrl(song),
      audioUrl: undefined,
    })),
    personalized: likedSongs.length > 0,
  });

  // Marque ces sons comme suggérés (anti-répétition à la prochaine visite) —
  // en tâche de fond, après la réponse, pour ne pas ajouter de latence.
  if (recommendations.length) {
    const now = new Date();
    Promise.all(
      recommendations.map((song) =>
        prisma.userSongStat.upsert({
          where: { userId_songId: { userId, songId: song.id } },
          update: { recShownAt: now },
          create: { userId, songId: song.id, recShownAt: now },
        })
      )
    ).catch((e) => console.error('recShownAt update:', e.message));
  }
});

// « Pas intéressé » : masque définitivement un son des recommandations.
router.post('/playlist/recommendations/dismiss', requireAuth, async (req, res) => {
  const songId = parseInt(req.body?.songId);
  if (!songId) return res.status(400).json({ error: 'songId requis' });
  await prisma.userSongStat.upsert({
    where: { userId_songId: { userId: req.user.id, songId } },
    update: { recHidden: true },
    create: { userId: req.user.id, songId, recHidden: true },
  });
  res.json({ ok: true });
});

// Valide la réponse côté serveur, attribue les tokens et révèle l'anime.
router.post('/guess', requirePlayer, rateLimit({ max: 120, name: 'guess' }), async (req, res) => {
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

  if (req.user.isGuest) {
    if (!round || !(await consumeRound(round))) {
      return res.status(409).json({ error: 'Manche invalide ou déjà jouée' });
    }
    return res.json({
      correct,
      reward: 0,
      answer: {
        animeTitle: song.animeTitle,
        englishTitle: englishTitleFor(song),
        seasonNumber: song.seasonNumber || 0,
        title: song.title,
        artist: song.artist,
        type: song.type,
        number: song.number,
      },
    });
  }

  const prev = await prisma.userSongStat.findUnique({
    where: { userId_songId: { userId, songId } },
  });
  // Le gain réduit (anti-farm) ne doit sanctionner que le rejeu en mode classé :
  // l'entraînement (non classé) ne doit jamais faire baisser le gain d'une future partie classée.
  const firstCorrect = correct && ranked && (!prev || prev.rankedCorrectCount === 0);
  // Les tokens ne sont gagnés qu'en mode classé, pondérés par le niveau (cash/carré/duo)
  // et par la vitesse de réponse (uniquement à la première bonne réponse).
  const levelMult = LEVEL_MULT[round?.level] ?? 1;
  const elapsedSec = round?.sat ? Math.max(0, Math.floor(Date.now() / 1000) - round.sat) : 0;
  const speedMult = firstCorrect ? speedMultiplier(elapsedSec) : 1; // pas de bonus vitesse au rejeu
  const base = computeReward(song, firstCorrect);
  const reward = correct && ranked ? Math.max(1, Math.round(base * levelMult * speedMult)) : 0;
  // Plafond anti-farm : limite le gain à ce qu'il reste dans la fenêtre de 6h.
  const cap = quizCapState(req.user);
  const grant = Math.min(reward, cap.left);
  const capped = reward > grant; // une partie (ou tout) a été coupée par le plafond
  const srs = nextSrs(prev?.srsStreak, correct); // planification répétition espacée

  const result = await prisma.$transaction(async (tx) => {
    await tx.userSongStat.upsert({
      where: { userId_songId: { userId, songId } },
      update: {
        playCount: { increment: 1 },
        ...(correct ? { correctCount: { increment: 1 } } : {}),
        ...(correct && ranked ? { rankedCorrectCount: { increment: 1 } } : {}),
        srsStreak: srs.srsStreak, srsInterval: srs.srsInterval, srsDueAt: srs.srsDueAt,
      },
      create: {
        userId, songId, playCount: 1, correctCount: correct ? 1 : 0,
        rankedCorrectCount: correct && ranked ? 1 : 0,
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
    let tokens = null;
    if (grant > 0) {
      const u = await tx.user.update({
        where: { id: userId },
        data: {
          tokens: { increment: grant },
          quizRewardAt: cap.active ? req.user.quizRewardAt : new Date(),
          quizRewardWindow: cap.used + grant,
        },
      });
      tokens = u.tokens;
      await tx.tokenTransaction.create({
        data: { userId, amount: grant, reason: firstCorrect ? 'quiz_first_correct' : 'quiz_correct' },
      });
    }
    return { tokens };
  });

  if (correct) progressQuests(userId, 'correct', 1);

  res.json({
    correct,
    reward: grant,
    // Détail du calcul (transparence) quand le gain n'est pas écrêté par le plafond.
    ...(grant > 0 && !capped
      ? {
          breakdown: {
            base, levelMult, speedMult: Math.round(speedMult * 100) / 100,
            level: round?.level || 'cash', firstCorrect, elapsedSec,
          },
        }
      : {}),
    // Plafond anti-farm (compteur + écrêtage)
    ...(ranked ? { rewardCap: { used: cap.used + grant, max: QUIZ_CAP, resetAt: cap.resetAt, capped } } : {}),
    ...(result.tokens !== null ? { tokens: result.tokens } : {}),
    answer: {
      animeTitle: song.animeTitle,
      englishTitle: englishTitleFor(song),
      seasonNumber: song.seasonNumber || 0,
      title: song.title,
      artist: song.artist,
      type: song.type,
      number: song.number,
    },
  });
});

// Révèle la réponse sans scorer (mode entraînement uniquement).
// Exige un jeton de manche d'entraînement : impossible de révéler une manche classée.
router.get('/answer/:songId', requirePlayer, async (req, res) => {
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
      englishTitle: englishTitleFor(song),
      seasonNumber: song.seasonNumber || 0,
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

// Mise en avant (accueil) : sons les plus/moins réussis et les plus joués,
// tous joueurs confondus. Seuil de parties minimum pour ne pas laisser un son
// joué 1-2 fois fausser un taux à 0 % ou 100 %.
const HIGHLIGHTS_MIN_PLAYS = 15;
const HIGHLIGHTS_CACHE_MS = 5 * 60 * 1000;
let highlightsCache = { expiresAt: 0, data: null };
router.get('/highlights', requirePlayer, async (req, res) => {
  if (highlightsCache.expiresAt < Date.now()) {
    const grouped = await prisma.userSongStat.groupBy({
      by: ['songId'],
      _sum: { playCount: true, correctCount: true },
      having: { playCount: { _sum: { gte: HIGHLIGHTS_MIN_PLAYS } } },
    });
    const withRate = grouped.map((g) => ({
      songId: g.songId,
      plays: g._sum.playCount || 0,
      rate: g._sum.playCount ? (g._sum.correctCount || 0) / g._sum.playCount : 0,
    }));
    const top = (arr) => arr.slice(0, 8).map(({ songId, plays, rate }) => ({ songId, plays, rate: Math.round(rate * 100) }));
    const hardest = top([...withRate].sort((a, b) => a.rate - b.rate || b.plays - a.plays));
    const easiest = top([...withRate].sort((a, b) => b.rate - a.rate || b.plays - a.plays));
    const mostPlayed = top([...withRate].sort((a, b) => b.plays - a.plays));
    const ids = [...new Set([...hardest, ...easiest, ...mostPlayed].map((x) => x.songId))];
    const songs = ids.length
      ? await prisma.song.findMany({
          where: { id: { in: ids } },
          select: { id: true, animeTitle: true, title: true, artist: true, type: true, number: true, coverUrl: true },
        })
      : [];
    const bySongId = new Map(songs.map((s) => [s.id, s]));
    const attach = (list) => list.filter((x) => bySongId.has(x.songId)).map((x) => ({ ...bySongId.get(x.songId), plays: x.plays, rate: x.rate }));
    highlightsCache = {
      expiresAt: Date.now() + HIGHLIGHTS_CACHE_MS,
      data: { hardest: attach(hardest), easiest: attach(easiest), mostPlayed: attach(mostPlayed) },
    };
  }
  res.json(highlightsCache.data);
});

module.exports = { router, quizCapState, QUIZ_CAP };
