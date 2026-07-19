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

// Niveau d'entraînement DE LA CARTE assignée (pas du compte) : illimité. Le
// niveau SUIT le personnage (source de vérité : DojoRecruit.trainingLevel,
// restauré à chaque assignation — cf. POST /assign) : changer un héros
// d'emplacement ne lui fait jamais perdre ses niveaux.
// C'est le principal puits d'essence à long terme — ★ et Discipline plafonnent,
// pas ça : le coût croît plus vite que le gain, donc la progression ralentit
// sans jamais s'arrêter (courbe idle classique).
// Le gain reste perceptible à chaque achat, mais la base et la croissance du
// coût empêchent désormais d'enchaîner des dizaines de niveaux sans choix.
const CHAR_LEVEL_BONUS = 0.12;
// La rareté apporte un avantage initial contenu, mais ne creuse plus un
// gouffre exponentiel à chaque niveau. Ainsi, rôles, talents, synergies et
// personnages favoris restent des choix viables jusqu'en fin de run.
// L'avantage de rareté passe par la base (RARITY_RATE) et des coûts de
// niveau COMPRESSÉS (cf. CHAR_LEVEL_BASE_COST) : l'ancien barème (28→52)
// rendait le mythique MOINS rentable que le rare en production/essence
// investie (base ×1.45 mais coût ×1.86) — la rareté haute était un piège.
const RARITY_LEVEL_BONUS = { common: .03, rare: .05, epic: .05, legendary: .05, mythic: .05 };
// Hash stable (nom+univers) utilisé pour tout ce qui doit varier PAR
// personnage sans tirage aléatoire réel ni colonne DB dédiée : rôle assigné,
// repli de talent, et désormais magnitude du passif de rareté. Même
// personnage ⇒ toujours le même résultat, y compris après redéploiement.
function stableCharacterHash(character) {
  const text = typeof character === 'object' ? `${character?.name || ''}|${character?.series || ''}` : String(character || '');
  let hash = 2166136261; for (const char of text) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return Math.abs(hash);
}
// Passif de rareté : jusqu'ici un seul nombre fixe par palier de rareté, donc
// deux personnages de même rareté avaient TOUJOURS le même bonus, sur le même
// stat — aucune variété. Chaque personnage tire maintenant un TYPE de passif
// dans le pool de son palier ET sa propre magnitude dans la fourchette de ce
// type (les deux stables, dérivées de son identité), sur le même principe que
// `characterTalent`. Le catalogue dépasse 13 000 personnages : un pool +
// fourchette procédural est la seule option qui ne demande aucun contenu
// écrit à la main par personnage.
// stat 'prodSelf'  : bonus sur la production PROPRE du personnage.
// stat 'prodTeam'  : bonus sur la production de TOUTE l'équipe.
// stat 'click'     : bonus sur les dégâts de clic manuel.
// stat 'crit'      : points de chance critique supplémentaires.
// stat 'cooldown'  : réduction de la recharge de l'Ultime et du Combo.
// common n'a pas de bonus mécanique (pur texte de progression économique).
const RARITY_PASSIVE_POOL = {
  rare: [
    { key: 'endurance', label: 'Endurance', stat: 'prodSelf', min: .03, max: .07 },
    { key: 'sprint', label: 'Sprint', stat: 'click', min: .02, max: .06 },
    { key: 'instinct', label: 'Instinct aiguisé', stat: 'crit', min: .01, max: .03 },
  ],
  // Chaque palier au-dessus de rare offre aussi un passif de production
  // personnelle : sans lui, un épique/légendaire pouvait tirer un `cooldown`
  // 1-3% quasi nul et être objectivement moins bon qu'un rare Endurance —
  // aucun palier ne doit avoir de « passif poubelle » comme seul tirage
  // possible face au stat qui porte réellement l'économie (la production).
  epic: [
    { key: 'aura', label: 'Aura', stat: 'prodTeam', min: .01, max: .03 },
    { key: 'vigueur', label: 'Vigueur', stat: 'prodSelf', min: .05, max: .09 },
    { key: 'fulgurance', label: 'Fulgurance', stat: 'click', min: .03, max: .07 },
    { key: 'precision', label: 'Précision', stat: 'crit', min: .02, max: .04 },
    { key: 'flux_mineur', label: 'Flux mineur', stat: 'cooldown', min: .01, max: .03 },
  ],
  legendary: [
    { key: 'domination', label: 'Domination', stat: 'prodTeam', min: .03, max: .05 },
    { key: 'ardeur', label: 'Ardeur', stat: 'prodSelf', min: .07, max: .12 },
    { key: 'fureur', label: 'Fureur', stat: 'click', min: .05, max: .09 },
    { key: 'oeil_du_tigre', label: 'Œil du Tigre', stat: 'crit', min: .03, max: .05 },
    { key: 'flux_majeur', label: 'Flux majeur', stat: 'cooldown', min: .02, max: .04 },
  ],
  mythic: [
    { key: 'transcendance', label: 'Transcendance', stat: 'prodTeam', min: .05, max: .07 },
    { key: 'essence_primordiale', label: 'Essence primordiale', stat: 'prodSelf', min: .09, max: .15 },
    { key: 'apocalypse', label: 'Apocalypse', stat: 'click', min: .07, max: .11 },
    { key: 'oeil_omniscient', label: 'Œil Omniscient', stat: 'crit', min: .04, max: .06 },
    { key: 'flux_transcendant', label: 'Flux transcendant', stat: 'cooldown', min: .03, max: .05 },
  ],
};
const PASSIVE_STAT_TEXT = {
  prodSelf: (v) => `+${v}% de production personnelle au niveau 10`,
  prodTeam: (v) => `+${v}% de production à toute l’équipe au niveau 10`,
  click: (v) => `+${v}% de dégâts de clic au niveau 10`,
  crit: (v) => `+${v} point${v > 1 ? 's' : ''} de chance critique au niveau 10`,
  cooldown: (v) => `-${v}% de recharge des compétences au niveau 10`,
};
// Type de passif tiré parmi le pool du palier — stable par personnage (même
// hash que roleForCharacter/characterTalent, juste un modulo différent :
// même précédent que ces deux fonctions qui dérivent chacune leur propre
// sélection du même hash de base).
function characterPassiveEntry(character, rarity) {
  const pool = RARITY_PASSIVE_POOL[rarity];
  if (!pool || !pool.length) return null;
  return pool[stableCharacterHash(character) % pool.length];
}
function characterPassiveMagnitude(character, rarity) {
  const entry = characterPassiveEntry(character, rarity);
  if (!entry) return 0;
  // Hash SALÉ (≠ celui du type) : type et magnitude tiraient du même hash
  // (`%pool.length` et `%1000`), donc les deux tirages étaient corrélés — les
  // personnages d'un même type de passif se partageaient les mêmes classes de
  // résidus de magnitude au lieu de couvrir toute la fourchette.
  const salted = typeof character === 'object'
    ? `${character?.name || ''}|${character?.series || ''}|magnitude`
    : `${String(character || '')}|magnitude`;
  const roll = (stableCharacterHash(salted) % 1000) / 1000;
  return Number((entry.min + roll * (entry.max - entry.min)).toFixed(3));
}
// Magnitude du passif de CE personnage pour le `stat` demandé — 0 si son
// passif tiré ne correspond pas à ce stat (permet aux appelants de sommer
// sans avoir à connaître à l'avance quel type chaque personnage a reçu).
function characterPassiveBonus(character, rarity, stat) {
  const entry = characterPassiveEntry(character, rarity);
  if (!entry || entry.stat !== stat) return 0;
  return characterPassiveMagnitude(character, rarity);
}
function characterPassiveDescription(character, rarity) {
  const entry = characterPassiveEntry(character, rarity);
  if (!entry) return 'Apprenti · progression économique';
  const percent = Math.round(characterPassiveMagnitude(character, rarity) * 1000) / 10;
  return `${entry.label} · ${PASSIVE_STAT_TEXT[entry.stat](percent)}`;
}
// 250/500 étaient hors de portée (L250 coûtait ~2,7e23 essence sur un rare) :
// les deux derniers jalons n'existaient que sur le papier. 150/200 restent de
// vrais objectifs de très longue haleine, mais atteignables dans une vie de
// compte.
const HERO_MILESTONES = [10, 25, 50, 100, 150, 200];
const HERO_ASCENSION_LEVEL = 100;
const HERO_ASCENSION_LEVEL_STEP = 10;
// 5 → 10 paliers : à 5/5, un héros aussi Éveil 5/5 n'avait plus AUCUN objectif
// de puissance discret à viser (retour utilisateur : "l'ascension et l'éveil
// sont tout les 2 bloqués"). Les 5 paliers suivants gardent la même formule
// de coût/gain, juste étendue plus loin dans la courbe.
const HERO_ASCENSION_MAX = 10;
const HERO_ASCENSION_GROWTH = 1.6;
// Équivalent-niveaux du coût d'une Ascension (voir heroAscensionCost).
const HERO_ASCENSION_LEVEL_EQUIVALENT = 12;
function heroAscensionRequiredLevel(ascension) {
  return HERO_ASCENSION_LEVEL + Math.max(0, Math.floor(ascension || 0)) * HERO_ASCENSION_LEVEL_STEP;
}
function heroAscensionMultiplier(ascension) {
  return finiteIdleNumber(Math.pow(HERO_ASCENSION_GROWTH, Math.max(0, Math.min(HERO_ASCENSION_MAX, Math.floor(ascension || 0)))), 1);
}
// Coût indexé sur le coût de niveau AU niveau requis (≈ l'équivalent de
// HERO_ASCENSION_LEVEL_EQUIVALENT niveaux à cet endroit de la courbe), et non
// plus sur des bases fixes en essence : les anciennes bases (400k pour un
// mythique A1) étaient ~0,05% de l'essence déjà investie pour atteindre L100 —
// l'Ascension était un clic automatique, pas un choix. Le coût suit désormais
// naturellement la courbe (chaque palier +10 niveaux requis ⇒ ×1.16^10 ≈ ×4.4,
// même ordre que l'ancien COST_GROWTH), et reste ~1.8× plus rentable que la
// montée de niveaux brute — un vrai jalon récompensant, plus un cadeau.
function heroAscensionCost(rarity, ascension) {
  const requiredLevel = heroAscensionRequiredLevel(ascension);
  return Math.round(finiteIdleNumber(charLevelBulkCost(rarity, requiredLevel, HERO_ASCENSION_LEVEL_EQUIVALENT), 1));
}
function charLevelMultiplier(level) {
  return 1 + Math.max(0, (level || 1) - 1) * CHAR_LEVEL_BONUS;
}
// Coûts compressés (34/42/52 → 30/32/34) : l'écart de coût entre raretés
// doit rester INFÉRIEUR à l'écart de production (RARITY_RATE, ×1.45 max),
// sinon la rareté haute rapporte moins par essence investie que le rare.
const CHAR_LEVEL_BASE_COST = { common: 12, rare: 28, epic: 30, legendary: 32, mythic: 34 };
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
// Le passif de rareté « prodSelf » (possible sur les rares, cf.
// RARITY_PASSIVE_POOL) n'est PAS appliqué ici : `slotRate` n'a pas
// l'identité du personnage (juste rareté+niveau), et le type/la magnitude
// varient maintenant PAR personnage. Il est appliqué en aval, dans
// `computeTotalRate` (idle.routes.js), qui a accès au personnage complet.
function slotRate(rarity, charLevel) {
  const scaling = RARITY_LEVEL_BONUS[rarity] || CHAR_LEVEL_BONUS;
  const level = Math.max(1, charLevel || 1);
  const reached = HERO_MILESTONES.filter((target) => target <= level).length;
  // Les paliers restent de vrais objectifs, sans quadrupler brutalement le
  // rendement d'un achat unique ni court-circuiter l'économie de la run.
  const milestoneMultiplier = Math.pow(2, reached);
  return finiteIdleNumber((RARITY_RATE[rarity] || 0) * Math.pow(1 + scaling, level - 1) * milestoneMultiplier);
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
// La croissance reste progressive et suit toute la montée en puissance.
function recruitEssenceCost(essenceRecruitCount, discountBonus) {
  const discount = Math.max(0, Math.min(0.6, discountBonus || 0));
  // La production du Dojo continue d'augmenter : plafonner ce coût rendait
  // les invocations en Essence pratiquement gratuites en fin de progression.
  const base = finiteIdleNumber(1500 * Math.pow(1.18, Math.max(0, essenceRecruitCount || 0)), 1500);
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
  // 1.75→1.65 : les derniers niveaux coûtaient ~250G pour +8% additif — un
  // rapport si mauvais que le plafond n'était jamais atteint. Discipline
  // reste un gros puits de fin de run (~55G au total), mais achetable.
  return Math.round(finiteIdleNumber(75 * Math.pow(1.65, level)*earlyDiscount, 1));
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
// Part de la production d'équipe ajoutée à CHAQUE frappe manuelle (2,5% du
// taux/s par clic, soit jusqu'à +25% de DPS à 10 clics/s, avant Frappes
// Multiples). Sans elle, le clic plafonnait en dur (CLICK_BASE +
// CLICK_LEVEL_MAX×CLICK_LEVEL_BONUS = 125 avant multiplicateurs) face à des
// PV exponentiels : dès le milieu de partie, frapper — et tout ce qui s'y
// rattache (Instinct, Frappes Multiples, passifs click/crit, classes
// offensives, modificateurs de monde) — devenait purement cosmétique. Le
// clic reste ainsi un geste actif rentable à TOUT stade de la partie.
// N'alimente PAS les frappes automatiques des Ancients (autoClickDps), qui
// entrent elles-mêmes dans la production totale : ce serait circulaire.
const CLICK_RATE_SHARE = 0.025;

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

// Amélioration « Frappes Multiples » : chaque clic manuel simule plusieurs
// frappes à la fois (dégâts ET kills comptés en conséquence), pour donner de
// la profondeur au clic au lieu d'un geste répétitif sans enjeu (retour
// testeur : « le clic manque d'intérêt... des upgrade pour augmenter le
// nombre de clique en un clique »). Comme Instinct/Flux, repart à zéro au
// Prestige — c'est un renforcement de la run en cours, pas un bonus permanent.
const MULTI_STRIKE_BONUS = 0.05;
const MULTI_STRIKE_MAX = 20;
function multiStrikeBonus(level) {
  return Math.min(Math.max(0, level || 0), MULTI_STRIKE_MAX) * MULTI_STRIKE_BONUS;
}
function multiStrikeUpgradeCost(level) {
  const earlyDiscount=[.4,.5,.65,.8,.9][Math.max(0,level)]??1;
  return Math.round(finiteIdleNumber(120 * Math.pow(1.8, level) * earlyDiscount, 1));
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
// Fixe et prévisible (ne dépend QUE de l'index de l'emplacement) : une version
// précédente indexait ce coût sur le stage (investmentCostIndex) pour suivre
// la croissance de l'Essence en fin de partie, mais ça rendait le prix d'un
// même emplacement imprévisible d'un compte à l'autre (retour utilisateur :
// « doit être fixe, mais augmenter pour que ce soit cohérent »). La
// progression reste franche (×3.5 par emplacement, resserrée depuis ×2.25 —
// retour utilisateur : « augmente plus que ça ») pour que le dernier reste un
// vrai investissement, sans jamais dépendre d'autre chose que sa position.
function slotUpgradeCost(nextSlotIndex) {
  return Math.round(finiteIdleNumber(400 * Math.pow(3.5, nextSlotIndex - START_SLOTS), 1));
}

// Plafond de production hors-ligne : au-delà, le surplus n'est plus compté —
// encourage à revenir régulièrement sans punir une grosse pause. Abaissé de
// 12h à 8h (retour testeur : trop généreux — au-delà du plafond de +3 stages
// par synchronisation, le combat continue de farmer de l'Essence au stage
// figé pendant TOUT le reste de la fenêtre, donc la durée seule peut déjà
// représenter un gain énorme si le DPS a beaucoup progressé entretemps).
// Toujours extensible via les Ancients de résilience (Bourse Profonde,
// Sommeil Profond, Sanctuaire, Éternité), sans plafond sur cette extension.
const OFFLINE_CAP_MS = 8 * 60 * 60 * 1000; // 8h

// Combat de run : contrairement à l'ancien affichage, un stage possède
// maintenant de vrais PV. L'équipe inflige son taux de production sous forme
// de DPS et chaque ennemi vaincu verse de l'Essence. Les boss, tous les dix
// stages, doivent tomber en 30 secondes ; sinon la simulation revient sur le
// dernier stage normal afin qu'une absence ne bloque jamais le joueur.
const ENEMY_HP_BASE = 20;
// Relevé de 1.13→1.15 (retour testeur : « on arrive à Hueco Mundo [~stage 55]
// trop vite, personne n'est jamais bloqué sur un boss ») : avec la pile de
// multiplicateurs de production du Dojo (niveaux, paliers ×2, Ascension,
// Éveil, Discipline, rôles, synergies, classes, succès...), le DPS des
// joueurs investis croît bien plus vite que l'ancienne courbe d'ennemis —
// les boss ne représentaient jamais un vrai mur avant la fin de l'Acte 1.
const ENEMY_HP_GROWTH = 1.15;
const BOSS_INTERVAL = 10;
// Relevé de 9→12 : les boss doivent rester le moment où le DPS accumulé est
// réellement mis à l'épreuve (30s pour l'abattre), pas une formalité que
// n'importe quelle équipe de vagues normales franchit sans y penser.
const BOSS_HP_MULTIPLIER = 12;
const ELITE_WAVE = 5;
const ELITE_HP_MULTIPLIER = 3;
const BOSS_TIMER_SECONDS = 30;
const ENEMY_REWARD_BASE = 2;
// La récompense de base suit les PV afin qu'un monde avancé ne soit jamais
// moins rentable à farmer que le début du jeu. La difficulté vient du mur de
// PV à franchir et des coûts qui croissent plus vite, pas d'une incitation à
// retourner farmer indéfiniment le stage 4.
// Relevé avec ENEMY_HP_GROWTH (même marge de +0,1 pt au-dessus) : sans ce
// suivi, la hausse de la difficulté (1.13→1.15) aurait dégradé le farm des
// hauts stages en cassant l'invariant ci-dessus (récompense/PV en baisse).
const ENEMY_REWARD_GROWTH = 1.151;
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
  // Élite : récompense alignée sur ses PV (×3/×3). À ×1.5 pour ×3 PV, la
  // vague 5 était une pure punition de rendement en farm.
  const special = isBossStage(s) ? 3 : isEliteStage(s) ? ELITE_HP_MULTIPLIER : 1;
  return Math.max(1, Math.round(finiteIdleNumber(ENEMY_REWARD_BASE * Math.pow(ENEMY_REWARD_GROWTH, s - 1) * special * campaignDifficulty(s).reward, 1)));
}
// Plancher d'investissement (amélioration d'objets, Étoiles d'Éveil) : ces
// coûts réutilisaient enemyReward(bestStage), donc la MÊME croissance ×1.151
// que les PV ennemis. Or bestStage avance quasiment tout seul (DPS auto vs
// PV, courbes déjà appariées), alors que l'Essence produite dépend d'un
// investissement actif (niveaux/équipement/éveil) bien plus lent à monter —
// retour utilisateur : "quasiment impossible" de suivre. Courbe dédiée, bien
// plus douce (×1.08/stage), décorrélée des pics de difficulté de campagne :
// le coût continue de suivre la progression sans jamais la devancer.
const INVESTMENT_COST_GROWTH = 1.08;
function investmentCostIndex(stage) {
  const s = Math.max(1, Math.floor(stage || 1));
  return finiteIdleNumber(ENEMY_REWARD_BASE * Math.pow(INVESTMENT_COST_GROWTH, s - 1), 1);
}
// ── Donjon des Objets : farm RÉPÉTABLE et CIBLÉ d'objets, façon donjon Caiross
// de Summoners War — jusque-là, un objet ne tombait que du coffre de boss
// (une fois par palier de 10 stages) ou de la Faille (4 fois/semaine max),
// jamais assez pour compléter plusieurs sets sur plusieurs héros (retour
// utilisateur). Ici le joueur choisit directement le kind (rune1..6, donc
// l'emplacement qu'il veut garnir) : quelques tentatives gratuites par jour,
// puis un coût croissant en Essence pour continuer au-delà, remis à zéro
// chaque jour avec les tentatives gratuites.
// Le Donjon se descend étage par étage : seul le dernier étage donne un
// équipement, les précédents ne donnent rien. Entièrement GRATUIT (demande
// utilisateur) — l'ancien coût croissant en Essence a été retiré, le temps de
// descente (10 combats calés sur la progression du joueur) est la seule
// monnaie.
const RUNE_DUNGEON_FLOORS = 10;
// Tirage pondéré (pas un plancher déterministe) : la moyenne progresse avec
// les mêmes jalons de monde que le décor (DOJO_DECOR), mais chaque tentative
// reste un vrai tirage — un coup de chance peut sortir une rareté au-dessus
// de son palier, comme un roll d'invocation classique.
const RUNE_DUNGEON_RARITY_WEIGHTS = [
  { minStage: 650, weights: [['rare', 5], ['epic', 20], ['legendary', 40], ['mythic', 35]] },
  { minStage: 250, weights: [['rare', 10], ['epic', 35], ['legendary', 45], ['mythic', 10]] },
  { minStage: 50, weights: [['rare', 35], ['epic', 50], ['legendary', 15]] },
  { minStage: 1, weights: [['rare', 80], ['epic', 20]] },
];
function runeDungeonRarity(bestStage = 1) {
  const s = Math.max(1, Math.floor(bestStage || 1));
  const tier = RUNE_DUNGEON_RARITY_WEIGHTS.find((t) => s >= t.minStage) || RUNE_DUNGEON_RARITY_WEIGHTS.at(-1);
  const total = tier.weights.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [rarity, w] of tier.weights) { if (r < w) return rarity; r -= w; }
  return tier.weights[0][0];
}
const ENEMY_ARCHETYPES = {
  standard: { key:'standard', name:'Standard', description:'Adversaire équilibré.', hpMultiplier:1, rewardMultiplier:1 },
  swift: { key:'swift', name:'Rapide', description:'Peu de PV, récompense normale.', hpMultiplier:.68, rewardMultiplier:1 },
  armored: { key:'armored', name:'Blindé', description:'Plus résistant, butin amélioré.', hpMultiplier:1.6, rewardMultiplier:1.6 },
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
function simulateCombat({ stage = 1, hp = 0, waveKills = 0, dps = 0, bossDpsMultiplier = 1, elapsedSeconds = 0, mode = 'progress', maxKills = 10000, maxStageAdvance = Infinity, bossEngaged = false } = {}) {
  const normalized = normalizeWaveProgress(stage, waveKills, mode);
  const startingStage = normalized.stage;
  let currentStage = normalized.stage;
  let currentWaveKills = normalized.waveKills;
  let currentHp = Number(hp);
  let seconds = Math.max(0, Number(elapsedSeconds) || 0);
  const damagePerSecond = Math.max(0, Number(dps) || 0);
  // Les faiblesses tactiques sont un bonus CONTRE les Gardiens, pas une
  // hausse permanente du DPS de l'équipe. Les appliquer ici empêche la
  // valeur générale affichée de chuter brutalement juste après un boss.
  const guardianMultiplier = Math.max(1, Number(bossDpsMultiplier) || 1);
  let essence = 0;
  let kills = 0;
  let bossFailed = false;
  const farming = mode === 'farm';
  let progressionCapped = false;
  const maxHp = () => enemyUnitMaxHp(currentStage, currentWaveKills);
  if (!Number.isFinite(currentHp) || currentHp <= 0 || currentHp > maxHp()) currentHp = maxHp();
  if (!damagePerSecond || !seconds) return { stage: currentStage, hp: currentHp, waveKills: currentWaveKills, essence, kills, bossFailed, elapsedSeconds: 0 };

  while (seconds > 0 && kills < maxKills) {
    // Un Boss attend un clic explicite d'engagement — l'auto-DPS (en ligne
    // comme hors-ligne) s'arrête pile devant lui tant que ce n'est pas fait,
    // au lieu de l'encaisser silencieusement pendant que le joueur regarde
    // ailleurs. `seconds = 0` (pas juste `break`) : sans ça, le temps passé
    // devant un Boss verrouillé restait "en banque" (jamais consommé, cf. le
    // elapsedSeconds renvoyé plus bas) — au moment de l'engager, TOUT ce
    // temps accumulé se simulait d'un coup, capable de le tuer puis
    // d'enchaîner plusieurs vagues du monde suivant dans la foulée (retour
    // joueur : "j'arrive vague 3 après avoir cliqué sur affronter le boss,
    // comme si ça tournait en fond"). Attendre devant un Boss verrouillé ne
    // doit rien faire produire ET ne doit rien mettre de côté à débloquer
    // plus tard.
    if (isBossStage(currentStage) && !bossEngaged) { seconds = 0; break; }
    // Un ennemi doit rester perceptible à l'écran : sans cadence minimale,
    // 1,5 M DPS au stage 1 convertissait l'overkill en ~10 M Essence/minute.
    // Le DPS conserve toute sa valeur sur le contenu adapté, mais ne permet
    // plus de tuer des milliers d'ennemis faibles dans une seule frame.
    const encounterDps = damagePerSecond * (isBossStage(currentStage) ? guardianMultiplier : 1);
    const timeToKill = Math.max(currentHp / encounterDps, isBossStage(currentStage) ? MIN_BOSS_SECONDS : MIN_ENEMY_SECONDS);
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
// Pool de 5 types d'épreuves (au lieu des 3 mêmes à chaque niveau, toujours
// dans le même ordre — retour testeur : « il faudrait diversifier les quêtes
// de montée de niveau ») : 3 sont tirées par rotation déterministe sur le
// niveau courant, donc stables d'un rendu à l'autre mais différentes d'un
// rang au suivant. Le cycle complet (5 niveaux) retombe sur kills/clics/
// améliorations tous les 5 rangs — pile quand l'épreuve de stage bonus
// s'ajoute, sans jamais répéter deux fois de suite la même combinaison.
const RANK_QUEST_POOL = [
  { key:'kills', icon:'fa-skull', name:'Ennemis vaincus', description:'Élimine des ennemis dans Combat', counter:'kills', target:(current)=>Math.min(5000, 15 + current * 8) },
  { key:'clicks', icon:'fa-hand-fist', name:'Frappes manuelles', description:'Utilise le bouton Attaquer', counter:'clicks', target:(current)=>Math.min(4000, 40 + current * 15) },
  { key:'upgrades', icon:'fa-arrow-trend-up', name:'Améliorations achetées', description:'Dépense de l’Essence dans Améliorer', counter:'upgrades', target:(current)=>Math.min(180, 3 + Math.ceil(current * .6)) },
  { key:'skills', icon:'fa-burst', name:'Compétences actives', description:'Utilise l’Ultime ou le Combo d’équipe', counter:'skills', target:(current)=>Math.min(200, 2 + Math.ceil(current * .5)) },
  { key:'recruits', icon:'fa-user-plus', name:'Nouvelles recrues', description:'Invoque des personnages (Sceaux ou Essence)', counter:'recruits', target:(current)=>Math.min(30, 1 + Math.floor(current / 8)) },
];
function rankQuestSeries({ level = 1, kills = 0, clicks = 0, upgrades = 0, skills = 0, recruits = 0, bestStage = 1 } = {}) {
  const current = Math.max(1, Math.floor(level || 1));
  const nextLevel = current + 1;
  const progressByCounter = { kills, clicks, upgrades, skills, recruits };
  const rotation = (current - 1) % RANK_QUEST_POOL.length;
  const rotated = [...RANK_QUEST_POOL.slice(rotation), ...RANK_QUEST_POOL.slice(0, rotation)].slice(0, 3);
  const defs = rotated.map((def) => ({ key:def.key, icon:def.icon, name:def.name, description:def.description, progress:progressByCounter[def.counter] || 0, target:def.target(current) }));
  if (nextLevel % 5 === 0) {
    const stageTarget = Math.min(5000, nextLevel * 5);
    defs.push({ key:'stage', icon:'fa-flag-checkered', name:'Progression de combat', description:`Atteins le stage ${stageTarget}`, progress:bestStage, target:stageTarget });
  }
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
function wisdomForRunStage(stage, prestigeLevel = 0) {
  const s = Math.max(0, Number(stage) || 0);
  const required = prestigeRequiredStage(prestigeLevel);
  if (s < required) return 0;
  // Deux composantes :
  // - un ratio s/required (base 4, exposant 1.5) qui récompense le push
  //   relatif à l'objectif de la Retraite courante ;
  // - une composante CUMULATIVE (+1 par tranche de 20 stages au-dessus du
  //   seuil, non plafonnée) : le seuil monte de +20 par Retraite alors que le
  //   coût des Ancients croît sans plafond — au ratio seul, la Sagesse par
  //   Retraite restait plate (4-7 points) et amener un Ancient au niveau 20
  //   (~687 Sagesse) demandait une centaine de runs. La part linéaire suit la
  //   progression absolue du joueur, pas seulement son avance relative.
  const ratioPart = Math.floor(4 * Math.pow(s / required, 1.5));
  const depthPart = Math.floor((s - required) / 20);
  return Math.max(1, ratioPart + depthPart);
}

// Bénédictions temporaires : le joueur façonne un build différent à chaque
// ascension. Chaque pouvoir apporte un avantage net avec un vrai compromis ;
// la liste entière est remise à zéro au Prestige.
const RUN_BLESSINGS = [
  {key:'berserker',name:'Pacte du Berserker',icon:'fa-hand-fist',rarity:'epic',affinity:'assault',upside:'+25 % DPS d’équipe',downside:'−15 % dégâts de clic',prod:1.25,click:.85},
  {key:'deadeye',name:'Œil du Destin',icon:'fa-crosshairs',rarity:'rare',affinity:'precision',upside:'+10 % de critique',downside:'−8 % DPS d’équipe',prod:.92,crit:.10},
  {key:'overcharge',name:'Surcharge arcanique',icon:'fa-burst',rarity:'legendary',affinity:'arcane',upside:'+40 % dégâts d’Ultime',downside:'Recharge +12 %',burst:1.40,cooldown:1.12},
  {key:'brotherhood',name:'Serment de la Meute',icon:'fa-people-group',rarity:'epic',affinity:'unity',upside:'+35 % dégâts de Combo',downside:'−10 % dégâts de clic',team:1.35,click:.90},
  {key:'tempo',name:'Danse du Temps',icon:'fa-hourglass-half',rarity:'legendary',affinity:'arcane',upside:'Recharges −18 %',downside:'−10 % DPS d’équipe',cooldown:.82,prod:.90},
  {key:'glass_cannon',name:'Lame de Verre',icon:'fa-khanda',rarity:'epic',affinity:'assault',upside:'+35 % dégâts de clic',downside:'−15 % DPS d’équipe',click:1.35,prod:.85},
  {key:'discipline',name:'Discipline parfaite',icon:'fa-yin-yang',rarity:'rare',affinity:'precision',upside:'+15 % à tous les dégâts',downside:'Recharges +15 %',prod:1.15,click:1.15,burst:1.15,team:1.15,cooldown:1.15},
  {key:'echo',name:'Écho des héros',icon:'fa-wand-sparkles',rarity:'mythic',affinity:'unity',upside:'+22 % DPS et Combo',downside:'−6 % de critique',prod:1.22,team:1.22,crit:-.06},
  {key:'execution',name:'Marque de l’Exécuteur',icon:'fa-skull-crossbones',rarity:'legendary',affinity:'assault',upside:'+30 % clic et Ultime',downside:'−12 % dégâts de Combo',click:1.30,burst:1.30,team:.88},
  {key:'hunter',name:'Instinct du Chasseur',icon:'fa-eye',rarity:'epic',affinity:'precision',upside:'+7 % critique et +18 % clic',downside:'−10 % Ultime',crit:.07,click:1.18,burst:.90},
  {key:'resonance',name:'Résonance astrale',icon:'fa-wave-square',rarity:'mythic',affinity:'arcane',upside:'+28 % Ultime et recharges −10 %',downside:'−12 % clic',burst:1.28,cooldown:.90,click:.88},
  {key:'banner',name:'Bannière de l’Alliance',icon:'fa-flag',rarity:'legendary',affinity:'unity',upside:'+20 % DPS et +25 % Combo',downside:'Recharges +8 %',prod:1.20,team:1.25,cooldown:1.08},
];
const RUN_AFFINITIES = {
  assault:{key:'assault',name:'Assaut',icon:'fa-khanda',description:'2 pouvoirs : +8 % DPS et +12 % clic',prod:1.08,click:1.12},
  precision:{key:'precision',name:'Précision',icon:'fa-crosshairs',description:'2 pouvoirs : +5 % critique',crit:.05},
  arcane:{key:'arcane',name:'Arcanes',icon:'fa-wand-magic-sparkles',description:'2 pouvoirs : +15 % Ultime et recharges −8 %',burst:1.15,cooldown:.92},
  unity:{key:'unity',name:'Alliance',icon:'fa-people-group',description:'2 pouvoirs : +5 % DPS et +18 % Combo',prod:1.05,team:1.18},
};
function parseRunBlessings(value) {
  const values=Array.isArray(value)?value:String(value||'').split(',');
  return values.map((key)=>String(key).trim()).filter((key)=>RUN_BLESSINGS.some((item)=>item.key===key)).slice(0,12);
}
function runBlessingEffects(value) {
  const keys=parseRunBlessings(value);const effects={prod:1,click:1,crit:0,cooldown:1,burst:1,team:1,combos:[]};const affinityCounts={};
  for(const key of keys){
    const item=RUN_BLESSINGS.find((entry)=>entry.key===key);if(!item)continue;
    for(const stat of ['prod','click','cooldown','burst','team'])effects[stat]*=item[stat]||1;
    effects.crit+=item.crit||0;
    affinityCounts[item.affinity]=(affinityCounts[item.affinity]||0)+1;
  }
  for(const [key,count] of Object.entries(affinityCounts)){
    const affinity=RUN_AFFINITIES[key];if(!affinity||count<2)continue;
    for(const stat of ['prod','click','cooldown','burst','team'])effects[stat]*=affinity[stat]||1;
    effects.crit+=affinity.crit||0;effects.combos.push({...affinity,count});
  }
  const dominant=Object.entries(affinityCounts).sort((a,b)=>b[1]-a[1])[0];
  effects.archetype=dominant&&dominant[1]>=2?RUN_AFFINITIES[dominant[0]].name:keys.length?'Hybride':'À construire';
  return effects;
}
function runBlessingChoices(userId,prestigeLevel,choiceIndex,owned=[],rerollCount=0) {
  const ownedKeys=parseRunBlessings(owned);const score=(item,salt)=>String(`${userId}:${prestigeLevel}:${choiceIndex}:0:${salt}:${item.key}`).split('').reduce((n,char)=>((n*33)^char.charCodeAt(0))>>>0,2166136261);
  const fresh=RUN_BLESSINGS.filter((item)=>!ownedKeys.includes(item.key)).sort((a,b)=>score(a,'fresh')-score(b,'fresh'));
  const repeats=RUN_BLESSINGS.filter((item)=>ownedKeys.includes(item.key)).sort((a,b)=>score(a,'repeat')-score(b,'repeat'));
  // Un reroll parcourt le pool stable par groupes de trois au lieu de refaire
  // un tri indépendant. Ainsi deux rerolls consécutifs proposent toujours
  // trois pouvoirs différents, y compris en fin de run lorsqu'il ne reste que
  // trois pouvoirs encore jamais choisis (l'ancien tri reproposait alors
  // systématiquement le même trio tout en débitant l'Essence).
  const pool=[...fresh,...repeats];const offset=(Math.max(0,rerollCount||0)*3)%pool.length;
  return Array.from({length:Math.min(3,pool.length)},(_,index)=>pool[(offset+index)%pool.length]);
}
// Reroll payant des 3 choix proposés (retour testeur : « peut-être offrir la
// possibilité de reroll ») : coût croissant en Essence, remis à zéro au
// Prestige comme le reste du build de run.
const RUN_BLESSING_REROLL_BASE_COST = 250;
function runBlessingRerollCost(rerollCount) {
  return Math.round(RUN_BLESSING_REROLL_BASE_COST * Math.pow(1.6, Math.max(0, rerollCount || 0)));
}

// ── Ancients : arbre de Prestige PERMANENT (jamais reset, y compris par un
// nouveau Prestige), payé en Sagesse. Chaque effet se branche en paramètre
// OPTIONNEL sur une fonction pure déjà existante (`prodMultiplier`,
// `clickYield`, `pendingEssence`, `rollRecruitRarity`, `recruitCost`) — pas
// de nouvelle couche de calcul, juste un bonus de plus par-dessus.
const ANCIENT_BASE_COST = 2;
// Assoupli de 1.3→1.25 (avec le relevé de wisdomForRunStage ci-dessus) : reste
// un puits de Sagesse à très long terme (pas de plafond), mais sans faire
// décrocher la rentabilité marginale d'un Ancient après une dizaine de niveaux.
const ANCIENT_COST_GROWTH = 1.25;
// Au-delà du niveau 10, la croissance ralentit encore (1.25→1.12) : la
// Sagesse par Retraite croît linéairement (cf. wisdomForRunStage) alors
// qu'une exponentielle 1.25^n finissait toujours par la distancer — les
// niveaux profonds d'une branche restaient théoriques.
const ANCIENT_COST_SOFT_LEVEL = 10;
const ANCIENT_COST_LATE_GROWTH = 1.12;
function ancientCost(level) {
  const l = Math.max(0, level || 0);
  const early = Math.pow(ANCIENT_COST_GROWTH, Math.min(l, ANCIENT_COST_SOFT_LEVEL));
  const late = Math.pow(ANCIENT_COST_LATE_GROWTH, Math.max(0, l - ANCIENT_COST_SOFT_LEVEL));
  return Math.round(finiteIdleNumber(ANCIENT_BASE_COST * early * late, 1));
}
// Arbre de talents (Ancients) : 4 branches × 6 paliers, chaque palier N exige
// le palier N-1 de LA MÊME branche acheté (`requires`, chaîne linéaire —
// volontairement pas un graphe complexe, pour rester lisible d'un coup d'œil).
// Les 8 clés historiques sont conservées telles quelles (mêmes `key`, mêmes
// `kind`/`effectPerLevel`) : les niveaux déjà achetés par les joueurs restent
// valables, seule leur position dans l'arbre change. `ancientBonus` continue
// de sommer par `kind` sur TOUTE la liste, branche confondue — une branche
// peut donc réutiliser un `kind` déjà présent ailleurs sans rien changer au
// calcul (ex. clickMult apparaît 4 fois dans Offensive).
const ANCIENTS = [
  // ── Offensive : puissance de frappe (clic manuel + frappes automatiques).
  { key: 'frappe_affutee', name: 'Frappe Affûtée', icon: 'fa-hand-fist', kind: 'clickMult', effectPerLevel: 0.02, branch: 'offensive', tier: 1, requires: null },
  { key: 'poigne_maitre', name: 'Poigne du Maître', icon: 'fa-hand-back-fist', kind: 'clickMult', effectPerLevel: 0.03, branch: 'offensive', tier: 2, requires: 'frappe_affutee' },
  { key: 'rythme_combat', name: 'Rythme de Combat', icon: 'fa-drum', kind: 'clickMult', effectPerLevel: 0.03, branch: 'offensive', tier: 3, requires: 'poigne_maitre' },
  // « Game-changer » façon Clicker Heroes : change la façon de jouer, pas
  // seulement un pourcentage. `effectPerLevel` = frappes automatiques/s,
  // converties en DPS via clickYield au moment du calcul (autoClickDps).
  { key: 'frappe_fantome', name: 'Frappe Fantôme', icon: 'fa-hand-sparkles', kind: 'autoClickRate', effectPerLevel: 1, branch: 'offensive', tier: 4, requires: 'rythme_combat' },
  { key: 'tempete_coups', name: 'Tempête de Coups', icon: 'fa-wind', kind: 'autoClickRate', effectPerLevel: 1, branch: 'offensive', tier: 5, requires: 'frappe_fantome' },
  { key: 'apex_predateur', name: 'Apex Prédateur', icon: 'fa-crown', kind: 'clickMult', effectPerLevel: 0.10, branch: 'offensive', tier: 6, requires: 'tempete_coups' },
  // ── Résilience : continuité de la run (hors-ligne + reprise après Prestige).
  { key: 'bourse_profonde', name: 'Bourse Profonde', icon: 'fa-vault', kind: 'offlineCapMs', effectPerLevel: 20 * 60 * 1000, branch: 'resilience', tier: 1, requires: null },
  // Pas du Conquérant : chaque run après Prestige démarre plus loin (borné au
  // meilleur stage jamais atteint — jamais de contenu sauté).
  { key: 'pas_conquerant', name: 'Pas du Conquérant', icon: 'fa-person-hiking', kind: 'startStage', effectPerLevel: 5, branch: 'resilience', tier: 2, requires: 'bourse_profonde' },
  { key: 'sommeil_profond', name: 'Sommeil Profond', icon: 'fa-moon', kind: 'offlineCapMs', effectPerLevel: 20 * 60 * 1000, branch: 'resilience', tier: 3, requires: 'pas_conquerant' },
  { key: 'foulee_ancestrale', name: 'Foulée Ancestrale', icon: 'fa-shoe-prints', kind: 'startStage', effectPerLevel: 5, branch: 'resilience', tier: 4, requires: 'sommeil_profond' },
  { key: 'sanctuaire', name: 'Sanctuaire', icon: 'fa-house-chimney', kind: 'offlineCapMs', effectPerLevel: 30 * 60 * 1000, branch: 'resilience', tier: 5, requires: 'foulee_ancestrale' },
  { key: 'eternite', name: 'Éternité', icon: 'fa-hourglass', kind: 'offlineCapMs', effectPerLevel: 60 * 60 * 1000, branch: 'resilience', tier: 6, requires: 'sanctuaire' },
  // ── Croissance : chance et coût de recrutement.
  { key: 'oeil_recruteur', name: 'Œil du Recruteur', icon: 'fa-eye', kind: 'recruitLuck', effectPerLevel: 0.015, branch: 'croissance', tier: 1, requires: null },
  { key: 'marche_facile', name: 'Marché Facile', icon: 'fa-hand-holding-dollar', kind: 'recruitDiscount', effectPerLevel: 0.015, branch: 'croissance', tier: 2, requires: 'oeil_recruteur' },
  { key: 'instinct_chasseur', name: 'Instinct du Chasseur', icon: 'fa-crosshairs', kind: 'recruitLuck', effectPerLevel: 0.015, branch: 'croissance', tier: 3, requires: 'marche_facile' },
  { key: 'negociateur', name: 'Négociateur', icon: 'fa-comments-dollar', kind: 'recruitDiscount', effectPerLevel: 0.015, branch: 'croissance', tier: 4, requires: 'instinct_chasseur' },
  { key: 'flair_legendaire', name: 'Flair Légendaire', icon: 'fa-wand-magic-sparkles', kind: 'recruitLuck', effectPerLevel: 0.02, branch: 'croissance', tier: 5, requires: 'negociateur' },
  { key: 'oracle', name: 'Oracle', icon: 'fa-hat-wizard', kind: 'recruitLuck', effectPerLevel: 0.03, branch: 'croissance', tier: 6, requires: 'flair_legendaire' },
  // ── Économie : production passive et butin de boss.
  { key: 'discipline_eternelle', name: 'Discipline Éternelle', icon: 'fa-infinity', kind: 'prodMult', effectPerLevel: 0.02, branch: 'economie', tier: 1, requires: null },
  // Fortune des Gardiens : +25% d'Essence sur les coffres de boss par niveau.
  { key: 'fortune_gardiens', name: 'Fortune des Gardiens', icon: 'fa-coins', kind: 'bossRewardMult', effectPerLevel: 0.25, branch: 'economie', tier: 2, requires: 'discipline_eternelle' },
  { key: 'flux_constant', name: 'Flux Constant', icon: 'fa-water', kind: 'prodMult', effectPerLevel: 0.02, branch: 'economie', tier: 3, requires: 'fortune_gardiens' },
  { key: 'butin_genereux', name: 'Butin Généreux', icon: 'fa-gem', kind: 'bossRewardMult', effectPerLevel: 0.25, branch: 'economie', tier: 4, requires: 'flux_constant' },
  { key: 'abondance', name: 'Abondance', icon: 'fa-seedling', kind: 'prodMult', effectPerLevel: 0.025, branch: 'economie', tier: 5, requires: 'butin_genereux' },
  { key: 'corne_abondance', name: 'Corne d’Abondance', icon: 'fa-mound', kind: 'prodMult', effectPerLevel: 0.04, branch: 'economie', tier: 6, requires: 'abondance' },
];
const ANCIENT_BRANCHES = [
  { key: 'offensive', name: 'Offensive', icon: 'fa-hand-fist', description: 'Puissance de clic et frappes automatiques.' },
  { key: 'resilience', name: 'Résilience', icon: 'fa-shield-halved', description: 'Continuité de la run : hors-ligne et reprise après Prestige.' },
  { key: 'croissance', name: 'Croissance', icon: 'fa-seedling', description: 'Chance et coût de recrutement.' },
  { key: 'economie', name: 'Économie', icon: 'fa-coins', description: 'Production passive et butin de boss.' },
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

// ── Étoiles d'Éveil : investissement PERMANENT par héros, payé en Essence —
// le pendant « éveil progressif » de Summoners War / AFK Arena. Chaque
// étoile ajoute +8% de production personnelle ; conservées au Prestige comme
// le roster. Payé en Sceaux au départ, comme l'invocation : retour unanime
// des testeurs, les Sceaux sont trop précieux (seule monnaie d'invocation)
// pour être aussi le prix de l'éveil — payer en Essence, indexée sur la
// progression comme le recyclage/l'amélioration des runes, remet l'éveil
// dans le même budget que le reste des investissements de héros (niveaux,
// Ascension), sans jamais entrer en concurrence avec le recrutement.
// 5 → 10 étoiles, même raison que HERO_ASCENSION_MAX ci-dessus : un héros
// Éveil 5/5 n'avait plus rien à investir dès qu'il était aussi Ascension
// max, ce qui se lisait comme un blocage plutôt qu'un plafond de contenu.
const AWAKEN_STAR_MAX = 10;
const AWAKEN_STAR_BONUS = 0.08;
// Coût = N fois la récompense d'un ennemi au meilleur stage atteint, pondéré
// par rareté (mêmes facteurs relatifs que SALVAGE_STAGE_FACTOR) et croissant
// par étoile — même famille de formule que itemSalvageValue/runeEnhanceCost.
// ×1.75 (retour joueur : pas assez cher) — même rapport entre raretés,
// juste un budget d'Essence plus consistant à chaque palier.
const AWAKEN_STAR_STAGE_FACTOR = { rare: 70, epic: 157, legendary: 315, mythic: 612 };
// Multiplicateur pour l'étoile N+1 — les 5 premiers paliers gardaient le même
// ratio (~×2.19) d'un cran à l'autre ; les 5 suivants prolongent cette même
// progression géométrique plutôt que d'inventer une nouvelle courbe.
const AWAKEN_STAR_GROWTH = [1, 2.2, 4.8, 10.5, 23, 50, 110, 241, 528, 1156];
function awakenStarCost(rarity, stars, bestStage = 1) {
  const s = Math.max(0, Math.min(AWAKEN_STAR_MAX - 1, Math.floor(stars || 0)));
  const factor = AWAKEN_STAR_STAGE_FACTOR[rarity] || AWAKEN_STAR_STAGE_FACTOR.rare;
  return Math.round(finiteIdleNumber(investmentCostIndex(Math.max(1, bestStage)) * factor * AWAKEN_STAR_GROWTH[s], 1));
}
function awakenStarMultiplier(stars) {
  return 1 + Math.max(0, Math.min(AWAKEN_STAR_MAX, Math.floor(stars || 0))) * AWAKEN_STAR_BONUS;
}

// ── Complétion de licence (façon Pokédex) : posséder TOUS les personnages
// d'une licence du catalogue donne +2% de production permanente par licence
// complétée. La collection devient un moteur de puissance, pas un simple
// écran cosmétique. Monotone : une licence qui « redevient incomplète »
// (import catalogue) ne retire jamais un bonus acquis.
const SERIES_COMPLETION_BONUS = 0.02;
const SERIES_COMPLETION_SEALS = 3; // récompense immédiate à la complétion
function completedSeriesMultiplier(count) {
  return 1 + Math.max(0, Math.floor(count || 0)) * SERIES_COMPLETION_BONUS;
}

// ── Mémoire du Maître (fast-start post-Prestige, façon rush de Clicker
// Heroes) : chaque nouvelle run démarre avec des niveaux gratuits de
// Discipline et de Concentration (2 par Prestige, plafonné à 10) — la reprise
// saute la phase la plus lente du début de partie, et chaque Retraite rend la
// suivante tangiblement plus rapide, sans multiplicateur caché.
const PRESTIGE_START_LEVELS_PER_PRESTIGE = 2;
const PRESTIGE_START_LEVELS_MAX = 10;
function prestigeStartingLevels(prestigeLevel) {
  return Math.min(PRESTIGE_START_LEVELS_MAX, Math.max(0, Math.floor(prestigeLevel || 0)) * PRESTIGE_START_LEVELS_PER_PRESTIGE);
}

// ── Orbes bonus : un orbe cliquable traverse la scène toutes les quelques
// minutes (équivalent golden cookie). Le serveur borne la fréquence
// (ORB_COOLDOWN_SECONDS) et paie ORB_PRODUCTION_SECONDS de production.
const ORB_COOLDOWN_SECONDS = 90;
const ORB_PRODUCTION_SECONDS = 45;
const ORB_MIN_REWARD = 10;
const ORB_SEAL_CHANCE = 0.05;
// Jackpot rare (façon golden cookie « Frenzy ») : même geste (cliquer l'orbe),
// mais un tirage serveur imprévisible paie ~4× plus de production d'un coup.
// Reste un simple multiplicateur ponctuel (pas un buff temporaire à suivre
// côté état) — un pic mémorable sans état supplémentaire à persister.
const ORB_JACKPOT_CHANCE = 0.08;
const ORB_JACKPOT_SECONDS = ORB_PRODUCTION_SECONDS * 4;
function orbReward(totalRate, jackpot = false) {
  const seconds = jackpot ? ORB_JACKPOT_SECONDS : ORB_PRODUCTION_SECONDS;
  return Math.max(ORB_MIN_REWARD, Math.round(finiteIdleNumber(Math.max(0, totalRate) * seconds)));
}

// ── Buffs temporaires d'orbe (« Frenzy » de Cookie Clicker, cette fois avec
// un vrai état à durée) : certains orbes n'offrent PAS de versement instantané
// mais un multiplicateur pendant quelques dizaines de secondes — c'est le
// moment d'adrénaline qui manquait au jeu actif. Un seul buff actif à la fois
// (User.idleBuffKey/idleBuffUntil) ; le serveur reste autoritaire sur le
// tirage et l'expiration.
const ORB_BUFF_CHANCE = 0.20; // tiré APRÈS le jackpot (donc ~18% effectif)
const ORB_BUFFS = {
  frenzy: { key: 'frenzy', label: 'Frénésie', description: 'Production ×2', seconds: 90, prod: 2, click: 1 },
  precision: { key: 'precision', label: 'Précision divine', description: 'Dégâts de clic ×3', seconds: 75, prod: 1, click: 3 },
};
function rollOrbBuff() {
  const keys = Object.keys(ORB_BUFFS);
  return ORB_BUFFS[keys[Math.floor(Math.random() * keys.length)]];
}
// Buff actif d'un utilisateur (ou null) — lit les colonnes User, vérifie
// l'expiration côté serveur à chaque calcul.
function activeOrbBuff(user, now = new Date()) {
  const buff = ORB_BUFFS[user?.idleBuffKey];
  if (!buff || !user?.idleBuffUntil) return null;
  const until = new Date(user.idleBuffUntil);
  if (until.getTime() <= now.getTime()) return null;
  return { ...buff, until };
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
  CLICK_RATE_SHARE,
  clickYield,
  clickUpgradeCost,
  CRIT_LEVEL_BONUS,
  CRIT_LEVEL_MAX,
  critUpgradeBonus,
  critUpgradeCost,
  MULTI_STRIKE_BONUS,
  MULTI_STRIKE_MAX,
  multiStrikeBonus,
  multiStrikeUpgradeCost,
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
  investmentCostIndex,
  RUNE_DUNGEON_FLOORS,
  runeDungeonRarity,
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
  stableCharacterHash,
  RARITY_PASSIVE_POOL,
  characterPassiveEntry,
  characterPassiveMagnitude,
  characterPassiveBonus,
  characterPassiveDescription,
  HERO_MILESTONES,
  HERO_ASCENSION_LEVEL,
  HERO_ASCENSION_LEVEL_STEP,
  HERO_ASCENSION_MAX,
  HERO_ASCENSION_GROWTH,
  HERO_ASCENSION_LEVEL_EQUIVALENT,
  heroAscensionRequiredLevel,
  heroAscensionMultiplier,
  heroAscensionCost,
  DOJO_XP_BASE,
  DOJO_XP_GROWTH,
  dojoXpForLevel,
  dojoLevelForXp,
  DOJO_LEVEL_BONUS,
  dojoLevelMultiplier,
  RANK_QUEST_POOL,
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
  wisdomForRunStage,
  RUN_BLESSINGS,
  RUN_AFFINITIES,
  parseRunBlessings,
  runBlessingEffects,
  runBlessingChoices,
  runBlessingRerollCost,
  ANCIENT_BASE_COST,
  ANCIENT_COST_GROWTH,
  ancientCost,
  ANCIENTS,
  ANCIENT_BRANCHES,
  ancientByKey,
  ancientBonus,
  ACHIEVEMENT_PROD_BONUS,
  achievementProdMultiplier,
  AWAKENED_CHANCE,
  AWAKENED_BONUS,
  AWAKEN_STAR_MAX,
  AWAKEN_STAR_BONUS,
  AWAKEN_STAR_STAGE_FACTOR,
  AWAKEN_STAR_GROWTH,
  awakenStarCost,
  awakenStarMultiplier,
  SERIES_COMPLETION_BONUS,
  SERIES_COMPLETION_SEALS,
  completedSeriesMultiplier,
  PRESTIGE_START_LEVELS_PER_PRESTIGE,
  PRESTIGE_START_LEVELS_MAX,
  prestigeStartingLevels,
  ORB_COOLDOWN_SECONDS,
  ORB_PRODUCTION_SECONDS,
  ORB_SEAL_CHANCE,
  ORB_JACKPOT_CHANCE,
  ORB_JACKPOT_SECONDS,
  ORB_BUFF_CHANCE,
  ORB_BUFFS,
  rollOrbBuff,
  activeOrbBuff,
  orbReward,
};
