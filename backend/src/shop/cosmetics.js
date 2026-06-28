// Catalogue des cosmétiques (boutique). Défini en code : pas de gestion BDD.
// Chaque item porte un `css` (style inline appliqué à l'élément cible côté front)
// et/ou une `className` (pour les effets animés définis dans styles.css).
//
// 4 emplacements (slots) :
//   - cardBack      : dos de carte (face cachée à l'ouverture de booster)
//   - cardBorder    : bordure des cartes possédées (en plus de la couleur de rareté)
//   - profileBanner : fond du hero du profil
//   - avatarFrame   : anneau décoratif autour de l'avatar
//
// L'item `default` de chaque slot est gratuit et possédé par tout le monde
// implicitement (price 0, jamais stocké en BDD).

const COSMETICS = [
  // ── Dos de cartes ─────────────────────────────────────────────
  { id: 'back-default', slot: 'cardBack', name: 'Classique', price: 0,
    css: '', icon: 'fa-music' },
  { id: 'back-twilight', slot: 'cardBack', name: 'Crépuscule', price: 300,
    css: 'background:linear-gradient(135deg,#3a1c71,#d76d77,#ffaf7b)', icon: 'fa-moon' },
  { id: 'back-ocean', slot: 'cardBack', name: 'Océan', price: 300,
    css: 'background:linear-gradient(135deg,#0f2027,#2c5364,#00b4db)', icon: 'fa-water' },
  { id: 'back-sakura', slot: 'cardBack', name: 'Sakura', price: 500,
    css: 'background:linear-gradient(135deg,#ffafbd,#ffc3a0,#ff8fab)', icon: 'fa-fan' },
  { id: 'back-neon', slot: 'cardBack', name: 'Néon', price: 800,
    css: 'background:radial-gradient(circle at 50% 30%,#1a1a2e,#0f0f1a)', className: 'cb-neon', icon: 'fa-bolt' },
  { id: 'back-gold', slot: 'cardBack', name: 'Or royal', price: 1500,
    css: 'background:linear-gradient(135deg,#b8860b,#ffd700,#fff3b0,#b8860b)', className: 'cb-shine', icon: 'fa-crown' },

  // ── Bordures de cartes ────────────────────────────────────────
  { id: 'border-default', slot: 'cardBorder', name: 'Aucune', price: 0, css: '' },
  { id: 'border-silver', slot: 'cardBorder', name: 'Argent', price: 300,
    css: 'box-shadow:0 0 0 3px #cfd8dc,0 0 10px rgba(207,216,220,.6)' },
  { id: 'border-gold', slot: 'cardBorder', name: 'Or', price: 600,
    css: 'box-shadow:0 0 0 3px #ffd700,0 0 12px rgba(255,215,0,.6)' },
  { id: 'border-flame', slot: 'cardBorder', name: 'Flammes', price: 900,
    css: 'box-shadow:0 0 0 3px #ff5722,0 0 16px rgba(255,87,34,.7)' },
  { id: 'border-rainbow', slot: 'cardBorder', name: 'Arc-en-ciel', price: 1200,
    css: '', className: 'cosm-rainbow-border' },

  // ── Bannières de profil ───────────────────────────────────────
  { id: 'banner-default', slot: 'profileBanner', name: 'Classique', price: 0, css: '' },
  { id: 'banner-aurora', slot: 'profileBanner', name: 'Aurore', price: 400,
    css: 'background:linear-gradient(120deg,#1d2b64,#2a5298,#43cea2)' },
  { id: 'banner-forest', slot: 'profileBanner', name: 'Forêt', price: 400,
    css: 'background:linear-gradient(120deg,#134e5e,#71b280)' },
  { id: 'banner-sunset', slot: 'profileBanner', name: 'Coucher de soleil', price: 700,
    css: 'background:linear-gradient(120deg,#ff512f,#dd2476,#ff8a00)' },
  { id: 'banner-galaxy', slot: 'profileBanner', name: 'Galaxie', price: 700,
    css: 'background:linear-gradient(120deg,#0f0c29,#302b63,#24243e)' },
  { id: 'banner-holo', slot: 'profileBanner', name: 'Holographique', price: 1500,
    css: '', className: 'cosm-holo-banner' },

  // ── Cadres d'avatar ───────────────────────────────────────────
  { id: 'frame-default', slot: 'avatarFrame', name: 'Aucun', price: 0, css: '' },
  { id: 'frame-bronze', slot: 'avatarFrame', name: 'Bronze', price: 200,
    css: 'box-shadow:0 0 0 3px #cd7f32' },
  { id: 'frame-silver', slot: 'avatarFrame', name: 'Argent', price: 400,
    css: 'box-shadow:0 0 0 3px #cfd8dc,0 0 8px rgba(207,216,220,.6)' },
  { id: 'frame-gold', slot: 'avatarFrame', name: 'Or', price: 800,
    css: 'box-shadow:0 0 0 3px #ffd700,0 0 10px rgba(255,215,0,.6)' },
  { id: 'frame-mythic', slot: 'avatarFrame', name: 'Mythique', price: 1500,
    css: '', className: 'cosm-mythic-frame' },

  // ── EXCLUSIFS DE PALIER (débloqués par le rang classé/solo, non achetables) ──
  // tierReq = index de palier requis (1 Argent · 2 Or · 3 Platine · 4 Diamant · 5 Maître)
  { id: 'frame-rank-argent', slot: 'avatarFrame', name: 'Rang Argent', exclusive: true, tierReq: 1, icon: 'fa-medal',
    css: 'box-shadow:0 0 0 3px #b9c4cc,0 0 12px rgba(185,196,204,.7)' },
  { id: 'border-rank-or', slot: 'cardBorder', name: 'Rang Or', exclusive: true, tierReq: 2,
    css: 'box-shadow:0 0 0 3px #ffcf33,0 0 16px rgba(255,207,51,.7)' },
  { id: 'banner-rank-platine', slot: 'profileBanner', name: 'Rang Platine', exclusive: true, tierReq: 3,
    css: 'background:linear-gradient(120deg,#0aa3a3,#7fffd4,#0aa3a3)' },
  { id: 'back-rank-diamant', slot: 'cardBack', name: 'Rang Diamant', exclusive: true, tierReq: 4, icon: 'fa-gem',
    css: 'background:linear-gradient(135deg,#3a8dde,#7fd2ff,#dff6ff,#3a8dde)', className: 'cb-shine' },
  { id: 'frame-rank-maitre', slot: 'avatarFrame', name: 'Rang Maître', exclusive: true, tierReq: 5, icon: 'fa-crown',
    css: '', className: 'cosm-mythic-frame' },
];

const SLOTS = ['cardBack', 'cardBorder', 'profileBanner', 'avatarFrame'];
const SLOT_LABELS = {
  cardBack: 'Dos de cartes',
  cardBorder: 'Bordures de cartes',
  profileBanner: 'Bannières de profil',
  avatarFrame: "Cadres d'avatar",
};

const BY_ID = Object.fromEntries(COSMETICS.map((c) => [c.id, c]));
// Item par défaut (gratuit) de chaque slot
const DEFAULT_BY_SLOT = Object.fromEntries(
  SLOTS.map((s) => [s, COSMETICS.find((c) => c.slot === s && c.price === 0)])
);

function byId(id) {
  return id ? BY_ID[id] || null : null;
}

// Forme transmise au front pour appliquer un cosmétique
function publicCosmetic(c) {
  if (!c) return null;
  return {
    id: c.id, slot: c.slot, name: c.name, css: c.css || '', className: c.className || '', icon: c.icon || null,
    ...(c.exclusive ? { exclusive: true, tierReq: c.tierReq } : {}),
  };
}

// Résout les cosmétiques équipés d'un utilisateur en objets prêts à appliquer.
// Un slot vide → l'item par défaut du slot (apparence standard).
function resolveEquipped(user) {
  const out = {};
  for (const slot of SLOTS) {
    const equipped = byId(user && user[slot]);
    out[slot] = publicCosmetic(equipped || DEFAULT_BY_SLOT[slot]);
  }
  return out;
}

module.exports = {
  COSMETICS,
  SLOTS,
  SLOT_LABELS,
  byId,
  publicCosmetic,
  resolveEquipped,
  DEFAULT_BY_SLOT,
};
