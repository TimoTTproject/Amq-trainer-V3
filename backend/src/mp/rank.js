// Système classé multijoueur : paliers (tiers) + calcul des variations de MMR.

const TIERS = [
  { min: 0, name: 'Bronze', icon: '🥉' },
  { min: 900, name: 'Argent', icon: '🥈' },
  { min: 1200, name: 'Or', icon: '🥇' },
  { min: 1500, name: 'Platine', icon: '💎' },
  { min: 1800, name: 'Diamant', icon: '🔷' },
  { min: 2100, name: 'Maître', icon: '👑' },
];

// Chaque palier est divisé en 3 divisions (1 = bas du palier, 3 = proche du suivant).
const DIVISIONS = 3;
function tierFromMmr(mmr) {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (mmr >= TIERS[i].min) idx = i;
  const t = TIERS[idx];
  // Bande du palier (bande virtuelle de 300 pour le dernier, Maître).
  const nextMin = idx + 1 < TIERS.length ? TIERS[idx + 1].min : t.min + 300;
  const step = Math.max(1, (nextMin - t.min) / DIVISIONS);
  let d = Math.floor((mmr - t.min) / step) + 1; // 1 = bas de bande … DIVISIONS = haut
  d = Math.max(1, Math.min(DIVISIONS, d));
  // Convention LoL : I = meilleur (haut du palier) → on inverse.
  const division = DIVISIONS + 1 - d;
  return { name: t.name, icon: t.icon, division };
}

// Variations de MMR selon le classement (ELO basé sur le placement).
// players: [{ userId, score, mmr }] → renvoie [{ userId, place, delta }]
function computeMmrDeltas(players) {
  const n = players.length;
  if (n < 2) return players.map((p) => ({ userId: p.userId, place: 1, delta: 0 }));
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const place = new Map();
  sorted.forEach((p, i) => place.set(p.userId, i + 1));
  const K = 32;
  return players.map((p) => {
    const others = players.filter((o) => o.userId !== p.userId);
    const avg = others.reduce((s, o) => s + o.mmr, 0) / others.length;
    const expected = 1 / (1 + Math.pow(10, (avg - p.mmr) / 400));
    const placement = place.get(p.userId);
    const performance = (n - placement) / (n - 1); // 1 = 1er, 0 = dernier
    return { userId: p.userId, place: placement, delta: Math.round(K * (performance - expected)) };
  });
}

module.exports = { tierFromMmr, computeMmrDeltas, TIERS };
