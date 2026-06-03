// Remplit `altTitles` (titres romaji/anglais/natif/synonymes) pour les musiques
// déjà en base, en récupérant les titres depuis AniList par lots.
//   node scripts/backfill-titles.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { getAnimeTitlesByIds } = require('../src/anilist/anilist.service');
const { buildAltTitles } = require('../src/catalog/catalog.service');

const BATCH = 50;

async function main() {
  const rows = await prisma.song.findMany({ select: { anilistId: true }, distinct: ['anilistId'] });
  const ids = rows.map((r) => r.anilistId);
  console.log(`${ids.length} animes à compléter…\n`);

  let updatedAnimes = 0;
  let updatedSongs = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    let media;
    try {
      media = await getAnimeTitlesByIds(slice);
    } catch (err) {
      console.error(`Lot ${i}-${i + BATCH} échoué (${err.message}), pause 60s…`);
      await new Promise((r) => setTimeout(r, 60000));
      i -= BATCH;
      continue;
    }
    for (const m of media) {
      const altTitles = buildAltTitles(m);
      const res = await prisma.song.updateMany({ where: { anilistId: m.id }, data: { altTitles } });
      updatedAnimes++;
      updatedSongs += res.count;
      console.log(`✓ ${m.title.romaji || m.id} → ${altTitles.length} titres (${res.count} musiques)`);
    }
    await new Promise((r) => setTimeout(r, 800)); // limite de débit AniList
  }

  console.log(`\nTerminé : ${updatedAnimes} animes, ${updatedSongs} musiques mises à jour.`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
