// Clé de semaine : le lundi (UTC) de la semaine d'une date, au format AAAA-MM-JJ.
// Sert au classement coop hebdomadaire (regroupe les scores par semaine).
function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lundi … 6 = dimanche
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Clé de la semaine précédente (pour la distribution des récompenses).
function previousWeekKey(date = new Date()) {
  return weekKey(new Date(date.getTime() - 7 * 86400000));
}

module.exports = { weekKey, previousWeekKey };
