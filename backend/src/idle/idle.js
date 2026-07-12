// Dojo (idle/clicker) — configuration et calculs purs (pas d'accès DB ici).
// Jeu à PART ENTIÈRE, indépendant de la collection gacha : les personnages du
// roster sont RECRUTÉS contre de l'essence (voir RECRUIT_*/recruitCost plus
// bas), pas tirés au gacha — seule la table Character (nom/portrait/rareté)
// est partagée, comme référentiel de contenu, jamais UserCard/CardInstance/
// tokens. Un personnage assigné à un emplacement produit de l'essence en
// continu, proportionnellement à sa rareté et à son niveau d'entraînement
// PROPRE à l'emplacement (illimité). Le Dojo lui-même a un niveau (dérivé de
// l'essence gagnée à vie) qui fait évoluer son décor et son bonus global.

const START_SLOTS = 3; // emplacements gratuits dès le départ
const MAX_SLOTS = 10; // emplacements max, débloqués un par un contre de l'essence

// Production d'essence par seconde, par carte assignée, à ★1 et avant
// multiplicateur global (amélioration « Discipline »).
// ×6 par rapport au calibrage d'origine (0.05/0.2/0.8/3/12) : à l'ancien taux,
// juste passer du niveau 1 au niveau 2 du Dojo (100 XP) avec 3 communs de
// départ prenait ~11 min AVANT même le premier achat — le début de partie se
// sentait à l'arrêt. Voir aussi CHAR_LEVEL_BONUS plus bas, relevé de concert.
const RARITY_RATE = {
  common: 0.3,
  rare: 1.3,
  epic: 5,
  legendary: 18,
  mythic: 65,
};

// Niveau d'entraînement DE LA CARTE assignée (pas du compte) : illimité, remis
// à 1 quand on change de personnage sur l'emplacement (cf. IdleSlot.level).
// C'est le principal puits d'essence à long terme — ★ et Discipline plafonnent,
// pas ça : le coût croît plus vite que le gain, donc la progression ralentit
// sans jamais s'arrêter (courbe idle classique).
// +12% (au lieu de +5%) : à l'ancien taux, niveauter un perso commun changeait
// à peine son rendement (0.05/s de base) — des dizaines de niveaux pour un
// effet perceptible. Le coût (CHAR_LEVEL_GROWTH) ne change pas : la courbe
// ralentit toujours autant à long terme, seul le gain immédiat est plus net.
const CHAR_LEVEL_BONUS = 0.12;
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
function slotRate(rarity, charLevel) {
  return (RARITY_RATE[rarity] || 0) * charLevelMultiplier(charLevel);
}

// ── Recrutement : la SEULE façon d'obtenir un personnage dans le Dojo, contre
// de l'essence — jamais via le gacha. Pondération par rareté propre au Dojo
// (indépendante de gacha/rarity.js, pour pouvoir l'équilibrer séparément).
const RECRUIT_WEIGHTS = [
  ['rare', 70],
  ['epic', 20],
  ['legendary', 8],
  ['mythic', 2],
];
const RECRUIT_TOTAL_WEIGHT = RECRUIT_WEIGHTS.reduce((s, [, w]) => s + w, 0);
// `luckBonus` (0-0.9, cf. Ancient « Œil du Recruteur ») déplace une fraction
// du poids du commun vers les autres raretés, proportionnellement à leur
// poids respectif — la somme totale des poids ne bouge pas.
function rollRecruitRarity(luckBonus) {
  const bonus = Math.max(0, Math.min(0.9, luckBonus || 0));
  const rareWeight = RECRUIT_WEIGHTS[0][1];
  const shift = rareWeight * bonus;
  const higherTotal = RECRUIT_TOTAL_WEIGHT - rareWeight;
  let r = Math.random() * RECRUIT_TOTAL_WEIGHT;
  for (const [rarity, w] of RECRUIT_WEIGHTS) {
    const adjusted = rarity === 'rare' ? w - shift : w + shift * (w / higherTotal);
    if (r < adjusted) return rarity;
    r -= adjusted;
  }
  return 'rare';
}
const RECRUIT_BASE_COST = 10;
const RECRUIT_GROWTH = 1.1;
// `count` = nombre de personnages déjà recrutés par le joueur. `discountBonus`
// (0-0.6, cf. Ancient « Marché Facile ») réduit le coût multiplicativement —
// plancher à 1 essence, jamais gratuit.
function recruitCost(count, discountBonus) {
  const discount = Math.max(0, Math.min(0.6, discountBonus || 0));
  const base = RECRUIT_BASE_COST * Math.pow(RECRUIT_GROWTH, Math.max(0, count || 0));
  return Math.max(1, Math.round(base * (1 - discount)));
}

// Amélioration « Discipline » : multiplicateur de production globale.
// `ancientBonus` (cf. Ancient « Discipline Éternelle ») s'applique par-dessus,
// multiplicativement.
const PROD_LEVEL_BONUS = 0.08; // +8% par niveau
const PROD_LEVEL_MAX = 40;
function prodMultiplier(level, ancientBonus) {
  const base = 1 + Math.min(level, PROD_LEVEL_MAX) * PROD_LEVEL_BONUS;
  return base * (1 + Math.max(0, ancientBonus || 0));
}
function prodUpgradeCost(level) {
  return Math.round(50 * Math.pow(1.6, level));
}

// Amélioration « Concentration » : puissance du clic manuel. `ancientBonus`
// (cf. Ancient « Poigne du Maître ») s'applique par-dessus, multiplicativement.
const CLICK_BASE = 1;
const CLICK_LEVEL_BONUS = 1;
const CLICK_LEVEL_MAX = 30;
function clickYield(level, ancientBonus) {
  const base = CLICK_BASE + Math.min(level, CLICK_LEVEL_MAX) * CLICK_LEVEL_BONUS;
  return Math.round(base * (1 + Math.max(0, ancientBonus || 0)));
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

// Essence en attente depuis `lastCollectAt`, plafonnée à `capMs` (défaut
// OFFLINE_CAP_MS ; cf. Ancient « Bourse Profonde » pour l'étendre), pour un
// taux de production total `totalRate` (essence/s).
function pendingEssence(lastCollectAt, totalRate, now = new Date(), capMs = OFFLINE_CAP_MS) {
  if (!lastCollectAt || totalRate <= 0) return 0;
  const elapsedMs = Math.min(capMs, Math.max(0, now.getTime() - new Date(lastCollectAt).getTime()));
  return (elapsedMs / 1000) * totalRate;
}

// ── Niveau du DOJO (le lieu, pas une carte) ──
// Dérivé de l'essence gagnée à VIE (User.essenceEarnedTotal, jamais décrémentée)
// via une suite géométrique — formule fermée, donc O(1) même à très haut niveau
// (pas de boucle : la progression est volontairement quasi infinie).
// 70 (au lieu de 100) : réduit UNIFORMÉMENT tous les paliers (la formule est
// linéaire en DOJO_XP_BASE), pour une première poussée de niveaux plus rapide
// sans changer la forme de la courbe (toujours +35%/niveau au-delà).
const DOJO_XP_BASE = 70; // XP (= essence gagnée) pour passer du niveau 1 au niveau 2
const DOJO_XP_GROWTH = 1.35; // +35% de coût par niveau

// Formule fermée générique (suite géométrique) — XP cumulé requis pour
// atteindre `level` à partir d'un coût de base et d'une croissance par
// niveau. O(1), pas de boucle : réutilisée pour le niveau du Dojo (lent,
// prestigieux) ET le stage de combat (rapide, voir plus bas) — même
// mathématique, juste deux jeux de constantes très différents.
function xpForLevel(base, growth, level) {
  if (level <= 1) return 0;
  return Math.round((base * (Math.pow(growth, level - 1) - 1)) / (growth - 1));
}
function levelForXp(base, growth, xp) {
  if (!xp || xp <= 0) return 1;
  const raw = 1 + Math.log(1 + (xp * (growth - 1)) / base) / Math.log(growth);
  let level = Math.max(1, Math.floor(raw + 1e-9));
  // log/exp ne sont pas exacts : petite correction pour rester cohérent avec
  // xpForLevel (la source de vérité), qui dérive sinon d'un niveau près des
  // seuils. Converge en 0-1 itération dans l'immense majorité des cas.
  while (xpForLevel(base, growth, level + 1) <= xp) level++;
  while (level > 1 && xpForLevel(base, growth, level) > xp) level--;
  return level;
}
function dojoXpForLevel(level) { return xpForLevel(DOJO_XP_BASE, DOJO_XP_GROWTH, level); }
function dojoLevelForXp(xp) { return levelForXp(DOJO_XP_BASE, DOJO_XP_GROWTH, xp); }

// Bonus de production globale offert par le niveau du Dojo (cumulable avec Discipline).
const DOJO_LEVEL_BONUS = 0.01; // +1% par niveau de Dojo
function dojoLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * DOJO_LEVEL_BONUS;
}

// ── Stage de combat (vague) — décorrélé du niveau du Dojo : c'est LUI qui
// pilote la scène (zone/vague/boss/PV, cf. public/idle.js#renderIdleBattle).
// Le niveau du Dojo reste volontairement lent (décor, paliers, Prestige) ;
// le stage doit au contraire s'incrémenter en quelques secondes dès le début
// de partie pour que le combat se sente vivant en continu, façon Clicker
// Heroes — même suite géométrique que le Dojo, courbe bien plus douce
// (+5%/stage contre +35%/niveau de Dojo).
const STAGE_XP_BASE = 6;
const STAGE_XP_GROWTH = 1.05;
function stageXpForLevel(stage) { return xpForLevel(STAGE_XP_BASE, STAGE_XP_GROWTH, stage); }
function stageForXp(xp) { return levelForXp(STAGE_XP_BASE, STAGE_XP_GROWTH, xp); }

// Décor du Dojo : change d'apparence par palier de niveau (voir public/idle.js).
// La liste boucle visuellement au-delà du dernier palier (même thème, le
// joueur reste dans le décor le plus prestigieux — pas de plafond de contenu
// pour autant, le niveau continue de grimper).
const DOJO_DECOR = [
  { level: 1, name: 'Konoha · Village caché', theme: 'wood', flavor: "Sous le regard des Hokage, les premiers entraînements commencent au cœur du Village de la Feuille." },
  { level: 10, name: 'Namek · Plaine des trois soleils', theme: 'garden', flavor: "Un monde extraterrestre aux lacs d'émeraude où chaque combat peut faire trembler une planète." },
  { level: 25, name: 'Marineford · Baie gelée', theme: 'temple', flavor: "La forteresse de la Marine domine l'horizon. Une bataille capable de changer une ère se prépare." },
  { level: 50, name: "Château de l'Infini", theme: 'gold', flavor: "Escaliers et salles suspendues défient les lois de l'espace. Aucun chemin ne mène vraiment dehors." },
  { level: 100, name: 'Shiganshina · Dernier rempart', theme: 'celestial', flavor: "Au pied du Mur, la cité retient son souffle avant l'affrontement qui décidera de son avenir." },
  { level: 150, name: 'Hueco Mundo · Las Noches', theme: 'hueco', flavor: "Sous une lune éternelle, le palais blanc domine un désert où errent les âmes dévorées." },
  { level: 250, name: 'U.A. · Festival sportif', theme: 'ua', flavor: "Le plus grand stade des héros attend un combat capable d'inspirer toute une génération." },
  { level: 400, name: 'Shibuya · Nuit des fléaux', theme: 'shibuya', flavor: "Le voile s'est refermé sur le carrefour. Les néons tremblent sous une énergie maudite incontrôlable." },
  { level: 650, name: 'Aincrad · Centième palier', theme: 'aincrad', flavor: "Le château flottant révèle enfin son sommet. Une dernière porte sépare les survivants de la liberté." },
  { level: 1000, name: 'Monde du Néant · Tournoi du Pouvoir', theme: 'void', flavor: "Au-delà des univers, l'arène ultime flotte dans le vide. Il ne peut rester qu'un seul combattant." },
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
// ×6, en phase avec RARITY_RATE : les coûts (recrutement, améliorations,
// niveaux de perso) n'ont pas bougé, donc l'essence en circulation est
// désormais ~6x plus abondante — une récompense de 50 serait devenue
// négligeable face à ces montants.
const MILESTONE_BASE_REWARD = 300;
const MILESTONE_GROWTH = 1.5;
function milestoneTierForLevel(level) {
  return Math.floor((level || 1) / MILESTONE_INTERVAL);
}
function milestoneReward(tier) {
  if (tier <= 0) return 0;
  return Math.round(MILESTONE_BASE_REWARD * Math.pow(MILESTONE_GROWTH, tier - 1));
}

// ── Prestige (« Retraite du Maître ») : remet à zéro la RUN (essence,
// emplacements, niveaux de personnage, Discipline/Concentration). Le niveau
// du Dojo (donc son décor) et les jalons déjà réclamés sont conservés — seule
// la puissance personnelle du joueur repart de zéro, pas le lieu lui-même.
// En échange, crédite de la Sagesse (voir ANCIENTS ci-dessous) — PAS de
// multiplicateur automatique : depuis la refonte, c'est aux Ancients de
// convertir cette Sagesse en puissance, avec de vrais choix à faire.
const PRESTIGE_MIN_DOJO_LEVEL = 10; // en dessous, rien à gagner à prestiger (on perdrait plus qu'on ne gagne)
// Plus le Dojo est haut au moment du Prestige, plus la Sagesse gagnée est
// généreuse — encourage à ne pas prestiger trop tôt, sans jamais rien
// rapporter de nul (toujours au moins 1 point).
function wisdomForPrestige(dojoLevel) {
  return Math.max(1, Math.floor((dojoLevel || 1) / 5));
}

// ── Ancients : arbre de Prestige PERMANENT (jamais reset, y compris par un
// nouveau Prestige), payé en Sagesse. Chaque effet se branche en paramètre
// OPTIONNEL sur une fonction pure déjà existante (`prodMultiplier`,
// `clickYield`, `pendingEssence`, `rollRecruitRarity`, `recruitCost`) — pas
// de nouvelle couche de calcul, juste un bonus de plus par-dessus.
const ANCIENT_BASE_COST = 1;
const ANCIENT_COST_GROWTH = 1.3; // pas de plafond : puits de Sagesse à très long terme
function ancientCost(level) {
  return Math.round(ANCIENT_BASE_COST * Math.pow(ANCIENT_COST_GROWTH, Math.max(0, level || 0)));
}
const ANCIENTS = [
  { key: 'discipline_eternelle', name: 'Discipline Éternelle', icon: 'fa-infinity', kind: 'prodMult', effectPerLevel: 0.02 },
  { key: 'poigne_maitre', name: 'Poigne du Maître', icon: 'fa-hand-back-fist', kind: 'clickMult', effectPerLevel: 0.03 },
  { key: 'bourse_profonde', name: 'Bourse Profonde', icon: 'fa-vault', kind: 'offlineCapMs', effectPerLevel: 20 * 60 * 1000 },
  { key: 'oeil_recruteur', name: 'Œil du Recruteur', icon: 'fa-eye', kind: 'recruitLuck', effectPerLevel: 0.015 },
  { key: 'marche_facile', name: 'Marché Facile', icon: 'fa-hand-holding-dollar', kind: 'recruitDiscount', effectPerLevel: 0.015 },
];
function ancientByKey(key) {
  return ANCIENTS.find((a) => a.key === key) || null;
}
// Bonus cumulé de tous les Ancients d'un `kind` donné, à partir d'une Map
// clé→niveau (niveaux ABSENTS de la map = pas encore achetés = 0, pas 1).
function ancientBonus(levelsByKey, kind) {
  return ANCIENTS
    .filter((a) => a.kind === kind)
    .reduce((sum, a) => sum + a.effectPerLevel * Math.max(0, levelsByKey.get(a.key) || 0), 0);
}

module.exports = {
  START_SLOTS,
  MAX_SLOTS,
  RARITY_RATE,
  slotRate,
  RECRUIT_WEIGHTS,
  RECRUIT_TOTAL_WEIGHT,
  rollRecruitRarity,
  RECRUIT_BASE_COST,
  RECRUIT_GROWTH,
  recruitCost,
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
  STAGE_XP_BASE,
  STAGE_XP_GROWTH,
  stageXpForLevel,
  stageForXp,
  DOJO_DECOR,
  decorForLevel,
  MILESTONE_INTERVAL,
  MILESTONE_BASE_REWARD,
  MILESTONE_GROWTH,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  wisdomForPrestige,
  ANCIENT_BASE_COST,
  ANCIENT_COST_GROWTH,
  ancientCost,
  ANCIENTS,
  ancientByKey,
  ancientBonus,
};
