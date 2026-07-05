-- Distingue les exemplaires obtenus par tirage ("pull", défaut) de ceux
-- fabriqués en poussière ("craft") — sert à n'autoriser le craft d'un
-- personnage que s'il a déjà été tiré au moins une fois.
ALTER TABLE "CardInstance" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'pull';
