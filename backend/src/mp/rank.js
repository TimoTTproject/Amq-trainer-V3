// Système classé multijoueur : paliers (tiers) + calcul des variations de MMR.

const TIERS = [
  { min: 0, name: 'Bronze', icon: '🥉' },
  { min: 900, name: 'Argent', icon: '🥈' },
  { min: 1200, name: 'Or', icon: '🥇' },
  { min: 1500, name: 'Platine', icon: '💎' },
  { min: 1800, name: 'Diamant', icon: '🔷' },
  { min: 2100, name: 'Maître', icon: '👑' },
];

function tierFromMmr(mmr) {
  let t = TIERS[0];
  for (const x of TIERS) if (mmr >= x.min) t = x;
  return { name: t.name, icon: t.icon };
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

module.exports = { tierFromMmr, computeMmrDeltas };
