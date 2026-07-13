-- Le prix alternatif en Essence ne dépend plus du roster total : une
-- invocation payée avec un Sceau ne doit jamais le faire augmenter.
ALTER TABLE "User"
  ADD COLUMN "idleEssenceRecruitCount" INTEGER NOT NULL DEFAULT 0;
