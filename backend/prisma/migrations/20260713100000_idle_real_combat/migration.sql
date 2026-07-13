-- Anime Ascension est encore réservé aux administrateurs et ses données
-- bêta seront remises à zéro avant ouverture publique.
ALTER TABLE "User"
  ALTER COLUMN "essence" TYPE DOUBLE PRECISION USING "essence"::double precision,
  ALTER COLUMN "essenceEarnedTotal" TYPE DOUBLE PRECISION USING "essenceEarnedTotal"::double precision,
  ADD COLUMN "idleRunEssenceEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "idleStage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idleRunBestStage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idleBestStage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idleEnemyHp" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "idleHeroClassChangedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "idleRecruitPity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DojoRecruit"
  ADD COLUMN "trainingLevel" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "idleAscension" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "IdleTelemetry" (
  "id" SERIAL NOT NULL,
  "userId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "value" DOUBLE PRECISION,
  "stage" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdleTelemetry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IdleTelemetry_event_createdAt_idx" ON "IdleTelemetry"("event", "createdAt");
CREATE INDEX "IdleTelemetry_userId_createdAt_idx" ON "IdleTelemetry"("userId", "createdAt");
ALTER TABLE "IdleTelemetry" ADD CONSTRAINT "IdleTelemetry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reset explicite des données de test Idle uniquement. DojoBossArt est conservé :
-- il contient des assets globaux générés, pas la progression d'un joueur.
DELETE FROM "IdleMissionClaim";
DELETE FROM "IdleEquipment";
DELETE FROM "IdleSlot";
DELETE FROM "DojoRecruit";
DELETE FROM "AncientLevel";
DELETE FROM "IdleTelemetry";

UPDATE "User" SET
  "essence" = 20,
  "idleLastCollectAt" = CURRENT_TIMESTAMP,
  "idleSlotsUnlocked" = 3,
  "idleProdLevel" = 0,
  "idleClickLevel" = 0,
  "essenceEarnedTotal" = 0,
  "idleRunEssenceEarned" = 0,
  "idleStage" = 1,
  "idleRunBestStage" = 1,
  "idleBestStage" = 1,
  "idleEnemyHp" = 0,
  "idleMilestoneClaimed" = 0,
  "idleBossClaimed" = 0,
  "idleHeroClass" = 'warrior',
  "idleHeroClassChangedAt" = NULL,
  "idleHeroAura" = 'none',
  "idleHeroStance" = 'balanced',
  "idleHeroTitle" = 'rookie',
  "idleHeroHair" = 'short',
  "idleHeroOutfit" = 'dojo',
  "idleHeroColor" = 'red',
  "idleHeroSpec" = 'none',
  "idleBattleSpeed" = 1,
  "idleBattleMode" = 'progress',
  "idleAutoSkills" = FALSE,
  "idleRecruitPity" = 0,
  "prestigeLevel" = 0,
  "wisdomPoints" = 0;
