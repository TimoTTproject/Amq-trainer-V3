// Dojo (idle/clicker) — configuration et calculs purs (pas d'accès DB ici).
// Réutilise les raretés du gacha : un personnage assigné à un emplacement
// produit de l'essence en continu, proportionnellement à sa rareté, son
// niveau d'ascension (★, cf. gacha/rarity.js) et son niveau d'entraînement
// PROPRE à l'emplacement (illimité). Le Dojo lui-même a un niveau (dérivé de
// l'essence gagnée à vie) qui fait évoluer son décor et son bonus global.

const START_SLOTS = 3; // emplacements gratuits dès le départ
const MAX_SLOTS = 10; // emplacements max, débloqués un par un contre de l'essence

// Production d'essence par seconde, par carte assignée, à ★1 et avant
// multiplicateur global (amélioration « Discipline »).
const RARITY_RATE = {
  common: 0.05,
  rare: 0.2,
  epic: 0.8,
  legendary: 3,
  mythic: 12,
};

// Multiplicateur de production selon le niveau d'ascension de la carte assignée
// (même échelle 1-5 que l'ascension gacha, purement cosmétique là-bas — ici elle
// prend un sens : ascensionner ses meilleures cartes accélère le Dojo).
const STAR_MULTIPLIER = { 1: 1, 2: 1.2, 3: 1.5, 4: 2, 5: 3 };
function starMultiplier(stars) {
  return STAR_MULTIPLIER[Math.min(5, Math.max(1, stars || 1))] || 1;
}

// Niveau d'entraînement DE LA CARTE assignée (pas du compte) : illimité, remis
// à 1 quand on change de personnage sur l'emplacement (cf. IdleSlot.level).
// C'est le principal puits d'essence à long terme — ★ et Discipline plafonnent,
// pas ça : le coût croît plus vite que le gain, donc la progression ralentit
// sans jamais s'arrêter (courbe idle classique).
const CHAR_LEVEL_BONUS = 0.05; // +5% de production par niveau
function charLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * CHAR_LEVEL_BONUS;
}
const CHAR_LEVEL_BASE_COST = { common: 4, rare: 12, epic: 40, legendary: 140, mythic: 500 };
const CHAR_LEVEL_GROWTH = 1.16;
function charLevelUpCost(rarity, level) {
  const base = CHAR_LEVEL_BASE_COST[rarity] || CHAR_LEVEL_BASE_COST.common;
  return Math.round(base * Math.pow(CHAR_LEVEL_GROWTH, Math.max(1, level || 1) - 1));
}

// Taux de production d'un emplacement (essence/s), avant multiplicateurs
// globaux (Discipline + niveau du Dojo).
function slotRate(rarity, stars, charLevel) {
  return (RARITY_RATE[rarity] || 0) * starMultiplier(stars) * charLevelMultiplier(charLevel);
}

// Amélioration « Discipline » : multiplicateur de production globale.
const PROD_LEVEL_BONUS = 0.08; // +8% par niveau
const PROD_LEVEL_MAX = 40;
function prodMultiplier(level) {
  return 1 + Math.min(level, PROD_LEVEL_MAX) * PROD_LEVEL_BONUS;
}
function prodUpgradeCost(level) {
  return Math.round(50 * Math.pow(1.6, level));
}

// Amélioration « Concentration » : puissance du clic manuel.
const CLICK_BASE = 1;
const CLICK_LEVEL_BONUS = 1;
const CLICK_LEVEL_MAX = 30;
function clickYield(level) {
  return CLICK_BASE + Math.min(level, CLICK_LEVEL_MAX) * CLICK_LEVEL_BONUS;
}
function clickUpgradeCost(level) {
  return Math.round(30 * Math.pow(1.5, level));
}
const CLICK_COOLDOWN_MS = 900; // anti-spam serveur (rate-limit)

// Coût pour débloquer l'emplacement d'index `nextSlotIndex` (START_SLOTS..MAX_SLOTS-1).
function slotUpgradeCost(nextSlotIndex) {
  return Math.round(200 * Math.pow(2, nextSlotIndex - START_SLOTS));
}

// Plafond de production hors-ligne : au-delà, le surplus n'est plus compté —
// encourage à revenir régulièrement sans punir une grosse pause.
const OFFLINE_CAP_MS = 12 * 60 * 60 * 1000; // 12h

// Essence en attente depuis `lastCollectAt`, plafonnée à OFFLINE_CAP_MS, pour un
// taux de production total `totalRate` (essence/s).
function pendingEssence(lastCollectAt, totalRate, now = new Date()) {
  if (!lastCollectAt || totalRate <= 0) return 0;
  const elapsedMs = Math.min(OFFLINE_CAP_MS, Math.max(0, now.getTime() - new Date(lastCollectAt).getTime()));
  return (elapsedMs / 1000) * totalRate;
}

// ── Niveau du DOJO (le lieu, pas une carte) ──
// Dérivé de l'essence gagnée à VIE (User.essenceEarnedTotal, jamais décrémentée)
// via une suite géométrique — formule fermée, donc O(1) même à très haut niveau
// (pas de boucle : la progression est volontairement quasi infinie).
const DOJO_XP_BASE = 100; // XP (= essence gagnée) pour passer du niveau 1 au niveau 2
const DOJO_XP_GROWTH = 1.35; // +35% de coût par niveau
function dojoXpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round((DOJO_XP_BASE * (Math.pow(DOJO_XP_GROWTH, level - 1) - 1)) / (DOJO_XP_GROWTH - 1));
}
function dojoLevelForXp(xp) {
  if (!xp || xp <= 0) return 1;
  const raw = 1 + Math.log(1 + (xp * (DOJO_XP_GROWTH - 1)) / DOJO_XP_BASE) / Math.log(DOJO_XP_GROWTH);
  let level = Math.max(1, Math.floor(raw + 1e-9));
  // log/exp ne sont pas exacts : petite correction pour rester cohérent avec
  // dojoXpForLevel (la source de vérité), qui dérive sinon d'un niveau près
  // des seuils. Converge en 0-1 itération dans l'immense majorité des cas.
  while (dojoXpForLevel(level + 1) <= xp) level++;
  while (level > 1 && dojoXpForLevel(level) > xp) level--;
  return level;
}

// Bonus de production globale offert par le niveau du Dojo (cumulable avec Discipline).
const DOJO_LEVEL_BONUS = 0.01; // +1% par niveau de Dojo
function dojoLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * DOJO_LEVEL_BONUS;
}

// Décor du Dojo : change d'apparence par palier de niveau (voir public/idle.js).
// La liste boucle visuellement au-delà du dernier palier (même thème, le
// joueur reste dans le décor le plus prestigieux — pas de plafond de contenu
// pour autant, le niveau continue de grimper).
const DOJO_DECOR = [
  { level: 1, name: 'Dojo de bois', theme: 'wood', flavor: "Un simple dojo de planches. Le maître observe en silence : tout grand parcours commence humblement." },
  { level: 10, name: 'Jardin zen', theme: 'garden', flavor: "Les premiers cerisiers ont fleuri. La discipline porte ses fruits — au sens propre." },
  { level: 25, name: 'Temple écarlate', theme: 'temple', flavor: "Le Dojo attire des disciples de toute la région. Les lanternes ne s'éteignent plus." },
  { level: 50, name: 'Sanctuaire doré', theme: 'gold', flavor: "L'or orne les colonnes. On raconte votre entraînement jusque dans les capitales voisines." },
  { level: 100, name: 'Royaume céleste', theme: 'celestial', flavor: "Le Dojo a dépassé la légende. Les étoiles elles-mêmes semblent s'entraîner avec vous." },
];
function decorForLevel(level) {
  let current = DOJO_DECOR[0];
  let next = null;
  for (const tier of DOJO_DECOR) {
    if (level >= tier.level) current = tier;
    else { next = tier; break; }
  }
  return { current, next };
}

// ── Jalons (coffres) : tous les MILESTONE_INTERVAL niveaux de Dojo, un coffre
// d'essence est réclamable une fois. Permanents (jamais reperdus, y compris
// après une Prestige) puisqu'ils dépendent du niveau du Dojo, lui aussi permanent.
const MILESTONE_INTERVAL = 5;
const MILESTONE_BASE_REWARD = 50;
const MILESTONE_GROWTH = 1.5;
function milestoneTierForLevel(level) {
  return Math.floor((level || 1) / MILESTONE_INTERVAL);
}
function milestoneReward(tier) {
  if (tier <= 0) return 0;
  return Math.round(MILESTONE_BASE_REWARD * Math.pow(MILESTONE_GROWTH, tier - 1));
}

// ── Prestige (« Retraite du Maître ») : remet à zéro la RUN (essence,
// emplacements, niveaux de personnage, Discipline/Concentration) contre un
// bonus de production PERMANENT, cumulable indéfiniment. Le niveau du Dojo
// (donc son décor) et les jalons déjà réclamés sont conservés — seule la
// puissance personnelle du joueur repart de zéro, pas le lieu lui-même.
const PRESTIGE_MIN_DOJO_LEVEL = 10; // en dessous, rien à gagner à prestiger (on perdrait plus qu'on ne gagne)
const PRESTIGE_BONUS_PER_LEVEL = 0.1; // +10% de production permanente par Prestige
function prestigeMultiplier(level) {
  return 1 + Math.max(0, level || 0) * PRESTIGE_BONUS_PER_LEVEL;
}

module.exports = {
  START_SLOTS,
  MAX_SLOTS,
  RARITY_RATE,
  STAR_MULTIPLIER,
  starMultiplier,
  slotRate,
  PROD_LEVEL_BONUS,
  PROD_LEVEL_MAX,
  prodMultiplier,
  prodUpgradeCost,
  CLICK_BASE,
  CLICK_LEVEL_BONUS,
  CLICK_LEVEL_MAX,
  clickYield,
  clickUpgradeCost,
  CLICK_COOLDOWN_MS,
  slotUpgradeCost,
  OFFLINE_CAP_MS,
  pendingEssence,
  CHAR_LEVEL_BONUS,
  charLevelMultiplier,
  CHAR_LEVEL_BASE_COST,
  CHAR_LEVEL_GROWTH,
  charLevelUpCost,
  DOJO_XP_BASE,
  DOJO_XP_GROWTH,
  dojoXpForLevel,
  dojoLevelForXp,
  DOJO_LEVEL_BONUS,
  dojoLevelMultiplier,
  DOJO_DECOR,
  decorForLevel,
  MILESTONE_INTERVAL,
  MILESTONE_BASE_REWARD,
  MILESTONE_GROWTH,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  PRESTIGE_BONUS_PER_LEVEL,
  prestigeMultiplier,
};
