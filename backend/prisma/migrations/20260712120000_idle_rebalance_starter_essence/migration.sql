-- Dojo : rééquilibrage du démarrage. 20 d'essence offerte (au lieu de 0) pour
-- épargner ~10 clics à vide avant le premier recrutement. Les taux de
-- production/XP eux-mêmes sont dans le code (src/idle/idle.js), pas en base.
ALTER TABLE "User" ALTER COLUMN "essence" SET DEFAULT 20;

-- Comptes de test qui n'ont jamais vraiment joué (aucune essence gagnée à
-- vie) : leur offre le même départ que les futurs comptes, sans toucher à
-- ceux qui ont déjà une progression (même si elle est actuellement à 0).
UPDATE "User" SET "essence" = 20 WHERE "essence" = 0 AND "essenceEarnedTotal" = 0;
