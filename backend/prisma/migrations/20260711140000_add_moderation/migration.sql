-- Modération : bannissement de compte (bannedAt — connexion refusée HTTP et
-- socket tant que posé) et sourdine du chat multi (mutedUntil).
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "mutedUntil" TIMESTAMP(3);
