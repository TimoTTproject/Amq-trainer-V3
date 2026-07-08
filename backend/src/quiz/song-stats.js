// Difficulté RÉELLE par musique : % de bonnes réponses tous joueurs confondus
// (Song.guessCount/guessCorrect/guessRate), alimenté à chaque réponse solo et
// multi. Sert au badge « trouvé par X% des joueurs » à la révélation et au
// filtre de difficulté (avec repli sur la popularité AniList tant que
// l'échantillon est insuffisant, cf. filters.js).
const { prisma } = require('../db');

// En dessous de ce nombre de réponses, le taux n'est pas significatif :
// guessRate reste null et le filtre de difficulté se rabat sur la popularité.
const MIN_GUESS_SAMPLE = 10;

function computeRate(count, correct) {
  return count >= MIN_GUESS_SAMPLE ? Math.round((correct / count) * 100) : null;
}

// Enregistre une réponse (bonne ou non) dans les stats globales de la musique.
// Appelé en fire-and-forget après la validation : un échec ici ne doit jamais
// faire échouer la manche du joueur.
async function recordGlobalGuess(songId, correct) {
  try {
    const song = await prisma.song.update({
      where: { id: songId },
      data: { guessCount: { increment: 1 }, ...(correct ? { guessCorrect: { increment: 1 } } : {}) },
      select: { guessCount: true, guessCorrect: true, guessRate: true },
    });
    const guessRate = computeRate(song.guessCount, song.guessCorrect);
    if (guessRate !== song.guessRate) {
      await prisma.song.update({ where: { id: songId }, data: { guessRate } });
    }
  } catch (e) {
    console.warn('song-stats record error:', e && e.message);
  }
}

// PAS de backfill depuis UserSongStat : l'historique est structurellement
// biaisé — les modes d'entraînement (« À revoir », « Ratés », répétition
// espacée) SÉLECTIONNENT les musiques que le joueur rate, donc leurs stats
// sont gorgées d'échecs (un hit très joué en révision paraîtrait « difficile »
// alors qu'un anime de niche joué par ses seuls fans paraîtrait « facile »).
// Les compteurs ne s'alimentent qu'en direct, sur les manches de JEU (solo
// normal + multi), jamais en entraînement — cf. les appelants.
module.exports = { MIN_GUESS_SAMPLE, recordGlobalGuess };
