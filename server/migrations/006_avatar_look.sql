-- Players are 3D modular avatars now: a head + base clothes chosen at creation (shared/look.ts HEADS / CLOTHES).
-- Old sprite looks (gender/hair) map onto the closest head; hair_* columns stay for history but are unused.
ALTER TABLE characters
  ADD COLUMN head    text NOT NULL DEFAULT 'Rogue',
  ADD COLUMN clothes text NOT NULL DEFAULT 'Rogue';
UPDATE characters SET head = CASE
  WHEN gender = 'F' AND hair_style = 3 THEN 'Rogue_Hooded'
  WHEN gender = 'F' THEN 'Rogue'
  WHEN hair_style = 1 THEN 'Mage'
  WHEN hair_style = 2 THEN 'Barbarian'
  ELSE 'Knight' END;
