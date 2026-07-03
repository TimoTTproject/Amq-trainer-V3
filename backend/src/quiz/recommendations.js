const { isMainFormat } = require('../catalog/format');

function cleanArtist(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

// Sépare un crédit d'artiste en interprètes individuels : un même chanteur/groupe
// doit matcher quelle que soit la façon dont il est crédité (« LiSA », « LiSA feat. X »,
// « groupe × autre groupe », « A & B »…).
const ARTIST_SPLIT = /\s*(?:,|&|×|✕|／|\/|\+|、|·|;|\bfeaturing\b|\bfeat\.?|\bft\.?)\s*/i;
function artistTokens(value) {
  return [
    ...new Set(
      String(value || '')
        .split(ARTIST_SPLIT)
        .map((t) => t.trim().toLocaleLowerCase())
        .filter((t) => t.length >= 2)
    ),
  ];
}

// Détecte les contenus secondaires (films, OAV/OAD, spéciaux, récaps) d'après le
// titre, pour les déprioriser face à la série principale (TV) à popularité comparable.
// Heuristique : faute du champ `format` AniList, on s'appuie sur les marqueurs de titre.
const SIDE_CONTENT = /(?:gekijou(?:ban)?|劇場版|総集編|\bthe movie\b|\bmovie\b|\bfilm\b|\bova\b|\boav\b|\boad\b|\bona\b|\bspecials?\b|\brecap\b|\bpicture drama\b)/i;
function isSideContent(title) {
  return SIDE_CONTENT.test(String(title || ''));
}

function increment(map, key) {
  if (key === null || key === undefined || key === '') return;
  map.set(key, (map.get(key) || 0) + 1);
}

// Identifie un même morceau indépendamment de l'anilistId : le catalogue contient
// parfois des doublons du même opening/ending rattachés à un anilistId différent
// (film/compilation/single mal matché côté import) — on ne veut ni le recommander
// s'il est déjà dans la playlist, ni le montrer deux fois dans les suggestions.
function songKey(song) {
  const title = String(song.title || '').trim().toLocaleLowerCase();
  // Le titre est requis en base (jamais vide en pratique) : sans lui, deux entrées
  // ne peuvent pas être confirmées identiques, donc on les traite comme distinctes.
  if (!title) return `id:${song.id}`;
  return [song.type || '', song.number || '', title, cleanArtist(song.artist)].join('|');
}

// Entre deux doublons du même morceau, garde la version « série principale »
// (format connu non secondaire), puis la plus populaire.
function betterDuplicate(a, b) {
  const aSide = a.format && !isMainFormat(a.format);
  const bSide = b.format && !isMainFormat(b.format);
  if (aSide !== bSide) return aSide ? b : a;
  return (b.popularity || 0) > (a.popularity || 0) ? b : a;
}

function dedupeSongs(songs) {
  const byKey = new Map();
  for (const song of songs) {
    const key = songKey(song);
    const existing = byKey.get(key);
    byKey.set(key, existing ? betterDuplicate(existing, song) : song);
  }
  return [...byKey.values()];
}

function rankRecommendations({ likedSongs = [], candidates = [], collaborativeCounts = new Map(), limit = 8 }) {
  const artistLikes = new Map();
  const seriesLikes = new Map();
  const typeLikes = new Map();

  for (const song of likedSongs) {
    for (const token of artistTokens(song.artist)) increment(artistLikes, token);
    increment(seriesLikes, song.anilistId);
    increment(typeLikes, song.type);
  }

  // Écarte les candidats qui sont en réalité déjà dans la playlist (même morceau,
  // simplement cataloguée sous un anilistId différent), puis les doublons entre eux.
  const likedKeys = new Set(likedSongs.map(songKey));
  candidates = dedupeSongs(candidates.filter((song) => !likedKeys.has(songKey(song))));

  const maxPopularity = Math.max(1, ...candidates.map((song) => song.popularity || 0));
  const maxCollaborative = Math.max(1, ...collaborativeCounts.values());
  const likedTotal = Math.max(1, likedSongs.length);

  const ranked = candidates.map((song) => {
    // Force de la correspondance d'artiste : somme des « likes » des interprètes
    // de ce morceau présents dans la playlist (gère feat./collabs/groupes).
    const sameArtist = artistTokens(song.artist).reduce((sum, t) => sum + (artistLikes.get(t) || 0), 0);
    const sameSeries = seriesLikes.get(song.anilistId) || 0;
    const collaborative = collaborativeCounts.get(song.id) || 0;
    const typeAffinity = (typeLikes.get(song.type) || 0) / likedTotal;
    const popularity = Math.log1p(song.popularity || 0) / Math.log1p(maxPopularity);
    // Film/OAV/spécial → on déprioritise, sauf si c'est exactement un anime déjà aimé.
    // On se fie au format AniList quand il est connu, sinon à l'heuristique de titre.
    const knownFormat = song.format && song.format !== 'UNKNOWN';
    const side = !sameSeries && (knownFormat ? !isMainFormat(song.format) : isSideContent(song.animeTitle));

    const score =
      (sameSeries ? 7 + Math.min(3, sameSeries - 1) : 0) +
      (sameArtist ? 6 + Math.min(2, sameArtist - 1) : 0) +
      (collaborative / maxCollaborative) * 5 +
      typeAffinity * 1.5 +
      popularity * 1.5 -
      (side ? 4 : 0);

    let reason = 'Populaire sur AniList';
    if (collaborative) reason = 'Aimé par des joueurs aux goûts proches';
    if (sameArtist) reason = `Parce que tu écoutes ${song.artist}`;
    if (sameSeries) reason = `Un autre morceau de ${song.animeTitle}`;

    return { ...song, score, reason };
  });

  ranked.sort((a, b) => b.score - a.score || (b.popularity || 0) - (a.popularity || 0) || a.id - b.id);

  // Évite une sélection composée uniquement du même anime ou du même artiste.
  const selected = [];
  const seriesSelected = new Map();
  const artistsSelected = new Map();
  for (const song of ranked) {
    const artist = cleanArtist(song.artist);
    if ((seriesSelected.get(song.anilistId) || 0) >= 2 || (artist && (artistsSelected.get(artist) || 0) >= 2)) continue;
    selected.push(song);
    increment(seriesSelected, song.anilistId);
    increment(artistsSelected, artist);
    if (selected.length === limit) break;
  }
  if (selected.length < limit) {
    for (const song of ranked) {
      if (!selected.some((item) => item.id === song.id)) selected.push(song);
      if (selected.length === limit) break;
    }
  }

  return selected.map(({ score, ...song }) => song);
}

module.exports = { rankRecommendations, artistTokens, isSideContent, songKey };
