-- Dojo v3 : jalons réclamables (coffres tous les N niveaux de Dojo) et
-- Prestige (reset de la run contre un bonus de production permanent).
ALTER TABLE "User" ADD COLUMN "idleMilestoneClaimed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "prestigeLevel" INTEGER NOT NULL DEFAULT 0;
