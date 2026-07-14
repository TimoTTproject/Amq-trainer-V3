-- Deux nouvelles améliorations temporaires de la run : chance critique et
-- réduction des recharges des compétences actives. Elles sont remises à zéro
-- par le Prestige, comme Discipline et Concentration.
ALTER TABLE "User"
  ADD COLUMN "idleCritLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "idleCooldownLevel" INTEGER NOT NULL DEFAULT 0;
