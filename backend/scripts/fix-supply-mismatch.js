// Corrige les personnages dont maxSupply ne correspond plus à leur rareté actuelle
// (ex. un perso repassé "mythic" après un /admin/recompute-rarities qui gardait
// l'ancien plafond "legendary" de 250 au lieu de 60). Ne descend jamais sous le
// nombre déjà en circulation (minted).
//   node scripts/fix-supply-mismatch.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { MAX_SUPPLY } = require('../src/gacha/rarity');

async function main() {
  const all = await prisma.character.findMany({
    where: { maxSupply: { gt: 0 } },
    select: { id: true, name: true, rarity: true, maxSupply: true, minted: true },
  });

  const mismatched = all.filter((c) => {
    const cap = MAX_SUPPLY[c.rarity] || 1000000;
    return c.maxSupply !== Math.max(cap, c.minted);
  });

  if (!mismatched.length) {
    console.log('Aucun décalage maxSupply/rareté détecté.');
    await prisma.$disconnect();
    return;
  }

  console.log(`${mismatched.length} personnage(s) à corriger…`);
  for (const c of mismatched) {
    const cap = MAX_SUPPLY[c.rarity] || 1000000;
    const maxSupply = Math.max(cap, c.minted);
    await prisma.character.update({
      where: { id: c.id },
      data: { maxSupply, soldOut: c.minted >= maxSupply },
    });
    console.log(`  ${c.name}: ${c.maxSupply} → ${maxSupply} (${c.rarity})`);
  }

  console.log(`✅ ${mismatched.length} personnage(s) corrigé(s).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('fix-supply-mismatch:', e.message); process.exit(1); });
