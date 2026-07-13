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
const IDLE_NUMBER_CAP = 1e300;
function finiteIdleNumber(value, minimum = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return IDLE_NUMBER_CAP;
  return Math.max(minimum, Math.min(IDLE_NUMBER_CAP, n));
}

// Production d'essence par seconde, par carte assignée, à ★1 et avant
// multiplicateur global (amélioration « Discipline »).
// ×6 par rapport au calibrage d'origine (0.05/0.2/0.8/3/12) : à l'ancien taux,
// juste passer du niveau 1 au niveau 2 du Dojo (100 XP) avec 3 communs de
// départ prenait ~11 min AVANT même le premier achat — le début de partie se
// sentait à l'arrêt. Voir aussi CHAR_LEVEL_BONUS plus bas, relevé de concert.
const RARITY_RATE = {
  common: 0.3,
  rare: 1,
  epic: 1.8,
  legendary: 3.2,
  mythic: 5.5,
};

// Niveau d'entraînement DE LA CARTE assignée (pas du compte) : illimité, remis
// à 1 quand on change de personnage sur l'emplacement (cf. IdleSlot.level).
// C'est le principal puits d'essence à long terme — ★ et Discipline plafonnent,
// pas ça : le coût croît plus vite que le gain, donc la progression ralentit
// sans jamais s'arrêter (courbe idle classique).
// Le gain reste perceptible à chaque achat, mais la base et la croissance du
// coût empêchent désormais d'enchaîner des dizaines de niveaux sans choix.
const CHAR_LEVEL_BONUS = 0.12;
const RARITY_LEVEL_BONUS = { common: .03, rare: .04, epic: .055, legendary: .07, mythic: .085 };
const RARITY_PASSIVE = {
  common: 'Apprenti · progression économique', rare: 'Endurance · +5% de production personnelle au niveau 10',
  epic: 'Aura · +3% de production à toute l’équipe au niveau 10', legendary: 'Domination · +8% de production à toute l’équipe au niveau 10',
  mythic: 'Transcendance · +15% de production à toute l’équipe au niveau 10',
};
const HERO_MILESTONES = [10, 25, 50, 100, 250, 500];
function charLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * CHAR_LEVEL_BONUS;
}
const CHAR_LEVEL_BASE_COST = { common: 8, rare: 20, epic: 45, legendary: 110, mythic: 280 };
const CHAR_LEVEL_GROWTH = 1.13;
function charLevelUpCost(rarity, level) {
  const base = CHAR_LEVEL_BASE_COST[rarity] || CHAR_LEVEL_BASE_COST.common;
  return Math.round(finiteIdleNumber(base * Math.pow(CHAR_LEVEL_GROWTH, Math.max(1, level || 1) - 1), 1));
}
function charLevelBulkCost(rarity, level, amount) {
  const count = Math.max(1, Math.min(1000, Math.floor(amount || 1)));
  let total = 0; for (let i = 0; i < count; i++) total += charLevelUpCost(rarity, (level || 1) + i);
  return finiteIdleNumber(total, 1);
}

// Taux de production d'un emplacement (essence/s), avant multiplicateurs
// globaux (Discipline + niveau du Dojo).
function slotRate(rarity, charLevel) {
  const scaling = RARITY_LEVEL_BONUS[rarity] || CHAR_LEVEL_BONUS;
  const endurance = rarity === 'rare' && charLevel >= 10 ? 1.05 : 1;
  const level = Math.max(1, charLevel || 1);
  const reached = HERO_MILESTONES.filter((target) => target <= level).length;
  // Multiplicateurs de palier façon Clicker Heroes : ils créent des pics
  // d'objectif lisibles et permettent au DPS de suivre les PV exponentiels.
  const milestoneMultiplier = Math.pow(4, reached);
  return finiteIdleNumber((RARITY_RATE[rarity] || 0) * Math.pow(1 + scaling, level - 1) * milestoneMultiplier * endurance);
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
const RECRUIT_BASE_COST = 1;
const RECRUIT_GROWTH = 1;
// `count` = nombre de personnages déjà recrutés par le joueur. `discountBonus`
// (0-0.6, cf. Ancient « Marché Facile ») réduit le coût multiplicativement —
// plancher à 1 essence, jamais gratuit.
function recruitCost(count, discountBonus) {
  const discount = Math.max(0, Math.min(0.6, discountBonus || 0));
  const base = Math.min(12, RECRUIT_BASE_COST + Math.floor(Math.max(0, (count || 0) - 1) / 2));
  return Math.max(1, Math.round(finiteIdleNumber(base * (1 - discount), 1)));
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
  return Math.round(finiteIdleNumber(75 * Math.pow(1.75, level), 1));
}

// Amélioration « Concentration » : puissance du clic manuel. `ancientBonus`
// (cf. Ancient « Poigne du Maître ») s'applique par-dessus, multiplicativement.
const CLICK_BASE = 5;
const CLICK_LEVEL_BONUS = 4;
const CLICK_LEVEL_MAX = 30;
function clickYield(level, ancientBonus) {
  const base = CLICK_BASE + Math.min(level, CLICK_LEVEL_MAX) * CLICK_LEVEL_BONUS;
  return Math.round(base * (1 + Math.max(0, ancientBonus || 0)));
}
function clickUpgradeCost(level) {
  return Math.round(finiteIdleNumber(60 * Math.pow(1.7, level), 1));
}
const CLICK_COOLDOWN_MS = 100; // 10 clics/s : cadence clicker, sans flood réseau

// Coût pour débloquer l'emplacement d'index `nextSlotIndex` (START_SLOTS..MAX_SLOTS-1).
function slotUpgradeCost(nextSlotIndex) {
  return Math.round(finiteIdleNumber(400 * Math.pow(2.25, nextSlotIndex - START_SLOTS), 1));
}

// Plafond de production hors-ligne : au-delà, le surplus n'est plus compté —
// encourage à revenir régulièrement sans punir une grosse pause.
const OFFLINE_CAP_MS = 12 * 60 * 60 * 1000; // 12h

// Combat de run : contrairement à l'ancien affichage, un stage possède
// maintenant de vrais PV. L'équipe inflige son taux de production sous forme
// de DPS et chaque ennemi vaincu verse de l'Essence. Les boss, tous les dix
// stages, doivent tomber en 30 secondes ; sinon la simulation revient sur le
// dernier stage normal afin qu'une absence ne bloque jamais le joueur.
const ENEMY_HP_BASE = 20;
const ENEMY_HP_GROWTH = 1.13;
const BOSS_INTERVAL = 10;
const BOSS_HP_MULTIPLIER = 9;
const ELITE_WAVE = 5;
const ELITE_HP_MULTIPLIER = 3;
const BOSS_TIMER_SECONDS = 30;
const ENEMY_REWARD_BASE = 2;
// La récompense augmente moins vite que les PV : progresser exige désormais
// des investissements au lieu de devenir automatiquement plus facile.
const ENEMY_REWARD_GROWTH = 1.08;
function isBossStage(stage) {
  return Math.max(1, Math.floor(stage || 1)) % BOSS_INTERVAL === 0;
}
function isEliteStage(stage) {
  return ((Math.max(1, Math.floor(stage || 1)) - 1) % BOSS_INTERVAL) + 1 === ELITE_WAVE;
}
function enemyMaxHp(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  const special = isBossStage(s) ? BOSS_HP_MULTIPLIER : isEliteStage(s) ? ELITE_HP_MULTIPLIER : 1;
  return finiteIdleNumber(ENEMY_HP_BASE * Math.pow(ENEMY_HP_GROWTH, s - 1) * special, 1);
}
function enemyReward(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  const special = isBossStage(s) ? 3 : isEliteStage(s) ? 1.5 : 1;
  return Math.max(1, Math.round(finiteIdleNumber(ENEMY_REWARD_BASE * Math.pow(ENEMY_REWARD_GROWTH, s - 1) * special, 1)));
}
function simulateCombat({ stage = 1, hp = 0, dps = 0, elapsedSeconds = 0, mode = 'progress', maxKills = 10000 } = {}) {
  let currentStage = Math.max(1, Math.floor(stage || 1));
  let currentHp = Number(hp);
  let seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const damagePerSecond = Math.max(0, Number(dps) || 0);
  let essence = 0;
  let kills = 0;
  let bossFailed = false;
  let farming = mode === 'farm';
  const maxHp = () => enemyMaxHp(currentStage);
  if (!Number.isFinite(currentHp) || currentHp <= 0 || currentHp > maxHp()) currentHp = maxHp();
  if (!damagePerSecond || !seconds) return { stage: currentStage, hp: currentHp, essence, kills, bossFailed, elapsedSeconds: 0 };

  while (seconds > 0 && kills < maxKills) {
    const timeToKill = currentHp / damagePerSecond;
    if (isBossStage(currentStage) && timeToKill > BOSS_TIMER_SECONDS) {
      bossFailed = true;
      currentStage = Math.max(1, currentStage - 1);
      currentHp = enemyMaxHp(currentStage);
      farming = true;
      continue;
    }
    // Une fois en farm, tous les ennemis ont les mêmes PV : calcul fermé
    // plutôt qu'une boucle par kill, indispensable pour plusieurs heures
    // hors-ligne à haut niveau.
    if (farming && currentHp === enemyMaxHp(currentStage)) {
      const cycle = currentHp / damagePerSecond;
      const bulk = Math.floor(seconds / cycle);
      if (bulk > 0) {
        essence = finiteIdleNumber(essence + bulk * enemyReward(currentStage));
        kills += bulk;
        seconds -= bulk * cycle;
      }
    }
    if (timeToKill > seconds) {
      currentHp -= damagePerSecond * seconds;
      seconds = 0;
      break;
    }
    seconds -= timeToKill;
    essence = finiteIdleNumber(essence + enemyReward(currentStage));
    kills++;
    if (!farming) currentStage++;
    currentHp = enemyMaxHp(currentStage);
  }
  return {
    stage: currentStage,
    hp: currentHp,
    essence,
    kills,
    bossFailed,
    elapsedSeconds: Math.max(0, (Number(elapsedSeconds) || 0) - seconds),
  };
}

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
// Le premier niveau reste accessible, puis chaque palier demande un
// investissement sensiblement plus long que le précédent.
const DOJO_XP_BASE = 100; // XP (= essence gagnée) pour passer du niveau 1 au niveau 2
const DOJO_XP_GROWTH = 1.40; // +40% de coût par niveau

// Formule fermée générique (suite géométrique) — XP cumulé requis pour
// atteindre `level` à partir d'un coût de base et d'une croissance par
// niveau. O(1), pas de boucle : réutilisée pour le niveau du Dojo (lent,
// prestigieux) ET le stage de combat (rapide, voir plus bas) — même
// mathématique, juste deux jeux de constantes très différents.
function xpForLevel(base, growth, level) {
  if (level <= 1) return 0;
  return Math.round(finiteIdleNumber((base * (Math.pow(growth, level - 1) - 1)) / (growth - 1)));
}
function levelForXp(base, growth, xp) {
  if (!xp || xp <= 0) return 1;
  const boundedXp = finiteIdleNumber(xp);
  const raw = 1 + Math.log(1 + (boundedXp * (growth - 1)) / base) / Math.log(growth);
  let level = Math.max(1, Math.floor(raw + 1e-9));
  if (boundedXp >= IDLE_NUMBER_CAP) return level;
  // log/exp ne sont pas exacts : petite correction pour rester cohérent avec
  // xpForLevel (la source de vérité), qui dérive sinon d'un niveau près des
  // seuils. Converge en 0-1 itération dans l'immense majorité des cas.
  while (xpForLevel(base, growth, level + 1) <= boundedXp) level++;
  while (level > 1 && xpForLevel(base, growth, level) > boundedXp) level--;
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
const CAMPAIGN_ENEMIES = [
  ['Ninja déserteur','Marionnette de guerre','Bête scellée','Jônin corrompu'],
  ['Soldat galactique','Bio-guerrier','Mercenaire spatial','Créature de Namek'],
  ['Pirate renégat','Pacifista endommagé','Officier de la Marine','Géant des mers'],
  ['Démon des couloirs','Lame de sang','Gardien lunaire','Ombre supérieure'],
  ['Titan errant','Soldat renégat','Titan cuirassé','Éclaireur ennemi'],
  ['Hollow affamé','Arrancar rebelle','Gardien de Las Noches','Menos ancien'],
  ['Vilain déchaîné','Nomu expérimental','Rival masqué','Robot de combat'],
  ['Fléau mineur','Utilisateur maudit','Esprit vengeur','Gardien du voile'],
  ['Monstre du palier','Chevalier rouge','Bête numérique','Joueur corrompu'],
  ['Guerrier du Néant','Combattant divin','Destructeur cosmique','Ange déchu'],
];
const WORLD_MODIFIERS = [
  { key:'training', name:'Terrain d’entraînement', description:'Dégâts de frappe normaux.', click:1 },
  { key:'gravity', name:'Gravité renforcée', description:'Frappes −20%, Ultimes conseillés.', click:.8 },
  { key:'freedom', name:'Vent de liberté', description:'Frappes +20%.', click:1.2 },
  { key:'demons', name:'Nuit démoniaque', description:'Frappes −10%, critiques renforcés.', click:.9, critBonus:.08 },
  { key:'siege', name:'Champ de siège', description:'Frappes −15%, exécution sous 30% PV.', click:.85, executeAt:.3 },
  { key:'spirit', name:'Pression spirituelle', description:'Frappes +10%.', click:1.1 },
  { key:'academy', name:'Exercice tactique', description:'Combo d’équipe +25%.', click:1, team:1.25 },
  { key:'curse', name:'Zone maudite', description:'Frappes −25%, Ultime +40%.', click:.75, burst:1.4 },
  { key:'virtual', name:'Accélération virtuelle', description:'Frappes +30%.', click:1.3 },
  { key:'void', name:'Instabilité du vide', description:'Frappes et Combo +15%.', click:1.15, team:1.15 },
];
function campaignForStage(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  const worldIndex = Math.floor((s - 1) / BOSS_INTERVAL) % DOJO_DECOR.length;
  const act = Math.floor((s - 1) / (BOSS_INTERVAL * DOJO_DECOR.length)) + 1;
  const wave = ((s - 1) % BOSS_INTERVAL) + 1;
  const world = DOJO_DECOR[worldIndex];
  const enemyPool = CAMPAIGN_ENEMIES[worldIndex];
  const modifier = WORLD_MODIFIERS[worldIndex];
  return {
    index: worldIndex + 1, act, wave, startStage: s - wave + 1, endStage: s - wave + BOSS_INTERVAL,
    name: world.name, theme: world.theme, flavor: world.flavor,
    enemyName: isBossStage(s) ? `Boss de ${world.name.split(' · ')[0]}` : isEliteStage(s) ? `Élite · ${enemyPool[(act + worldIndex) % enemyPool.length]}` : enemyPool[(wave - 1) % enemyPool.length],
    modifier,
  };
}
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
// Récompense volontairement inférieure au prix de plusieurs améliorations :
// un coffre accélère un objectif sans supprimer la phase d'accumulation.
const MILESTONE_BASE_REWARD = 150;
const MILESTONE_GROWTH = 1.45;
function milestoneTierForLevel(level) {
  return Math.floor((level || 1) / MILESTONE_INTERVAL);
}
function milestoneReward(tier) {
  if (tier <= 0) return 0;
  return Math.round(finiteIdleNumber(MILESTONE_BASE_REWARD * Math.pow(MILESTONE_GROWTH, tier - 1)));
}

// ── Prestige (« Retraite du Maître ») : remet à zéro la RUN (essence,
// emplacements, niveaux de personnage, Discipline/Concentration). Le niveau
// du Dojo (donc son décor) et les jalons déjà réclamés sont conservés — seule
// la puissance personnelle du joueur repart de zéro, pas le lieu lui-même.
// En échange, crédite de la Sagesse (voir ANCIENTS ci-dessous) — PAS de
// multiplicateur automatique : depuis la refonte, c'est aux Ancients de
// convertir cette Sagesse en puissance, avec de vrais choix à faire.
const PRESTIGE_MIN_DOJO_LEVEL = 10; // conservé pour compatibilité d'affichage historique
const PRESTIGE_MIN_STAGE = 100;
// Plus le Dojo est haut au moment du Prestige, plus la Sagesse gagnée est
// généreuse — encourage à ne pas prestiger trop tôt, sans jamais rien
// rapporter de nul (toujours au moins 1 point).
function wisdomForPrestige(dojoLevel) {
  return Math.max(1, Math.floor((dojoLevel || 1) / 5));
}
function wisdomForRunStage(stage) {
  const s = Math.max(0, Number(stage) || 0);
  if (s < PRESTIGE_MIN_STAGE) return 0;
  return Math.max(1, Math.floor(5 * Math.pow(s / PRESTIGE_MIN_STAGE, 1.5)));
}

// ── Ancients : arbre de Prestige PERMANENT (jamais reset, y compris par un
// nouveau Prestige), payé en Sagesse. Chaque effet se branche en paramètre
// OPTIONNEL sur une fonction pure déjà existante (`prodMultiplier`,
// `clickYield`, `pendingEssence`, `rollRecruitRarity`, `recruitCost`) — pas
// de nouvelle couche de calcul, juste un bonus de plus par-dessus.
const ANCIENT_BASE_COST = 2;
const ANCIENT_COST_GROWTH = 1.3; // pas de plafond : puits de Sagesse à très long terme
function ancientCost(level) {
  return Math.round(finiteIdleNumber(ANCIENT_BASE_COST * Math.pow(ANCIENT_COST_GROWTH, Math.max(0, level || 0)), 1));
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
  IDLE_NUMBER_CAP,
  finiteIdleNumber,
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
  ENEMY_HP_BASE,
  ENEMY_HP_GROWTH,
  BOSS_INTERVAL,
  BOSS_HP_MULTIPLIER,
  ELITE_WAVE,
  ELITE_HP_MULTIPLIER,
  BOSS_TIMER_SECONDS,
  ENEMY_REWARD_BASE,
  ENEMY_REWARD_GROWTH,
  isBossStage,
  isEliteStage,
  enemyMaxHp,
  enemyReward,
  simulateCombat,
  CHAR_LEVEL_BONUS,
  charLevelMultiplier,
  CHAR_LEVEL_BASE_COST,
  CHAR_LEVEL_GROWTH,
  charLevelUpCost,
  charLevelBulkCost,
  RARITY_LEVEL_BONUS,
  RARITY_PASSIVE,
  HERO_MILESTONES,
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
  CAMPAIGN_ENEMIES,
  WORLD_MODIFIERS,
  campaignForStage,
  decorForLevel,
  MILESTONE_INTERVAL,
  MILESTONE_BASE_REWARD,
  MILESTONE_GROWTH,
  milestoneTierForLevel,
  milestoneReward,
  PRESTIGE_MIN_DOJO_LEVEL,
  PRESTIGE_MIN_STAGE,
  wisdomForPrestige,
  wisdomForRunStage,
  ANCIENT_BASE_COST,
  ANCIENT_COST_GROWTH,
  ancientCost,
  ANCIENTS,
  ancientByKey,
  ancientBonus,
};
