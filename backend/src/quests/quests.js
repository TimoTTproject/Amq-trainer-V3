// Quêtes quotidiennes : génération, progression, et réclamation.
const { prisma } = require('../db');

const POOL = [
  { type: 'correct', label: 'Trouve 10 bonnes réponses', target: 10, reward: 40 },
  { type: 'correct', label: 'Trouve 20 bonnes réponses', target: 20, reward: 70 },
  { type: 'pull', label: 'Fais 5 tirages au gacha', target: 5, reward: 30 },
  { type: 'tower', label: 'Franchis 8 étages au Château', target: 8, reward: 40 },
  { type: 'mp', label: 'Termine 2 parties multijoueur', target: 2, reward: 50 },
  { type: 'like', label: 'Ajoute 3 sons à ta playlist', target: 3, reward: 20 },
  { type: 'daily', label: 'Termine le défi du jour', target: 1, reward: 30 },
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function pickDaily() {
  const types = shuffle([...new Set(POOL.map((q) => q.type))]).slice(0, 3);
  return types.map((t) => {
    const opts = POOL.filter((q) => q.type === t);
    return opts[(Math.random() * opts.length) | 0];
  });
}

// Récupère (ou crée) les quêtes du jour pour un utilisateur
async function ensureDailyQuests(userId) {
  const day = todayStr();
  let quests = await prisma.quest.findMany({ where: { userId, day }, orderBy: { id: 'asc' } });
  if (!quests.length) {
    await prisma.quest.createMany({
      data: pickDaily().map((p) => ({ userId, day, type: p.type, label: p.label, target: p.target, reward: p.reward })),
    });
    quests = await prisma.quest.findMany({ where: { userId, day }, orderBy: { id: 'asc' } });
  }
  return quests;
}

// Fait progresser les quêtes du jour d'un type donné (fire-and-forget)
async function progressQuests(userId, type, amount = 1) {
  try {
    await prisma.quest.updateMany({
      where: { userId, day: todayStr(), type, claimed: false },
      data: { progress: { increment: amount } },
    });
  } catch (e) {
    // ne bloque jamais le flux principal
  }
}

module.exports = { ensureDailyQuests, progressQuests, todayStr };
