ALTER TABLE "User"
  ADD COLUMN "idleRankLevel" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idleRankKills" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleRankClicks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleRankUpgrades" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleRankBosses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleRankStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Préserve le niveau affiché des bêta-testeurs existants lors du passage de
-- l'ancienne courbe d'Essence au nouveau système d'épreuves.
UPDATE "User"
SET "idleRankLevel" = GREATEST(
  1,
  FLOOR(1 + LN(1 + GREATEST(0, "essenceEarnedTotal") * 0.4 / 100) / LN(1.4))::INTEGER
);
