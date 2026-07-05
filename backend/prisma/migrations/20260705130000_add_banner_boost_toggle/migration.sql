-- Préférence joueur : utiliser ou non le rate-up de la bannière vedette en cours.
ALTER TABLE "User" ADD COLUMN "bannerBoostEnabled" BOOLEAN NOT NULL DEFAULT true;
