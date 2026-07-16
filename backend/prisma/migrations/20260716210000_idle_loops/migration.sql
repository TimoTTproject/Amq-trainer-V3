-- Boucles de jeu du Dojo :
-- - buff temporaire d'orbe (« Frenzy ») : clé + expiration ;
-- - licences complétées : compteur monotone du bonus permanent de collection ;
-- - étoiles d'Éveil : investissement permanent par héros, payé en Sceaux ;
-- - suppression des Voies de Prestige (multiplicateur plat redondant avec
--   classes + bénédictions + Ancients) ;
-- - suppression de l'ancien modèle IdleEquipment (remplacé par IdleItem).
ALTER TABLE "User"
  ADD COLUMN "idleBuffKey" TEXT,
  ADD COLUMN "idleBuffUntil" TIMESTAMP(3),
  ADD COLUMN "idleCompletedSeries" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User" DROP COLUMN "idlePrestigePath";

ALTER TABLE "DojoRecruit"
  ADD COLUMN "awakenStars" INTEGER NOT NULL DEFAULT 0;

DROP TABLE IF EXISTS "IdleEquipment";
