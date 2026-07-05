// Construction du catalogue de musiques depuis animethemes.moe + AniList
const stringSimilarity = require('string-similarity');
const { prisma } = require('../db');
const { getCompletedAnime, getAnimeFormatsByIds, getAnimeRelationsByIds, getAnimeCoversByIds, getAnimeTitlesByIds } = require('../anilist/anilist.service');
const { norm } = require('../quiz/matching');

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

// Précision des réponses (franchises à nombreuses saisons — Pokémon, Yu-Gi-Oh…) :
// AniList liste souvent le surnom générique de la franchise comme synonyme de
// CHAQUE saison prise séparément (chacune a son propre anilistId). Gardé tel quel,
// ce synonyme rend n'importe quelle saison acceptée comme réponse pour n'importe
// quelle autre. Un titre/synonyme est « ambigu » s'il correspond (une fois
// normalisé comme une réponse de joueur, cf. matching.js) à ≥ 2 anilistId distincts.
// `entries` : [{ anilistId, animeTitle, altTitles }]. Renvoie l'ensemble des clés
// normalisées ambiguës.
function computeAmbiguousTitleKeys(entries) {
  const owners = new Map(); // clé normalisée -> Set<anilistId>
  const track = (anilistId, text) => {
    const key = norm(text);
    if (!key) return;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(anilistId);
  };
  for (const entry of entries) {
    track(entry.anilistId, entry.animeTitle);
    for (const alt of entry.altTitles || []) track(entry.anilistId, alt);
  }
  const ambiguous = new Set();
  for (const [key, ids] of owners) {
    if (ids.size > 1) ambiguous.add(key);
  }
  return ambiguous;
}

// Retire les synonymes ambigus d'une liste — jamais le titre principal lui-même
// (animeTitle n'est pas dans `altTitles`, donc toujours conservé).
function stripAmbiguousAltTitles(altTitles, ambiguousKeys) {
  return (altTitles || []).filter((alt) => !ambiguousKeys.has(norm(alt)));
}

// Filtre les synonymes d'un anime qu'on s'apprête à (re)cataloguer contre le reste
// du catalogue déjà existant, pour ne pas introduire une nouvelle ambiguïté à
// l'import. Ne couvre que le sens « nouveau synonyme entre en conflit avec de
// l'existant » — l'autre sens (un ancien synonyme devient ambigu à cause d'un
// import ultérieur) est traité par la passe de fond `dedupeAmbiguousAltTitles`.
async function filterAmbiguousAltTitles(altTitles, anilistId) {
  if (!altTitles || !altTitles.length) return altTitles || [];
  const existing = await prisma.song.findMany({
    where: { anilistId: { not: anilistId } },
    distinct: ['anilistId'],
    select: { animeTitle: true, altTitles: true },
  });
  const claimed = new Set();
  for (const row of existing) {
    claimed.add(norm(row.animeTitle));
    for (const alt of row.altTitles || []) claimed.add(norm(alt));
  }
  return altTitles.filter((alt) => !claimed.has(norm(alt)));
}

// Passe de fond : nettoie les synonymes ambigus déjà présents dans tout le
// catalogue (ex. catalogue importé avant l'existence de ce filtre). Auto-suffisant
// (aucun appel réseau), rejouable à volonté — idempotent une fois les synonymes
// retirés. Appelée une fois au démarrage (server.js) et disponible en admin.
async function dedupeAmbiguousAltTitles() {
  const rows = await prisma.song.findMany({
    distinct: ['anilistId'],
    select: { anilistId: true, animeTitle: true, altTitles: true },
  });
  const ambiguous = computeAmbiguousTitleKeys(rows);
  let updated = 0;
  for (const row of rows) {
    const kept = stripAmbiguousAltTitles(row.altTitles, ambiguous);
    if (kept.length !== (row.altTitles || []).length) {
      await prisma.song.updateMany({ where: { anilistId: row.anilistId }, data: { altTitles: kept } });
      updated++;
    }
  }
  return { scanned: rows.length, ambiguousKeys: ambiguous.size, updated };
}

// Un titre n'est qu'un fragment de saison/partie (le vrai nom a disparu) : à éviter.
// Ex. « 2nd Season », « Season 2 », « Part 1 », « Anime inconnu ».
function isSeasonFragment(s) {
  const t = (s || '').trim();
  if (!t || t === 'Anime inconnu' || t === 'Inconnu') return true;
  return /^(\d+(st|nd|rd|th)\s+)?(season|cour|part|saison|partie)\b/i.test(t)
    || /^(s\d+|part\s*\d+|cour\s*\d+|season\s*\d+|the\s+final\b)/i.test(t);
}

function normalizeAnimeName(name) {
  if (!name || name === 'undefined' || name === 'null') return 'Anime inconnu';
  let n = name.toString().trim();
  if (/^gintama/i.test(n)) return n; // Gintama : garder les saisons distinctes
  // On retire les annotations entre parenthèses/crochets — SAUF si cela vide le
  // titre ou ne laisse qu'un fragment de saison. Certains titres ont des crochets
  // intégrés au nom (ex. « [Oshi no Ko] ») qu'il ne faut surtout pas supprimer.
  const stripped = n.replace(/\[.*?\]|\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  n = isSeasonFragment(stripped) ? n.replace(/\s+/g, ' ').trim() : stripped;
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
    if (theme.type !== 'OP' && theme.type !== 'ED') continue; // openings + endings (jamais d'insert songs)
    // Versions non-spoiler d'abord (une entry « spoiler » = variante d'épisode
    // spécial/final avec visuels divulgâcheurs — souvent atypique musicalement).
    const entries = [...(theme.animethemeentries || [])].sort((a, b) => (a.spoiler === b.spoiler ? 0 : a.spoiler ? 1 : -1));
    for (const entry of entries) {
      const videos = (entry.videos || []).filter((v) => v.link && v.basename !== 'NC');
      // Préfère un extrait « propre » : overlap None = pas de dialogues/bruitages
      // de l'épisode par-dessus la musique (faux airs d'insert song sinon).
      const video = videos.find((v) => v.overlap === 'None') || videos[0];
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

// Une requête de recherche sur animethemes (avec gestion 429). Renvoie les candidats.
async function searchAnimeThemes(query) {
  await throttle();
  const url = `${ANIMETHEMES_API}/anime?include=animethemes.song.artists,animethemes.animethemeentries.videos&q=${encodeURIComponent(query)}`;
  let res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
  if (res.status === 429) {
    const wait = (parseInt(res.headers.get('retry-after')) || 60) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
  }
  if (!res.ok) return [];
  const data = await res.json();
  return data.anime || [];
}

// Résolution fiable par identifiant AniList : animethemes.moe référence les sites externes
// (AniList, MAL…) de chaque anime. Contrairement à la recherche floue par titre — qui peut
// se tromper d'anime pour des franchises proches (film/OVA/compilation au titre voisin,
// ex. « Parallel Works » confondu avec la série TV) — cette correspondance est univoque.
// Repli sur la recherche par titre uniquement si l'anime n'a pas (encore) de ressource
// AniList référencée là-bas.
async function fetchAnimeByAnilistId(anilistId) {
  await throttle();
  const params = new URLSearchParams({
    'filter[site]': 'AniList',
    'filter[external_id]': String(anilistId),
    include: 'anime.animethemes.song.artists,anime.animethemes.animethemeentries.videos',
  });
  const url = `${ANIMETHEMES_API}/resources?${params.toString()}`;
  let res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
  if (res.status === 429) {
    const wait = (parseInt(res.headers.get('retry-after')) || 60) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(url, { headers: ANIMETHEMES_HEADERS });
  }
  if (!res.ok) return null;
  const data = await res.json();
  for (const resource of data.resources || []) {
    const anime = (resource.anime || [])[0];
    if (anime) return anime;
  }
  return null;
}

// Recherche les thèmes d'un anime sur animethemes.moe. Essaie d'abord la correspondance
// univoque par anilistId, puis se replie sur la recherche floue par titre (titre principal
// puis titres alternatifs) — beaucoup d'animes se trouvent mieux via leur titre anglais.
async function fetchThemesFromAnimeThemes(animeTitle, synonyms = [], anilistId = null) {
  try {
    if (anilistId) {
      const anime = await fetchAnimeByAnilistId(anilistId);
      if (anime) return extractThemes(anime, animeTitle);
    }

    // string-similarity est sensible à la casse → on compare en minuscules.
    // (AniList renvoie certains titres tout en majuscules : ONE PIECE, NARUTO…)
    const key = (s) => normalizeAnimeName(s).toLowerCase();
    const candKey = key(animeTitle);
    const synKeys = synonyms.map(key);
    const scoreOf = (name) => {
      const target = key(name);
      let score = stringSimilarity.compareTwoStrings(candKey, target);
      for (const sk of synKeys) score = Math.max(score, stringSimilarity.compareTwoStrings(sk, target));
      return score;
    };

    // Requêtes à tenter : titre principal, puis jusqu'à 2 synonymes distincts.
    const queries = [];
    for (const q of [animeTitle, ...synonyms]) {
      const t = (q || '').trim();
      if (t && !queries.some((x) => x.toLowerCase() === t.toLowerCase())) queries.push(t);
      if (queries.length >= 3) break;
    }

    let best = null;
    let bestScore = 0.4;
    const seen = new Set();
    for (const q of queries) {
      const candidates = await searchAnimeThemes(q);
      for (const anime of candidates) {
        if (anime.id != null) { if (seen.has(anime.id)) continue; seen.add(anime.id); }
        const score = scoreOf(anime.name);
        if (score > bestScore) { bestScore = score; best = anime; }
      }
      if (best && bestScore >= 0.7) break; // bonne correspondance trouvée → on arrête
    }
    return best ? extractThemes(best, animeTitle) : [];
  } catch (err) {
    console.error('animethemes fetch error:', err.message);
    return [];
  }
}

// Récupère (ou crée) les Song d'un anime dans le catalogue global. Retourne les rows DB.
async function getOrCreateSongsForAnime(anilistId, animeTitle, synonyms = [], popularity = 0, altTitles = [], format = null, addedByUserId = null) {
  // 1) Déjà des musiques en catalogue → réutilisation immédiate (aucun appel réseau).
  const existing = await prisma.song.findMany({ where: { anilistId } });
  if (existing.length) return existing;

  // 2) Déjà exploré mais 0 opening trouvé → ne pas re-chercher.
  const scanned = await prisma.scannedAnime.findUnique({ where: { anilistId } });
  if (scanned) return [];

  // 3) Jamais exploré → recherche animethemes (une seule fois).
  const themes = await fetchThemesFromAnimeThemes(animeTitle, synonyms, anilistId);
  const cleanTitle = normalizeAnimeName(animeTitle);
  // Précision des réponses : un synonyme déjà utilisé par un AUTRE anime du
  // catalogue (ex. « Pokemon » sur chaque saison) rendrait celui-ci interchangeable
  // avec l'autre — on ne le catalogue pas. (Inutile si 0 thème trouvé.)
  const safeAltTitles = themes.length ? await filterAmbiguousAltTitles(altTitles, anilistId) : altTitles;
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
      update: { videoUrl: t.videoUrl, artist: t.artist, popularity, altTitles: safeAltTitles, ...(format ? { format } : {}) },
      create: {
        anilistId,
        animeTitle: cleanTitle,
        type: t.type,
        number: t.number,
        title: t.title,
        artist: t.artist,
        videoUrl: t.videoUrl,
        popularity,
        altTitles: safeAltTitles,
        format,
        addedByUserId, // jamais réattribué à une réimportation (cf. `update` ci-dessus)
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
async function importUserList(userId, username, onProgress, limit = 1000, accessToken) {
  const animeList = await getCompletedAnime(username, accessToken); // valide le pseudo (lève une erreur sinon)
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
        buildAltTitles(media),
        media.format || null,
        userId
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
      const themes = await fetchThemesFromAnimeThemes(a.animeTitle, [], a.anilistId);
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

// Backfill du champ `format` (TV/MOVIE/OVA…) pour le catalogue existant.
// Traite un lot d'anilistId distincts encore sans format (appeler en boucle).
async function backfillFormatsBatch(limit = 50) {
  const rows = await prisma.song.findMany({
    where: { format: null },
    distinct: ['anilistId'],
    select: { anilistId: true },
    take: limit,
  });
  if (!rows.length) return { processed: 0, updated: 0, remaining: 0 };

  const ids = rows.map((r) => r.anilistId);
  let updated = 0;
  try {
    const media = await getAnimeFormatsByIds(ids);
    const formatById = new Map(media.map((m) => [m.id, m.format]).filter(([, f]) => f));
    for (const [anilistId, format] of formatById) {
      const res = await prisma.song.updateMany({ where: { anilistId, format: null }, data: { format } });
      updated += res.count;
    }
    // Les ids sans format renvoyé par AniList : on évite de boucler dessus
    // indéfiniment en posant une valeur neutre.
    const missing = ids.filter((id) => !formatById.has(id));
    if (missing.length) {
      await prisma.song.updateMany({ where: { anilistId: { in: missing }, format: null }, data: { format: 'UNKNOWN' } });
    }
  } catch (err) {
    console.warn('backfill format error:', err.message);
  }
  const remaining = await prisma.song.count({ where: { format: null } });
  return { processed: ids.length, updated, remaining };
}

// Backfill du numéro de saison (position dans la chaîne PREQUEL/SEQUEL AniList)
// pour distinguer les saisons d'une même œuvre dans les propositions du quiz
// (ex. Kaguya-sama S1/S2, dont les titres romaji ne diffèrent que par un « ? »).
// Traite un lot d'anilistId distincts encore sans seasonNumber (appeler en
// boucle jusqu'à remaining === 0, même mécanique que backfillFormatsBatch).
async function backfillSeasonsBatch(limit = 30) {
  const rows = await prisma.song.findMany({
    where: { seasonNumber: null },
    distinct: ['anilistId'],
    select: { anilistId: true },
    take: limit,
  });
  if (!rows.length) return { processed: 0, updated: 0, remaining: 0 };

  const seedIds = rows.map((r) => r.anilistId);
  // Résolution du graphe de relations par frontière successive : on part du lot
  // et on élargit aux voisins PREQUEL/SEQUEL pas encore vus, même hors catalogue
  // (un maillon manquant du catalogue ne doit pas casser la numérotation de la
  // chaîne). Bornée à 6 tours pour éviter une explosion sur une franchise géante.
  const visited = new Map(); // anilistId -> [{ relationType, nodeId }]
  let frontier = [...seedIds];
  let rounds = 0;
  while (frontier.length && rounds < 6) {
    const toFetch = frontier.filter((id) => !visited.has(id));
    if (!toFetch.length) break;
    const nextFrontier = new Set();
    for (let i = 0; i < toFetch.length; i += 50) {
      const slice = toFetch.slice(i, i + 50);
      let media;
      try {
        media = await getAnimeRelationsByIds(slice);
      } catch (err) {
        console.warn('backfill seasons relations error:', err.message);
        continue;
      }
      for (const m of media) {
        const edges = (m.relations?.edges || [])
          .filter((e) => e.node?.type === 'ANIME' && (e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL'))
          .map((e) => ({ relationType: e.relationType, nodeId: e.node.id }));
        visited.set(m.id, edges);
        for (const e of edges) if (!visited.has(e.nodeId)) nextFrontier.add(e.nodeId);
      }
      // ids demandés sans réponse AniList (supprimés/introuvables) : ne pas reboucler dessus
      for (const id of slice) if (!visited.has(id)) visited.set(id, []);
    }
    frontier = [...nextFrontier];
    rounds++;
  }

  // Graphe orienté u → v (v = SEQUEL de u), fusionné depuis les deux sens de
  // relation (chaque anime référence en général l'un OU l'autre côté).
  const forward = new Map(); // u -> Set<v>
  const hasIncoming = new Set();
  const addEdge = (u, v) => {
    if (!forward.has(u)) forward.set(u, new Set());
    forward.get(u).add(v);
    hasIncoming.add(v);
  };
  for (const [id, edges] of visited) {
    for (const e of edges) {
      if (e.relationType === 'SEQUEL') addEdge(id, e.nodeId);
      else addEdge(e.nodeId, id); // PREQUEL : nodeId est la saison précédente
    }
  }

  // Numérotation par composante : BFS depuis chaque racine (nœud sans arête
  // entrante) — racine = saison 1, ses SEQUEL directs = saison 2, etc.
  const seasonById = new Map();
  const globalSeen = new Set();
  for (const id of visited.keys()) {
    if (hasIncoming.has(id) || globalSeen.has(id)) continue;
    let level = 1;
    let queue = [id];
    while (queue.length) {
      const next = [];
      for (const n of queue) {
        if (globalSeen.has(n)) continue;
        globalSeen.add(n);
        seasonById.set(n, level);
        for (const v of forward.get(n) || []) if (!globalSeen.has(v)) next.push(v);
      }
      queue = next;
      level++;
    }
  }
  // Nœuds visités jamais atteints (composante réduite à eux-mêmes) → isolés.
  for (const id of visited.keys()) if (!globalSeen.has(id)) seasonById.set(id, 0);

  let updated = 0;
  for (const anilistId of seedIds) {
    const seasonNumber = seasonById.get(anilistId) ?? 0;
    // seasonNumber === 1 seul dans sa composante (pas de sequel trouvé) : pas
    // besoin d'afficher « S1 » pour une œuvre qui n'a jamais eu de suite.
    const finalNumber = seasonNumber === 1 && !hasIncoming.has(anilistId) && !(forward.get(anilistId)?.size) ? 0 : seasonNumber;
    const res = await prisma.song.updateMany({ where: { anilistId, seasonNumber: null }, data: { seasonNumber: finalNumber } });
    updated += res.count;
  }
  const remaining = await prisma.song.count({ where: { seasonNumber: null } });
  return { processed: seedIds.length, updated, remaining };
}

// Backfill des jaquettes AniList (`coverUrl`) — identité visuelle par licence
// (playlist, recherche…). Même mécanique que les formats : lot d'anilistId
// distincts encore sans jaquette, sentinelle '' pour les introuvables.
async function backfillCoversBatch(limit = 50) {
  const rows = await prisma.song.findMany({
    where: { coverUrl: null },
    distinct: ['anilistId'],
    select: { anilistId: true },
    take: limit,
  });
  if (!rows.length) return { processed: 0, updated: 0, remaining: 0 };

  const ids = rows.map((r) => r.anilistId);
  let updated = 0;
  try {
    const media = await getAnimeCoversByIds(ids);
    const coverById = new Map(media.map((m) => [m.id, m.coverImage?.medium]).filter(([, c]) => c));
    for (const [anilistId, coverUrl] of coverById) {
      const res = await prisma.song.updateMany({ where: { anilistId, coverUrl: null }, data: { coverUrl } });
      updated += res.count;
    }
    const missing = ids.filter((id) => !coverById.has(id));
    if (missing.length) {
      await prisma.song.updateMany({ where: { anilistId: { in: missing }, coverUrl: null }, data: { coverUrl: '' } });
    }
  } catch (err) {
    console.warn('backfill covers error:', err.message);
  }
  const remaining = await prisma.song.count({ where: { coverUrl: null } });
  return { processed: ids.length, updated, remaining };
}

// Répare les `animeTitle` corrompus (fragments de saison « 2nd Season », titres
// vides « Anime inconnu »…) : re-récupère le vrai titre sur AniList par anilistId
// et recalcule animeTitle + altTitles (+ format). À appeler en boucle jusqu'à
// remaining === 0. Réseau AniList limité (lots de 50).
async function repairBrokenTitlesBatch(limit = 50) {
  // anilistIds distincts dont le titre courant est cassé
  const rows = await prisma.song.findMany({ select: { anilistId: true, animeTitle: true }, distinct: ['anilistId'] });
  const badIds = [...new Set(rows.filter((r) => isSeasonFragment(r.animeTitle)).map((r) => r.anilistId))];
  if (!badIds.length) return { processed: 0, fixed: 0, remaining: 0 };

  const slice = badIds.slice(0, Math.min(limit, 50)); // AniList Page perPage = 50
  let media = [];
  try { media = await getAnimeTitlesByIds(slice); } catch (err) {
    console.warn('repair titres — AniList indispo:', err.message);
    return { processed: 0, fixed: 0, remaining: badIds.length };
  }
  const byId = new Map(media.map((m) => [m.id, m]));

  let fixed = 0;
  for (const id of slice) {
    const m = byId.get(id);
    if (!m) continue;
    const raw = m.title?.romaji || m.title?.english || m.title?.native;
    const animeTitle = normalizeAnimeName(raw);
    if (isSeasonFragment(animeTitle)) continue; // toujours pas exploitable → on laisse
    const data = { animeTitle, altTitles: await filterAmbiguousAltTitles(buildAltTitles(m), id) };
    if (m.format) data.format = m.format;
    await prisma.song.updateMany({ where: { anilistId: id }, data });
    // Garder le titre du cache d'exploration cohérent
    await prisma.scannedAnime.updateMany({ where: { anilistId: id }, data: { animeTitle } });
    fixed++;
  }
  return { processed: slice.length, fixed, remaining: Math.max(0, badIds.length - slice.length) };
}

module.exports = {
  importUserList,
  getOrCreateSongsForAnime,
  extractThemes,
  normalizeAnimeName,
  isSeasonFragment,
  buildAltTitles,
  scanEndingsBatch,
  backfillFormatsBatch,
  backfillSeasonsBatch,
  backfillCoversBatch,
  repairBrokenTitlesBatch,
  fetchThemesFromAnimeThemes,
  computeAmbiguousTitleKeys,
  stripAmbiguousAltTitles,
  filterAmbiguousAltTitles,
  dedupeAmbiguousAltTitles,
};
