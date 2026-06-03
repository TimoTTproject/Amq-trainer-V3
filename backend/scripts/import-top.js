// Import en masse du top N des animes les plus populaires d'AniList
// dans le catalogue global. Reprend là où il s'est arrêté (saute le déjà-importé).
//
//   node scripts/import-top.js [N]
//   node scripts/import-top.js 500
//
// Respecte les limites de débit (le service espace les requêtes animethemes).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { getPopularAnime } = require('../src/anilist/anilist.service');
const { getOrCreateSongsForAnime } = require('../src/catalog/catalog.service');

const PER_PAGE = 50;

async function main() {
  const target = parseInt(process.argv[2]) || 300;
  const pages = Math.ceil(target / PER_PAGE);
  console.log(`Import des ${target} animes les plus populaires (${pages} pages)…\n`);

  let processed = 0;
  let withSongs = 0;
  let totalSongs = 0;
  const t0 = Date.now();

  for (let page = 1; page <= pages; page++) {
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
        const songs = await getOrCreateSongsForAnime(m.id, title, m.synonyms || [], m.popularity || 0);
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
