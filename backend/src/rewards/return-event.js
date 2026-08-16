// Événement Anime Ascension 2.0 : les boucles quotidiennes rapportent double.
// Centralisé ici pour aligner affichage, crédit et historique des transactions.
const RETURN_REWARD_MULTIPLIER = 2;
const RETURN_REWARD_LABEL = 'BOOST RETOUR 2.0';

function boostReturnReward(amount) {
  return Math.max(0, Math.round((Number(amount) || 0) * RETURN_REWARD_MULTIPLIER));
}

function returnRewardEvent() {
  return { active: true, multiplier: RETURN_REWARD_MULTIPLIER, label: RETURN_REWARD_LABEL };
}

module.exports = { RETURN_REWARD_MULTIPLIER, RETURN_REWARD_LABEL, boostReturnReward, returnRewardEvent };
