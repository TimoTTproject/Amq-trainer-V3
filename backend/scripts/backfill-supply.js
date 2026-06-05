// Backfill « rareté réelle » : initialise maxSupply/minted/nextSerial/soldOut et
// transforme les collections existantes (UserCard.copies) en exemplaires numérotés
// (CardInstance). Ne traite que les personnages non encore initialisés (maxSupply=0),
// donc rapide et sûr à lancer à chaque démarrage (prestart).
//   node scripts/backfill-supply.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { prisma } = require('../src/db');
const { MAX_SUPPLY } = require('../src/gacha/rarity');

async function main() {
  const pending = await prisma.character.findMany({
    where: { maxSupply: 0 },
    select: { id: true, rarity: true },
  });
  if (!pending.length) {
    console.log('Stock déjà initialisé — rien à faire.');
    await prisma.$disconnect();
    return;
  }
  console.log(`${pending.length} personnage(s) à initialiser…`);

  let mintedTotal = 0;
  let done = 0;
  for (const c of pending) {
    const cap = MAX_SUPPLY[c.rarity] || 1000000;

    // Si des instances existent déjà (reprise), on recalcule depuis elles.
    let minted = await prisma.cardInstance.count({ where: { characterId: c.id } });
    if (minted === 0) {
      // Sinon, frappe une instance par copie possédée, numérotée en continu.
      const cards = await prisma.userCard.findMany({ where: { characterId: c.id }, select: { userId: true, copies: true } });
      let serial = 0;
      const data = [];
      for (const card of cards) {
        for (let k = 0; k < card.copies; k++) { serial++; data.push({ characterId: c.id, serial, userId: card.userId }); }
      }
      if (data.length) await prisma.cardInstance.createMany({ data });
      minted = serial;
    }
    const maxSerial = await prisma.cardInstance.aggregate({ where: { characterId: c.id }, _max: { serial: true } });
    const nextSerial = maxSerial._max.serial || 0;

    await prisma.character.update({
      where: { id: c.id },
      data: {
        maxSupply: Math.max(cap, minted), // jamais sous ce qui existe déjà
        minted,
        nextSerial,
        soldOut: minted >= cap,
      },
    });
    mintedTotal += minted;
    if (++done % 300 === 0) console.log(`  ${done}/${pending.length}…`);
  }

  console.log(`✅ Stock initialisé : ${done} personnages, ${mintedTotal} exemplaires.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error('backfill-supply:', e.message); process.exit(1); });
