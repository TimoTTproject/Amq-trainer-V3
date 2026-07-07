-- Dernière connexion (présence socket) pour l'annuaire des joueurs,
-- affiché en "vu il y a X" / "En ligne" et trié par activité récente.
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
