-- Le mode Farm pouvait être activé sans avertissement et persistait après
-- actualisation. Les comptes concernés repartent une fois en progression ;
-- ils pourront ensuite réactiver explicitement la répétition d'une vague.
UPDATE "User"
SET "idleBattleMode" = 'progress'
WHERE "idleBattleMode" = 'farm';
