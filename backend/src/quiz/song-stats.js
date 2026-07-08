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

// Backfill one-shot depuis l'historique UserSongStat : copie playCount/
// correctCount agrégés vers les compteurs globaux des musiques encore à zéro.
// Idempotent : une musique déjà comptée (guessCount > 0) n'est jamais retouchée,
// les réponses en direct s'ajoutent ensuite par-dessus.
async function backfillGuessStats() {
  const [aggregates, empty] = await Promise.all([
    prisma.userSongStat.groupBy({
      by: ['songId'],
      _sum: { playCount: true, correctCount: true },
      having: { playCount: { _sum: { gt: 0 } } },
    }),
    prisma.song.findMany({ where: { guessCount: 0 }, select: { id: true } }),
  ]);
  const emptyIds = new Set(empty.map((s) => s.id));
  let updated = 0;
  for (const row of aggregates) {
    if (!emptyIds.has(row.songId)) continue;
    const count = row._sum.playCount || 0;
    const correct = row._sum.correctCount || 0;
    // guessCount: 0 en garde-fou : si une réponse en direct est arrivée entre
    // la lecture et l'écriture, on ne l'écrase pas.
    const res = await prisma.song.updateMany({
      where: { id: row.songId, guessCount: 0 },
      data: { guessCount: count, guessCorrect: correct, guessRate: computeRate(count, correct) },
    });
    updated += res.count;
  }
  return { updated };
}

module.exports = { MIN_GUESS_SAMPLE, recordGlobalGuess, backfillGuessStats };
