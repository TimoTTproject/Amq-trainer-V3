-- Répare les objets rétrogradés par l'ancienne amélioration. Le nom de butin
-- conserve l'adjectif de la rareté obtenue à l'ouverture du coffre.
UPDATE "IdleItem" SET "rarity" = 'epic'
WHERE "rarity" = 'rare' AND "name" LIKE '% · Héroïque';

UPDATE "IdleItem" SET "rarity" = 'legendary'
WHERE "rarity" IN ('rare', 'epic') AND "name" LIKE '% · Légendaire';

UPDATE "IdleItem" SET "rarity" = 'mythic'
WHERE "rarity" IN ('rare', 'epic', 'legendary') AND "name" LIKE '% · Transcendant';
