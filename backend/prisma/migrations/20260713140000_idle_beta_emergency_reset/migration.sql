-- Remise à zéro d'urgence de la bêta Anime Ascension.
-- Migration séparée volontairement : elle s'exécute aussi si la migration de
-- refonte a déjà été appliquée avant l'apparition des erreurs 429/500.

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
  "idleEnemyHp" = 10,
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
