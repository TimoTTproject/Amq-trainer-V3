-- Remise à zéro des stats globales de réussite : la copie initiale depuis
-- UserSongStat était structurellement biaisée (les modes d'entraînement
-- sélectionnent les musiques ratées → hits « difficiles », niches jouées par
-- leurs seuls fans → « faciles »). Les compteurs se remplissent désormais en
-- direct, uniquement sur les manches de jeu normales (solo non-entraînement
-- + multi) — cf. song-stats.js.
UPDATE "Song" SET "guessCount" = 0, "guessCorrect" = 0, "guessRate" = NULL;
