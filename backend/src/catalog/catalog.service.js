// Construction du catalogue de musiques depuis animethemes.moe + AniList
const stringSimilarity = require('string-similarity');
const { prisma } = require('../db');
const { getCompletedAnime } = require('../anilist/anilist.service');

const ANIMETHEMES_API = 'https://api.animethemes.moe';
// animethemes.moe renvoie 403 sans User-Agent identifiable
const ANIMETHEMES_HEADERS = {
  'User-Agent': 'AnimeMusicQuiz/1.0 (+https://github.com/local/amq)',
  Accept: 'application/json',
};

// Construit la liste des titres acceptés en réponse à partir d'un media AniList
function buildAltTitles(media) {
  const t = media.title || {};
  const all = [t.romaji, t.english, t.native, ...(media.synonyms || [])];
  return [...new Set(all.filter((s) => s && typeof s === 'string' && s.trim()).map((s) => s.trim()))];
}

function normalizeAnimeName(name) {
  if (!name || name === 'undefined' || name === 'null') return 'Anime inconnu';
  let n = name.toString().trim();
  if (/^gintama/i.test(n)) return n; // Gintama : garder les saisons distinctes
  n = n.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/\b\w/g, (c) => c.toUpperCase());
  return n || 'Anime inconnu';
}

function getSongTitle(theme) {
  return (
    theme.song?.title ||
    theme.song?.name ||
    (theme.slug ? theme.slug.split('-').join(' ').replace(/\b\w/g, (l) => l.toUpperCase()) : null) ||
    `Thème ${theme.type}${theme.sequence || 1}`
  );
}

function getArtistName(theme) {
  const artists = theme.song?.artists;
  if (Array.isArray(artists) && artists.length) {
    const names = artists.map((a) => a?.name).filter(Boolean).join(', ');
    if (names) return names;
  }
  return null;
}

// Extrait les openings exploitables d'un objet anime renvoyé par animethemes
function extractThemes(animeData, displayTitle) {
  const out = [];
  if (!Array.isArray(animeData.animethemes)) return out;
  for (const theme of animeData.animethemes) {
    if (theme.type !== 'OP' && theme.type !== 'ED') continue; // openings + endings
    for (const entry of theme.animethemeentries || []) {
      const video = (entry.videos || []).find((v) => v.link && v.basename !== 'NC');
      if (!video) continue;
      const title = getSongTitle(theme);
      const artist = getArtistName(theme);
      // Exclure covers / versions alternatives
      if (/cover|alternative|yorinuki|remix|version/i.test(title)) break;
      if (!title || title.length <= 2) break;
      out.push({ type: theme.type, number: theme.sequence || 1, title, artist, videoUrl: video.link });
      break;
    }
  }
  return out;
}

// Espacement minimum entre deux requêtes réseau animethemes (~90 req/min).
let lastRequestAt = 0;
const MIN_INTERVAL_MS = 750;
async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// Recherche les thèmes d'un anime sur animethemes.moe
async function fetchThemesFromAnimeThemes(animeTitle, synonyms = []) {
  try {
    await throttle();
    const url = `${ANIMETHEMES_API}/anime?include=animethemes.song.artists,animethemes.animethemeentries.videos&q=${encodeURIComponent(animeTitle)}`;
    let res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
    // Respect de la limite de débit : si 429, on attend puis on réessaie une fois.
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('retry-after')) || 60) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
    }
    if (!res.ok) return [];
    const data = await res.json();
    const candidates = data.anime || [];
    if (!candidates.length) return [];

    // string-similarity est sensible à la casse → on compare en minuscules.
    // (AniList renvoie certains titres tout en majuscules : ONE PIECE, NARUTO…)
    const key = (s) => normalizeAnimeName(s).toLowerCase();
    const candKey = key(animeTitle);
    const synKeys = synonyms.map(key);

    let best = null;
    let bestScore = 0.4;
    for (const anime of candidates) {
      const target = key(anime.name);
      let score = stringSimilarity.compareTwoStrings(candKey, target);
      for (const sk of synKeys) {
        score = Math.max(score, stringSimilarity.compareTwoStrings(sk, target));
      }
      if (score > bestScore) {
        bestScore = score;
        best = anime;
      }
    }
    return best ? extractThemes(best, animeTitle) : [];
  } catch (err) {
    console.error('animethemes fetch error:', err.message);
    return [];
  }
}

// Récupère (ou crée) les Song d'un anime dans le catalogue global. Retourne les rows DB.
async function getOrCreateSongsForAnime(anilistId, animeTitle, synonyms = [], popularity = 0, altTitles = []) {
  // 1) Déjà des musiques en catalogue → réutilisation immédiate (aucun appel réseau).
  const existing = await prisma.song.findMany({ where: { anilistId } });
  if (existing.length) return existing;

  // 2) Déjà exploré mais 0 opening trouvé → ne pas re-chercher.
  const scanned = await prisma.scannedAnime.findUnique({ where: { anilistId } });
  if (scanned) return [];

  // 3) Jamais exploré → recherche animethemes (une seule fois).
  const themes = await fetchThemesFromAnimeThemes(animeTitle, synonyms);
  const cleanTitle = normalizeAnimeName(animeTitle);
  const rows = [];
  for (const t of themes) {
    const row = await prisma.song.upsert({
      where: {
        anilistId_type_number_title: {
          anilistId,
          type: t.type,
          number: t.number,
          title: t.title,
        },
      },
      update: { videoUrl: t.videoUrl, artist: t.artist, popularity, altTitles },
      create: {
        anilistId,
        animeTitle: cleanTitle,
        type: t.type,
        number: t.number,
        title: t.title,
        artist: t.artist,
        videoUrl: t.videoUrl,
        popularity,
        altTitles,
      },
    });
    rows.push(row);
  }
  // Marquer l'anime comme exploré (même si 0 opening) pour ne plus jamais le re-chercher.
  await prisma.scannedAnime.upsert({
    where: { anilistId },
    update: { songCount: rows.length, scannedAt: new Date(), animeTitle: cleanTitle },
    create: { anilistId, animeTitle: cleanTitle, songCount: rows.length },
  });
  return rows;
}

// Importe la liste AniList "completed" d'un user dans son catalogue perso.
// onProgress({ progress, current, total, message, matchedAnime, totalSongs })
async function importUserList(userId, username, onProgress, limit = 1000) {
  const animeList = await getCompletedAnime(username); // valide le pseudo (lève une erreur sinon)
  const total = Math.min(animeList.length, limit);
  let matchedAnime = 0;
  let totalSongs = 0;

  // Un import REMPLACE la liste perso (sinon changer de pseudo accumule les deux).
  // On ne supprime que les liens utilisateur, jamais le catalogue global partagé.
  await prisma.userCatalogEntry.deleteMany({ where: { userId } });

  for (let i = 0; i < total; i++) {
    const media = animeList[i];
    const title = media.title.romaji || media.title.english || 'Inconnu';
    onProgress?.({
      progress: Math.round(((i + 1) / total) * 100),
      current: i + 1,
      total,
      message: `Recherche d'openings pour ${title}...`,
      matchedAnime,
      totalSongs,
    });
    try {
      const songs = await getOrCreateSongsForAnime(
        media.id,
        title,
        media.synonyms || [],
        media.popularity || 0,
        buildAltTitles(media)
      );
      if (songs.length) {
        matchedAnime++;
        totalSongs += songs.length;
        // Rattacher au catalogue perso de l'utilisateur
        for (const song of songs) {
          await prisma.userCatalogEntry.upsert({
            where: { userId_songId: { userId, songId: song.id } },
            update: {},
            create: { userId, songId: song.id },
          });
        }
      }
    } catch (err) {
      console.error(`Erreur import ${title}:`, err.message);
    }
  }

  return { totalAnime: animeList.length, matchedAnime, totalSongs };
}

// Re-scan ciblé des Endings : pour les animes déjà explorés (OPs) mais pas encore
// scannés pour les EDs, récupère les ED sur animethemes et les ajoute au catalogue.
// Traite un lot (appeler en boucle jusqu'à remaining === 0). Réseau throttlé.
async function scanEndingsBatch(limit = 20) {
  const batch = await prisma.scannedAnime.findMany({
    where: { edScanned: false },
    take: limit,
    select: { anilistId: true, animeTitle: true },
  });
  if (!batch.length) return { processed: 0, added: 0, remaining: 0 };

  let added = 0;
  for (const a of batch) {
    try {
      const themes = await fetchThemesFromAnimeThemes(a.animeTitle, []);
      const eds = themes.filter((t) => t.type === 'ED');
      if (eds.length) {
        const ref = await prisma.song.findFirst({ where: { anilistId: a.anilistId }, select: { popularity: true, altTitles: true } });
        for (const t of eds) {
          await prisma.song.upsert({
            where: { anilistId_type_number_title: { anilistId: a.anilistId, type: t.type, number: t.number, title: t.title } },
            update: { videoUrl: t.videoUrl, artist: t.artist },
            create: {
              anilistId: a.anilistId, animeTitle: a.animeTitle, type: t.type, number: t.number,
              title: t.title, artist: t.artist, videoUrl: t.videoUrl,
              popularity: ref?.popularity || 0, altTitles: ref?.altTitles || [],
            },
          });
          added++;
        }
      }
    } catch { /* réseau indispo : on marque quand même pour ne pas bloquer la boucle */ }
    await prisma.scannedAnime.update({ where: { anilistId: a.anilistId }, data: { edScanned: true } });
  }
  const remaining = await prisma.scannedAnime.count({ where: { edScanned: false } });
  return { processed: batch.length, added, remaining };
}

module.exports = { importUserList, getOrCreateSongsForAnime, normalizeAnimeName, buildAltTitles, scanEndingsBatch };
