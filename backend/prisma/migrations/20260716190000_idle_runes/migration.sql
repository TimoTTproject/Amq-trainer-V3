ALTER TABLE "IdleItem"
  ADD COLUMN "enhancementLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "setKey" TEXT NOT NULL DEFAULT 'energy',
  ADD COLUMN "mainStat" TEXT NOT NULL DEFAULT 'dps',
  ADD COLUMN "subStats" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Les objets bêta deviennent les trois premières runes sans perte de bonus,
-- de rareté, de verrouillage ou d'affectation.
UPDATE "IdleItem"
SET "kind" = CASE "kind"
  WHEN 'weapon' THEN 'rune1'
  WHEN 'relic' THEN 'rune2'
  WHEN 'accessory' THEN 'rune3'
  ELSE "kind"
END;

UPDATE "IdleItem"
SET
  "enhancementLevel" = LEAST(15, GREATEST(0, ROUND("bonus" * 100)::INTEGER)),
  "setKey" = CASE "effectKey"
    WHEN 'precision' THEN 'blade'
    WHEN 'overdrive' THEN 'rage'
    WHEN 'resonance' THEN 'unity'
    WHEN 'focus' THEN 'hunter'
    WHEN 'salvage' THEN 'fortune'
    ELSE 'energy'
  END,
  "mainStat" = CASE
    WHEN "effectKey" = 'precision' THEN 'click'
    WHEN "effectKey" = 'overdrive' THEN 'burst'
    WHEN "effectKey" = 'resonance' THEN 'team'
    WHEN "effectKey" = 'focus' THEN 'boss'
    WHEN "effectKey" = 'salvage' THEN 'salvage'
    ELSE 'dps'
  END;
