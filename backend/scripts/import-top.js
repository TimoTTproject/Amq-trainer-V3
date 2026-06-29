// Import en masse du top N des animes les plus populaires d'AniList
// dans le catalogue global. Reprend là où il s'est arrêté (saute le déjà-importé).
//
//   node scripts/import-top.js [N] [pageDébut]
//   node scripts/import-top.js 500            → top 500 (pages 1→10)
//   node scripts/import-top.js 500 11         → 500 animes à partir de la page 11
//                                               (≈ rangs 501→1000), pour aller + loin
//
// Respecte les limites de débit (le service espace les requêtes animethemes).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { getPopularAnime } = require('../src/anilist/anilist.service');
const { getOrCreateSongsForAnime, buildAltTitles } = require('../src/catalog/catalog.service');

const PER_PAGE = 50;

async function main() {
  const target = parseInt(process.argv[2]) || 300;
  const startPage = Math.max(1, parseInt(process.argv[3]) || 1);
  const pages = Math.ceil(target / PER_PAGE);
  const lastPage = startPage + pages - 1;
  console.log(`Import de ${target} animes populaires (pages ${startPage}→${lastPage})…\n`);

  let processed = 0;
  let withSongs = 0;
  let totalSongs = 0;
  const t0 = Date.now();

  for (let page = startPage; page <= lastPage; page++) {
    let media;
    try {
      media = await getPopularAnime(page, PER_PAGE);
    } catch (err) {
      console.error(`Page ${page} échouée (${err.message}), pause 60s…`);
      await new Promise((r) => setTimeout(r, 60000));
      page--; // réessayer la même page
      continue;
    }
    for (const m of media) {
      if (processed >= target) break;
      processed++;
      const title = m.title.romaji || m.title.english || `#${m.id}`;
      try {
        const songs = await getOrCreateSongsForAnime(m.id, title, m.synonyms || [], m.popularity || 0, buildAltTitles(m), m.format || null);
        if (songs.length) {
          withSongs++;
          totalSongs += songs.length;
        }
        const tag = songs.length ? `✓ ${songs.length}` : '·  ';
        console.log(`[${processed}/${target}] ${tag}  ${title}`);
      } catch (err) {
        console.error(`[${processed}/${target}] ✗  ${title} — ${err.message}`);
      }
    }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  const totalInDb = await prisma.song.count();
  console.log(
    `\nTerminé en ${mins} min : ${withSongs}/${processed} animes avec openings, ` +
      `${totalSongs} musiques ajoutées. Catalogue global : ${totalInDb} musiques.`
  );
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
