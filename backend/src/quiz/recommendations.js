function cleanArtist(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function increment(map, key) {
  if (key === null || key === undefined || key === '') return;
  map.set(key, (map.get(key) || 0) + 1);
}

function rankRecommendations({ likedSongs = [], candidates = [], collaborativeCounts = new Map(), limit = 8 }) {
  const artistLikes = new Map();
  const seriesLikes = new Map();
  const typeLikes = new Map();

  for (const song of likedSongs) {
    increment(artistLikes, cleanArtist(song.artist));
    increment(seriesLikes, song.anilistId);
    increment(typeLikes, song.type);
  }

  const maxPopularity = Math.max(1, ...candidates.map((song) => song.popularity || 0));
  const maxCollaborative = Math.max(1, ...collaborativeCounts.values());
  const likedTotal = Math.max(1, likedSongs.length);

  const ranked = candidates.map((song) => {
    const sameArtist = artistLikes.get(cleanArtist(song.artist)) || 0;
    const sameSeries = seriesLikes.get(song.anilistId) || 0;
    const collaborative = collaborativeCounts.get(song.id) || 0;
    const typeAffinity = (typeLikes.get(song.type) || 0) / likedTotal;
    const popularity = Math.log1p(song.popularity || 0) / Math.log1p(maxPopularity);

    const score =
      (sameSeries ? 7 + Math.min(3, sameSeries - 1) : 0) +
      (sameArtist ? 6 + Math.min(2, sameArtist - 1) : 0) +
      (collaborative / maxCollaborative) * 5 +
      typeAffinity * 1.5 +
      popularity * 1.5;

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

module.exports = { rankRecommendations };
