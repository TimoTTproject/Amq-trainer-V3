-- Le roster du Dojo commence dÃ©sormais Ã  Rare. La collection gacha reste intacte.
UPDATE "IdleSlot" AS slot
SET "characterId" = NULL, "assignedAt" = NULL, "level" = 1
FROM "Character" AS character
WHERE slot."characterId" = character."id"
  AND character."rarity" = 'common';

DELETE FROM "DojoRecruit" AS recruit
USING "Character" AS character
WHERE recruit."characterId" = character."id"
  AND character."rarity" = 'common';
