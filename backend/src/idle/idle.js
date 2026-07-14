// Dojo (idle/clicker) — configuration et calculs purs (pas d'accès DB ici).
// Jeu à PART ENTIÈRE, indépendant de la collection gacha : les personnages du
// roster sont RECRUTÉS avec des Sceaux ou de l'Essence, pas tirés au gacha —
// seule la table Character (nom/portrait/rareté) est partagée comme référentiel
// de contenu ; UserCard/CardInstance restent indépendants. Un personnage assigné à un emplacement produit de l'essence en
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
  epic: 1.12,
  legendary: 1.28,
  mythic: 1.45,
};

// Niveau d'entraînement DE LA CARTE assignée (pas du compte) : illimité, remis
// à 1 quand on change de personnage sur l'emplacement (cf. IdleSlot.level).
// C'est le principal puits d'essence à long terme — ★ et Discipline plafonnent,
// pas ça : le coût croît plus vite que le gain, donc la progression ralentit
// sans jamais s'arrêter (courbe idle classique).
// Le gain reste perceptible à chaque achat, mais la base et la croissance du
// coût empêchent désormais d'enchaîner des dizaines de niveaux sans choix.
const CHAR_LEVEL_BONUS = 0.12;
// La rareté apporte un avantage initial contenu, mais ne creuse plus un
// gouffre exponentiel à chaque niveau. Ainsi, rôles, talents, synergies et
// personnages favoris restent des choix viables jusqu'en fin de run.
const RARITY_LEVEL_BONUS = { common: .03, rare: .05, epic: .05, legendary: .05, mythic: .05 };
const RARITY_PASSIVE = {
  common: 'Apprenti · progression économique', rare: 'Endurance · +5% de production personnelle au niveau 10',
  epic: 'Aura · +2% de production à toute l’équipe au niveau 10', legendary: 'Domination · +4% de production à toute l’équipe au niveau 10',
  mythic: 'Transcendance · +6% de production à toute l’équipe au niveau 10',
};
const HERO_MILESTONES = [10, 25, 50, 100, 250, 500];
const HERO_ASCENSION_LEVEL = 100;
function charLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * CHAR_LEVEL_BONUS;
}
const CHAR_LEVEL_BASE_COST = { common: 12, rare: 28, epic: 34, legendary: 42, mythic: 52 };
const CHAR_LEVEL_GROWTH = 1.16;
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
  // Les paliers restent de vrais objectifs, sans quadrupler brutalement le
  // rendement d'un achat unique ni court-circuiter l'économie de la run.
  const milestoneMultiplier = Math.pow(2, reached);
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
// Un Sceau est un ticket : son pouvoir d'achat ne diminue jamais avec le roster.
function recruitCost() {
  return RECRUIT_BASE_COST;
}

// Alternative en Essence. Le compteur représente UNIQUEMENT les invocations
// payées en Essence : utiliser un Sceau ne renchérit jamais ce prix.
// La croissance reste progressive mais abordable pour un joueur en montée.
function recruitEssenceCost(essenceRecruitCount, discountBonus) {
  const discount = Math.max(0, Math.min(0.6, discountBonus || 0));
  const base = Math.min(5000000, Math.round(1500 * Math.pow(1.18, Math.max(0, essenceRecruitCount || 0))));
  return Math.max(600, Math.round(finiteIdleNumber(base * (1 - discount), 1500)));
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
  const earlyDiscount=[.35,.45,.60,.75,.90][Math.max(0,level)]??1;
  return Math.round(finiteIdleNumber(75 * Math.pow(1.75, level)*earlyDiscount, 1));
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
  const earlyDiscount=[.35,.45,.60,.75,.90][Math.max(0,level)]??1;
  return Math.round(finiteIdleNumber(60 * Math.pow(1.7, level)*earlyDiscount, 1));
}

// Amélioration « Instinct » : +1 point de chance critique par niveau.
// Elle reste une amélioration de run et repart donc à zéro au Prestige.
const CRIT_LEVEL_BONUS = 0.01;
const CRIT_LEVEL_MAX = 25;
function critUpgradeBonus(level) {
  return Math.min(Math.max(0, level || 0), CRIT_LEVEL_MAX) * CRIT_LEVEL_BONUS;
}
function critUpgradeCost(level) {
  const earlyDiscount=[.4,.5,.65,.8,.9][Math.max(0,level)]??1;
  return Math.round(finiteIdleNumber(100 * Math.pow(1.78, level) * earlyDiscount, 1));
}

// Amélioration « Flux » : −2% sur les recharges de l'Ultime et du Combo par
// niveau. Les Supports s'additionnent à ce bonus côté routes, avec un plafond
// commun de −70% pour que les compétences ne deviennent jamais permanentes.
const COOLDOWN_LEVEL_BONUS = 0.02;
const COOLDOWN_LEVEL_MAX = 20;
function cooldownUpgradeBonus(level) {
  return Math.min(Math.max(0, level || 0), COOLDOWN_LEVEL_MAX) * COOLDOWN_LEVEL_BONUS;
}
function cooldownUpgradeCost(level) {
  const earlyDiscount=[.4,.5,.65,.8,.9][Math.max(0,level)]??1;
  return Math.round(finiteIdleNumber(125 * Math.pow(1.82, level) * earlyDiscount, 1));
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
// La récompense de base suit les PV afin qu'un monde avancé ne soit jamais
// moins rentable à farmer que le début du jeu. La difficulté vient du mur de
// PV à franchir et des coûts qui croissent plus vite, pas d'une incitation à
// retourner farmer indéfiniment le stage 4.
const ENEMY_REWARD_GROWTH = 1.131; // +0,1 pt/stage : les mondes récents gagnent légèrement en rendement
const CAMPAIGN_ACT_LENGTH = 100;
function campaignDifficulty(stage) {
  const act = Math.floor((Math.max(1, Math.floor(stage || 1)) - 1) / CAMPAIGN_ACT_LENGTH) + 1;
  const tiers = [
    { key:'normal', name:'Normal', power:1 },
    { key:'heroic', name:'Héroïque', power:1.35 },
    { key:'nightmare', name:'Cauchemar', power:1.8 },
    { key:'infernal', name:'Infernal', power:2.4 },
    { key:'transcendent', name:'Transcendant', power:3.2 },
  ];
  const tier = tiers[Math.min(act, tiers.length) - 1];
  if (act <= tiers.length) return { ...tier, act, reward:Math.pow(tier.power, .9) };
  return {
    key:'abyssal', name:`Abyssal ${act - tiers.length}`,
    power:Math.min(8, 3.2 + (act - tiers.length) * .45),
    reward:Math.pow(Math.min(8, 3.2 + (act - tiers.length) * .45), .9), act,
  };
}
function isBossStage(stage) {
  return Math.max(1, Math.floor(stage || 1)) % BOSS_INTERVAL === 0;
}
function isEliteStage(stage) {
  return ((Math.max(1, Math.floor(stage || 1)) - 1) % BOSS_INTERVAL) + 1 === ELITE_WAVE;
}
function enemyMaxHp(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  const special = isBossStage(s) ? BOSS_HP_MULTIPLIER : isEliteStage(s) ? ELITE_HP_MULTIPLIER : 1;
  return finiteIdleNumber(ENEMY_HP_BASE * Math.pow(ENEMY_HP_GROWTH, s - 1) * special * campaignDifficulty(s).power, 1);
}
function enemyReward(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  const special = isBossStage(s) ? 3 : isEliteStage(s) ? 1.5 : 1;
  return Math.max(1, Math.round(finiteIdleNumber(ENEMY_REWARD_BASE * Math.pow(ENEMY_REWARD_GROWTH, s - 1) * special * campaignDifficulty(s).reward, 1)));
}
const ENEMY_ARCHETYPES = {
  standard: { key:'standard', name:'Standard', description:'Adversaire équilibré.', hpMultiplier:1, rewardMultiplier:1 },
  swift: { key:'swift', name:'Rapide', description:'Peu de PV, récompense normale.', hpMultiplier:.68, rewardMultiplier:1 },
  armored: { key:'armored', name:'Blindé', description:'Plus résistant, butin amélioré.', hpMultiplier:1.6, rewardMultiplier:1.5 },
  captain: { key:'captain', name:'Capitaine', description:'Dixième ennemi renforcé de la vague.', hpMultiplier:2.25, rewardMultiplier:2.25 },
  boss: { key:'boss', name:'Gardien', description:'Boss du monde.', hpMultiplier:1, rewardMultiplier:1 },
};
function enemyArchetype(stage, waveKills = 0) {
  if (isBossStage(stage)) return ENEMY_ARCHETYPES.boss;
  const number = Math.max(1, Math.min(10, Math.floor(waveKills || 0) + 1));
  if (number === 10) return ENEMY_ARCHETYPES.captain;
  const roll = (Math.max(1, Math.floor(stage || 1)) * 31 + number * 17) % 7;
  return roll === 0 || roll === 3 ? ENEMY_ARCHETYPES.armored : roll === 1 || roll === 5 ? ENEMY_ARCHETYPES.swift : ENEMY_ARCHETYPES.standard;
}
function enemyUnitMaxHp(stage, waveKills = 0) {
  return finiteIdleNumber(enemyMaxHp(stage) * enemyArchetype(stage, waveKills).hpMultiplier, 1);
}
function enemiesRequiredForStage(stage) {
  if (isBossStage(stage)) return 1;
  return 10;
}
// Répare aussi les anciens états où idleWaveKills a pu être enregistré à 10
// entre deux requêtes. Le compteur ne doit jamais être simplement ramené à 9 :
// il représente alors une vague terminée et doit être reporté sur la suivante.
function normalizeWaveProgress(stage, waveKills = 0, mode = 'progress') {
  let currentStage = Math.max(1, Math.floor(stage || 1));
  let currentWaveKills = Math.max(0, Math.floor(Number(waveKills) || 0));
  if (mode === 'farm') return { stage: currentStage, waveKills: currentWaveKills % enemiesRequiredForStage(currentStage) };
  let guard = 0;
  while (currentWaveKills >= enemiesRequiredForStage(currentStage) && guard++ < 1000) {
    currentWaveKills -= enemiesRequiredForStage(currentStage);
    currentStage++;
  }
  return { stage: currentStage, waveKills: Math.min(currentWaveKills, enemiesRequiredForStage(currentStage) - 1) };
}
function enemyUnitReward(stage, waveKills = 0) {
  // Chaque nouvel ennemi remplace un ancien changement de stage : conserver
  // la récompense unitaire maintient le revenu par minute sans fractions
  // perdues lors des synchronisations fréquentes.
  return Math.max(1, Math.round(enemyReward(stage) * enemyArchetype(stage, waveKills).rewardMultiplier));
}
function enemiesDefeatedBeforeStage(stage) {
  const completedStages = Math.max(0, Math.floor(stage || 1) - 1);
  const completeWorlds = Math.floor(completedStages / BOSS_INTERVAL);
  const remainingStages = completedStages % BOSS_INTERVAL;
  return completeWorlds * 91 + remainingStages * 10; // 9 vagues ×10 ennemis + 1 boss.
}
const MIN_ENEMY_SECONDS = .12;
const MIN_BOSS_SECONDS = .5;
const MAX_STAGE_ADVANCE_PER_SYNC = 3;
function simulateCombat({ stage = 1, hp = 0, waveKills = 0, dps = 0, elapsedSeconds = 0, mode = 'progress', maxKills = 10000, maxStageAdvance = Infinity } = {}) {
  const normalized = normalizeWaveProgress(stage, waveKills, mode);
  const startingStage = normalized.stage;
  let currentStage = normalized.stage;
  let currentWaveKills = normalized.waveKills;
  let currentHp = Number(hp);
  let seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const damagePerSecond = Math.max(0, Number(dps) || 0);
  let essence = 0;
  let kills = 0;
  let bossFailed = false;
  const farming = mode === 'farm';
  let progressionCapped = false;
  const maxHp = () => enemyUnitMaxHp(currentStage, currentWaveKills);
  if (!Number.isFinite(currentHp) || currentHp <= 0 || currentHp > maxHp()) currentHp = maxHp();
  if (!damagePerSecond || !seconds) return { stage: currentStage, hp: currentHp, waveKills: currentWaveKills, essence, kills, bossFailed, elapsedSeconds: 0 };

  while (seconds > 0 && kills < maxKills) {
    // Un ennemi doit rester perceptible à l'écran : sans cadence minimale,
    // 1,5 M DPS au stage 1 convertissait l'overkill en ~10 M Essence/minute.
    // Le DPS conserve toute sa valeur sur le contenu adapté, mais ne permet
    // plus de tuer des milliers d'ennemis faibles dans une seule frame.
    const timeToKill = Math.max(currentHp / damagePerSecond, isBossStage(currentStage) ? MIN_BOSS_SECONDS : MIN_ENEMY_SECONDS);
    // Un boss trop long s'enrage, mais ne renvoie jamais silencieusement le
    // joueur à la vague précédente. L'ancien recul recréait la vague 9 à
    // chaque synchronisation et donnait l'impression que son dixième ennemi
    // n'était jamais validé. Le boss reste maintenant attaquable au clic.
    // Une fois en farm, tous les ennemis ont les mêmes PV : calcul fermé
    // plutôt qu'une boucle par kill, indispensable pour plusieurs heures
    // hors-ligne à haut niveau.
    if (farming && !isBossStage(currentStage) && currentWaveKills === 0 && currentHp === maxHp()) {
      const cycleTimes = Array.from({length:10}, (_, index) => Math.max(enemyUnitMaxHp(currentStage, index)/damagePerSecond,MIN_ENEMY_SECONDS));
      const cycleReward = Array.from({length:10}, (_, index) => enemyUnitReward(currentStage, index)).reduce((sum, value) => sum + value, 0);
      const cycleSeconds=cycleTimes.reduce((sum,value)=>sum+value,0);const cycles = Math.min(Math.floor((maxKills-kills)/10), Math.floor(seconds/cycleSeconds));
      if (cycles > 0) { essence=finiteIdleNumber(essence+cycles*cycleReward);kills+=cycles*10;seconds-=cycles*cycleSeconds;if(kills>=maxKills)break; }
    }
    if (timeToKill > seconds) {
      currentHp -= currentHp*(seconds/timeToKill);
      seconds = 0;
      break;
    }
    seconds -= timeToKill;
    essence = finiteIdleNumber(essence + enemyUnitReward(currentStage, currentWaveKills));
    kills++;
    currentWaveKills++;
    if (currentWaveKills >= enemiesRequiredForStage(currentStage)) {
      currentWaveKills = 0;
      if (!farming && !progressionCapped) {
        if(currentStage-startingStage<maxStageAdvance)currentStage++;
        else progressionCapped=true;
      }
    }
    currentHp = enemyUnitMaxHp(currentStage, currentWaveKills);
  }
  return {
    stage: currentStage,
    hp: currentHp,
    waveKills: currentWaveKills,
    essence,
    kills,
    bossFailed,
    progressionCapped,
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

// ── Ancienne courbe du niveau du DOJO ──
// Conservée pour migrer les comptes existants et vérifier les seuils
// historiques. Le rang actif est désormais validé par rankQuestSeries().
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

// Le niveau du joueur n'est plus accordé automatiquement par l'Essence à vie.
// Chaque rang demande une série d'épreuves, remise à zéro après validation.
function rankQuestSeries({ level = 1, kills = 0, clicks = 0, upgrades = 0, bosses = 0 } = {}) {
  const current = Math.max(1, Math.floor(level || 1));
  const nextLevel = current + 1;
  const defs = [
    { key:'kills', icon:'fa-skull', name:'Ennemis vaincus', description:'Élimine des ennemis dans Combat', progress:kills, target:Math.min(5000, 15 + current * 8) },
    { key:'clicks', icon:'fa-hand-fist', name:'Frappes manuelles', description:'Utilise le bouton Attaquer', progress:clicks, target:Math.min(4000, 40 + current * 15) },
    { key:'upgrades', icon:'fa-arrow-trend-up', name:'Améliorations achetées', description:'Dépense de l’Essence dans Améliorer', progress:upgrades, target:Math.min(180, 3 + Math.ceil(current * .6)) },
  ];
  if (nextLevel % 5 === 0) defs.push({ key:'bosses', icon:'fa-crown', name:'Coffre de gardien', description:'Vaincs un boss et ouvre son coffre', progress:bosses, target:1 });
  const quests = defs.map((quest) => ({ ...quest, progress:Math.min(Math.max(0, Math.floor(quest.progress || 0)), quest.target), completed:(quest.progress || 0) >= quest.target }));
  return { level:current, nextLevel, quests, completed:quests.filter((q)=>q.completed).length, total:quests.length, ready:quests.every((q)=>q.completed), sealReward:nextLevel % 5 === 0 ? 2 : 1, powerReward:DOJO_LEVEL_BONUS };
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
  const difficulty = campaignDifficulty(s);
  return {
    index: worldIndex + 1, act, wave, startStage: s - wave + 1, endStage: s - wave + BOSS_INTERVAL,
    name: world.name, theme: world.theme, flavor: world.flavor,
    enemyName: isBossStage(s) ? `Boss de ${world.name.split(' · ')[0]}` : isEliteStage(s) ? `Élite · ${enemyPool[(act + worldIndex) % enemyPool.length]}` : enemyPool[(wave - 1) % enemyPool.length],
    modifier,difficulty,
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
// Stage 100 : choix assumé du créateur (le seuil avait été brièvement abaissé
// à 60) — la Retraite doit rester un accomplissement qui conclut une vraie
// run, pas une formalité. wisdomForRunStage est calée sur ce seuil (5 points
// pile au minimum, superlinéaire au-delà pour récompenser le push).
const PRESTIGE_MIN_STAGE = 100;
const PRESTIGE_STAGE_STEP = 20;
const PRESTIGE_MIN_RUN_BASE_MS = 45*60*1000;
function prestigeMinimumRunMs(prestigeLevel=0){return PRESTIGE_MIN_RUN_BASE_MS+Math.min(45,Math.max(0,Math.floor(prestigeLevel))*3)*60*1000;}
// Le roster, les objets et les Ancients sont permanents : garder un seuil fixe
// rendrait chaque nouvelle retraite plus courte que la précédente. L'objectif
// monte donc de deux mondes complets par Prestige déjà effectué. Tous les
// objectifs restent ainsi des stages de boss (100, 120, 140...) : même type
// de défi pour une récompense comparable.
function prestigeRequiredStage(prestigeLevel) {
  return PRESTIGE_MIN_STAGE + PRESTIGE_STAGE_STEP * Math.max(0, Math.floor(Number(prestigeLevel) || 0));
}
// Plus le Dojo est haut au moment du Prestige, plus la Sagesse gagnée est
// généreuse — encourage à ne pas prestiger trop tôt, sans jamais rien
// rapporter de nul (toujours au moins 1 point).
function wisdomForPrestige(dojoLevel) {
  return Math.max(1, Math.floor((dojoLevel || 1) / 5));
}
function wisdomForRunStage(stage, prestigeLevel = 0) {
  const s = Math.max(0, Number(stage) || 0);
  const required = prestigeRequiredStage(prestigeLevel);
  if (s < required) return 0;
  // Une retraite au seuil paie un seul Ancient de départ (3 Sagesse pour un
  // coût initial de 2), au lieu de financer deux niveaux immédiatement.
  // Dépasser l'objectif reste utile, avec un rendement volontairement doux.
  return Math.max(1, Math.floor(3 * Math.pow(s / required, 1.35)));
}

// Bénédictions temporaires : le joueur façonne un build différent à chaque
// ascension. Chaque pouvoir apporte un avantage net avec un vrai compromis ;
// la liste entière est remise à zéro au Prestige.
const RUN_BLESSINGS = [
  {key:'berserker',name:'Pacte du Berserker',icon:'fa-hand-fist',rarity:'epic',upside:'+25 % DPS d’équipe',downside:'−15 % dégâts de clic',prod:1.25,click:.85},
  {key:'deadeye',name:'Œil du Destin',icon:'fa-crosshairs',rarity:'rare',upside:'+10 % de critique',downside:'−8 % DPS d’équipe',prod:.92,crit:.10},
  {key:'overcharge',name:'Surcharge arcanique',icon:'fa-burst',rarity:'legendary',upside:'+40 % dégâts d’Ultime',downside:'Recharge +12 %',burst:1.40,cooldown:1.12},
  {key:'brotherhood',name:'Serment de la Meute',icon:'fa-people-group',rarity:'epic',upside:'+35 % dégâts de Combo',downside:'−10 % dégâts de clic',team:1.35,click:.90},
  {key:'tempo',name:'Danse du Temps',icon:'fa-hourglass-half',rarity:'legendary',upside:'Recharges −18 %',downside:'−10 % DPS d’équipe',cooldown:.82,prod:.90},
  {key:'glass_cannon',name:'Lame de Verre',icon:'fa-khanda',rarity:'epic',upside:'+35 % dégâts de clic',downside:'−15 % DPS d’équipe',click:1.35,prod:.85},
  {key:'discipline',name:'Discipline parfaite',icon:'fa-yin-yang',rarity:'rare',upside:'+15 % à tous les dégâts',downside:'Recharges +15 %',prod:1.15,click:1.15,burst:1.15,team:1.15,cooldown:1.15},
  {key:'echo',name:'Écho des héros',icon:'fa-wand-sparkles',rarity:'mythic',upside:'+22 % DPS et Combo',downside:'−6 % de critique',prod:1.22,team:1.22,crit:-.06},
];
function parseRunBlessings(value) {
  const values=Array.isArray(value)?value:String(value||'').split(',');
  return values.map((key)=>String(key).trim()).filter((key)=>RUN_BLESSINGS.some((item)=>item.key===key)).slice(0,12);
}
function runBlessingEffects(value) {
  const effects={prod:1,click:1,crit:0,cooldown:1,burst:1,team:1};
  for(const key of parseRunBlessings(value)){
    const item=RUN_BLESSINGS.find((entry)=>entry.key===key);if(!item)continue;
    for(const stat of ['prod','click','cooldown','burst','team'])effects[stat]*=item[stat]||1;
    effects.crit+=item.crit||0;
  }
  return effects;
}
function runBlessingChoices(userId,prestigeLevel,choiceIndex,owned=[]) {
  const ownedKeys=parseRunBlessings(owned);const score=(item,salt)=>String(`${userId}:${prestigeLevel}:${choiceIndex}:${salt}:${item.key}`).split('').reduce((n,char)=>((n*33)^char.charCodeAt(0))>>>0,2166136261);
  const fresh=RUN_BLESSINGS.filter((item)=>!ownedKeys.includes(item.key)).sort((a,b)=>score(a,'fresh')-score(b,'fresh'));
  const repeats=RUN_BLESSINGS.filter((item)=>ownedKeys.includes(item.key)).sort((a,b)=>score(a,'repeat')-score(b,'repeat'));
  return [...fresh,...repeats].slice(0,3);
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
  // « Game-changers » façon Clicker Heroes : ils changent la façon de jouer,
  // pas seulement un pourcentage — c'est ce qui donne envie de re-prestiger.
  // Frappe Fantôme : `effectPerLevel` frappes automatiques/s, converties en
  // DPS via clickYield au moment du calcul (voir autoClickDps côté routes).
  { key: 'frappe_fantome', name: 'Frappe Fantôme', icon: 'fa-hand-sparkles', kind: 'autoClickRate', effectPerLevel: 1 },
  // Pas du Conquérant : chaque run après Prestige démarre 5 stages plus loin
  // (borné au meilleur stage jamais atteint — jamais de contenu sauté).
  { key: 'pas_conquerant', name: 'Pas du Conquérant', icon: 'fa-person-hiking', kind: 'startStage', effectPerLevel: 5 },
  // Fortune des Gardiens : +25% d'Essence sur les coffres de boss par niveau.
  { key: 'fortune_gardiens', name: 'Fortune des Gardiens', icon: 'fa-coins', kind: 'bossRewardMult', effectPerLevel: 0.25 },
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

// ── Succès permanents : chaque succès COMPLÉTÉ (pas besoin de réclamer le
// Sceau) accorde +1% de production totale, pour toujours — même mécanique que
// Clicker Heroes, où les achievements sont un moteur de rétention discret
// mais constant. Le multiplicateur s'applique dans computeTotalRate.
const ACHIEVEMENT_PROD_BONUS = 0.01;
function achievementProdMultiplier(completedCount) {
  return 1 + Math.max(0, Math.floor(completedCount || 0)) * ACHIEVEMENT_PROD_BONUS;
}

// ── Recrues « Éveillées » (équivalent shiny) : ~2,5% des invocations sortent
// une version dorée du héros, +10% de production personnelle permanente.
const AWAKENED_CHANCE = 0.025;
const AWAKENED_BONUS = 1.10;

// ── Orbes bonus : un orbe cliquable traverse la scène toutes les quelques
// minutes (équivalent golden cookie). Le serveur borne la fréquence
// (ORB_COOLDOWN_SECONDS) et paie ORB_PRODUCTION_SECONDS de production.
const ORB_COOLDOWN_SECONDS = 90;
const ORB_PRODUCTION_SECONDS = 20;
const ORB_MIN_REWARD = 10;
const ORB_SEAL_CHANCE = 0.05;
function orbReward(totalRate) {
  return Math.max(ORB_MIN_REWARD, Math.round(finiteIdleNumber(Math.max(0, totalRate) * ORB_PRODUCTION_SECONDS)));
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
  recruitCost,
  recruitEssenceCost,
  PROD_LEVEL_BONUS,
  PROD_LEVEL_MAX,
  prodMultiplier,
  prodUpgradeCost,
  CLICK_BASE,
  CLICK_LEVEL_BONUS,
  CLICK_LEVEL_MAX,
  clickYield,
  clickUpgradeCost,
  CRIT_LEVEL_BONUS,
  CRIT_LEVEL_MAX,
  critUpgradeBonus,
  critUpgradeCost,
  COOLDOWN_LEVEL_BONUS,
  COOLDOWN_LEVEL_MAX,
  cooldownUpgradeBonus,
  cooldownUpgradeCost,
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
  ENEMY_ARCHETYPES,
  enemyArchetype,
  enemyUnitMaxHp,
  enemiesRequiredForStage,
  normalizeWaveProgress,
  enemyUnitReward,
  enemiesDefeatedBeforeStage,
  simulateCombat,
  MIN_ENEMY_SECONDS,
  MIN_BOSS_SECONDS,
  MAX_STAGE_ADVANCE_PER_SYNC,
  CHAR_LEVEL_BONUS,
  charLevelMultiplier,
  CHAR_LEVEL_BASE_COST,
  CHAR_LEVEL_GROWTH,
  charLevelUpCost,
  charLevelBulkCost,
  RARITY_LEVEL_BONUS,
  RARITY_PASSIVE,
  HERO_MILESTONES,
  HERO_ASCENSION_LEVEL,
  DOJO_XP_BASE,
  DOJO_XP_GROWTH,
  dojoXpForLevel,
  dojoLevelForXp,
  DOJO_LEVEL_BONUS,
  dojoLevelMultiplier,
  rankQuestSeries,
  STAGE_XP_BASE,
  STAGE_XP_GROWTH,
  stageXpForLevel,
  stageForXp,
  DOJO_DECOR,
  CAMPAIGN_ENEMIES,
  CAMPAIGN_ACT_LENGTH,
  campaignDifficulty,
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
  PRESTIGE_STAGE_STEP,
  PRESTIGE_MIN_RUN_BASE_MS,
  prestigeMinimumRunMs,
  prestigeRequiredStage,
  wisdomForPrestige,
  wisdomForRunStage,
  RUN_BLESSINGS,
  parseRunBlessings,
  runBlessingEffects,
  runBlessingChoices,
  ANCIENT_BASE_COST,
  ANCIENT_COST_GROWTH,
  ancientCost,
  ANCIENTS,
  ancientByKey,
  ancientBonus,
  ACHIEVEMENT_PROD_BONUS,
  achievementProdMultiplier,
  AWAKENED_CHANCE,
  AWAKENED_BONUS,
  ORB_COOLDOWN_SECONDS,
  ORB_PRODUCTION_SECONDS,
  ORB_SEAL_CHANCE,
  orbReward,
};
