// Quêtes quotidiennes : génération, progression, et réclamation.
const { prisma } = require('../db');

// Chaque `type` DOIT avoir un point de progression (progressQuests) câblé
// quelque part dans le jeu, sinon la quête serait impossible à terminer.
// Types câblés : correct, played (quiz) · pull, fuse (gacha) · tower · mp ·
// like (playlist) · daily (défi) · trade (échange) · market (marché).
const POOL = [
  // Quiz — bonnes réponses
  { type: 'correct', label: 'Trouve 10 bonnes réponses', target: 10, reward: 40 },
  { type: 'correct', label: 'Trouve 20 bonnes réponses', target: 20, reward: 70 },
  { type: 'correct', label: 'Trouve 35 bonnes réponses', target: 35, reward: 110 },
  // Quiz — manches jouées (peu importe le résultat)
  { type: 'played', label: 'Joue 15 manches de quiz', target: 15, reward: 35 },
  { type: 'played', label: 'Joue 30 manches de quiz', target: 30, reward: 65 },
  // Gacha
  { type: 'pull', label: 'Fais 5 tirages au gacha', target: 5, reward: 30 },
  { type: 'pull', label: 'Fais 10 tirages au gacha', target: 10, reward: 55 },
  // Atelier — fusion de doublons
  { type: 'fuse', label: "Fusionne des cartes à l'Atelier", target: 1, reward: 40 },
  // Château de l'Infini
  { type: 'tower', label: 'Franchis 8 étages au Château', target: 8, reward: 40 },
  { type: 'tower', label: 'Franchis 15 étages au Château', target: 15, reward: 70 },
  // Multijoueur
  { type: 'mp', label: 'Termine 2 parties multijoueur', target: 2, reward: 50 },
  { type: 'mp', label: 'Termine 4 parties multijoueur', target: 4, reward: 90 },
  // Playlist
  { type: 'like', label: 'Ajoute 3 sons à ta playlist', target: 3, reward: 20 },
  // Défi du jour
  { type: 'daily', label: 'Termine le défi du jour', target: 1, reward: 30 },
  // Échange entre joueurs
  { type: 'trade', label: 'Réalise un échange de cartes', target: 1, reward: 45 },
  // Marché — mets une carte en vente ou achètes-en une
  { type: 'market', label: 'Mets une carte en vente ou achète au marché', target: 1, reward: 35 },
];

const DAILY_COUNT = 4; // nombre de quêtes tirées chaque jour (types distincts)

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function pickDaily(excludedTypes = []) {
  const excluded = new Set(excludedTypes);
  const types = shuffle([...new Set(POOL.map((q) => q.type))].filter((type) => !excluded.has(type))).slice(0, DAILY_COUNT);
  return types.map((t) => {
    const opts = POOL.filter((q) => q.type === t);
    return opts[(Math.random() * opts.length) | 0];
  });
}

async function syncCompletedDailyQuests(userId, day, quests) {
  const dailyQuests = quests.filter((q) => q.type === 'daily' && !q.claimed && q.progress < q.target);
  if (!dailyQuests.length) return quests;

  try {
    const run = await prisma.dailyRun.findUnique({
      where: { userId_day: { userId, day } },
      select: { finished: true },
    });
    if (!run?.finished) return quests;

    const ids = dailyQuests.map((q) => q.id);
    await prisma.quest.updateMany({
      where: { id: { in: ids }, userId, type: 'daily', claimed: false },
      data: { progress: 1 },
    });
    return quests.map((q) => (ids.includes(q.id) ? { ...q, progress: q.target } : q));
  } catch (e) {
    // Ne bloque jamais l'affichage des quêtes.
    return quests;
  }
}

// Récupère (ou crée) les quêtes du jour pour un utilisateur
async function ensureDailyQuests(userId) {
  const day = todayStr();
  let todayQuests = await prisma.quest.findMany({ where: { userId, day }, orderBy: { id: 'asc' } });
  if (!todayQuests.length) {
    await prisma.quest.createMany({
      data: pickDaily().map((p) => ({ userId, day, type: p.type, label: p.label, target: p.target, reward: p.reward })),
    });
    todayQuests = await prisma.quest.findMany({ where: { userId, day }, orderBy: { id: 'asc' } });
  } else if (todayQuests.length < DAILY_COUNT) {
    const missing = DAILY_COUNT - todayQuests.length;
    const additions = pickDaily(todayQuests.map((q) => q.type)).slice(0, missing);
    if (additions.length) {
      await prisma.quest.createMany({
        data: additions.map((p) => ({ userId, day, type: p.type, label: p.label, target: p.target, reward: p.reward })),
      });
      todayQuests = await prisma.quest.findMany({ where: { userId, day }, orderBy: { id: 'asc' } });
    }
  }
  const visibleQuests = await prisma.quest.findMany({
    where: { userId, OR: [{ claimed: false }, { day }] },
    orderBy: [{ day: 'desc' }, { id: 'asc' }],
  });
  return syncCompletedDailyQuests(userId, day, visibleQuests);
}

// Fait progresser les quêtes du jour d'un type donné (fire-and-forget)
async function progressQuests(userId, type, amount = 1) {
  try {
    await prisma.quest.updateMany({
      where: { userId, type, claimed: false },
      data: { progress: { increment: amount } },
    });
  } catch (e) {
    // ne bloque jamais le flux principal
  }
}

module.exports = { ensureDailyQuests, progressQuests, todayStr };
