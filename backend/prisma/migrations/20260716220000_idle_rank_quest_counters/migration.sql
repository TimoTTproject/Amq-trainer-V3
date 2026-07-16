-- Compteurs additionnels pour diversifier les épreuves de rang (voir
-- rankQuestSeries) : compétences actives utilisées et héros recrutés,
-- remis à zéro à chaque passage de niveau comme les compteurs existants.
ALTER TABLE "User"
  ADD COLUMN "idleRankSkills" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleRankRecruits" INTEGER NOT NULL DEFAULT 0;
