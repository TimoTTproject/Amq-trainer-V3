function comparableTitle(value) {
  return String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

// altTitles est construit dans l'ordre AniList : romaji, anglais, natif,
// synonymes. Le titre principal correspond normalement au premier élément.
function englishTitleFor(song) {
  const titles = song.altTitles || [];
  const primaryIndex = titles.findIndex((title) => comparableTitle(title) === comparableTitle(song.animeTitle));
  const candidate = primaryIndex >= 0 ? titles[primaryIndex + 1] : null;
  return candidate && /[a-z]/i.test(candidate) ? candidate : null;
}

module.exports = { comparableTitle, englishTitleFor };
