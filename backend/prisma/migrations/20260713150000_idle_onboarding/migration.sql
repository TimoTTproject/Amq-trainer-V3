-- Tous les comptes passent par le choix initial au prochain lancement Idle.
ALTER TABLE "User" ADD COLUMN "idleOnboardingComplete" BOOLEAN NOT NULL DEFAULT FALSE;
