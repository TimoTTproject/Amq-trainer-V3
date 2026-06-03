// Importe le pool de personnages du gacha : top N personnages AniList (favourites),
// avec attribution de la rareté par rang.
//   node scripts/import-characters.js [N]   (défaut 2500)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { getTopCharacters } = require('../src/anilist/anilist.service');
const { rarityForRank, RARITY_LABELS } = require('../src/gacha/rarity');

const PER_PAGE = 50;

async function main() {
  const target = parseInt(process.argv[2]) || 2500;
  console.log(`Récupération du top ${target} personnages AniList…\n`);

  // 1) Collecte
  const all = [];
  let page = 1;
  while (all.length < target) {
    let res;
    try {
      res = await getTopCharacters(page, PER_PAGE);
    } catch (err) {
      console.error(`Page ${page} échouée (${err.message}), pause 60s…`);
      await new Promise((r) => setTimeout(r, 60000));
      continue;
    }
    all.push(...res.characters);
    process.stdout.write(`\r  ${all.length} personnages récupérés…`);
    if (!res.hasNextPage) break;
    page++;
    await new Promise((r) => setTimeout(r, 700)); // limite de débit AniList
  }
  const pool = all.slice(0, target);
  console.log(`\n\n${pool.length} personnages. Attribution des raretés + enregistrement…`);

  // 2) Tri par favourites décroissant + rareté par rang
  pool.sort((a, b) => (b.favourites || 0) - (a.favourites || 0));
  const counts = {};
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i];
    const rarity = rarityForRank(i, pool.length);
    counts[rarity] = (counts[rarity] || 0) + 1;
    await prisma.character.upsert({
      where: { anilistId: c.id },
      update: { name: c.name.full, imageUrl: c.image?.large, favourites: c.favourites || 0, rarity },
      create: { anilistId: c.id, name: c.name.full, imageUrl: c.image?.large, favourites: c.favourites || 0, rarity },
    });
  }

  console.log('\nRépartition :');
  for (const r of ['mythic', 'legendary', 'epic', 'rare', 'common']) {
    console.log(`  ${RARITY_LABELS[r]} : ${counts[r] || 0}`);
  }
  const total = await prisma.character.count();
  console.log(`\nTerminé. Personnages en base : ${total}`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
