-- Statistiques GLOBALES de réussite par musique (tous joueurs confondus) :
-- alimentées à chaque réponse (solo + multi) et backfillées une fois depuis
-- l'historique UserSongStat. guessRate = % de bonnes réponses (0-100), NULL
-- tant que l'échantillon est trop petit pour être significatif.
ALTER TABLE "Song" ADD COLUMN "guessCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Song" ADD COLUMN "guessCorrect" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Song" ADD COLUMN "guessRate" INTEGER;
