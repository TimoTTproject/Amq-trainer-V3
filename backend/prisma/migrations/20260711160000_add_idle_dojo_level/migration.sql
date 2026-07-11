-- Dojo v2 : le lieu progresse (niveau dérivé de l'essence gagnée à vie → décor)
-- et chaque personnage assigné a son propre niveau d'entraînement illimité.
ALTER TABLE "User" ADD COLUMN "essenceEarnedTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IdleSlot" ADD COLUMN "level" INTEGER NOT NULL DEFAULT 1;
