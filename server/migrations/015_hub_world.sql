-- W01: floor 1 becomes a hub world. Hearthmoor (f1_town01) is the centre with a gate on each side; the old single field
-- f1_field01 is now the west field and was regenerated (themed generator), so saved field positions mean nothing any more.
-- Every character moves to Hearthmoor's plaza (shared/maps.ts TOWN_START, inside Guide Lio's greeting area) with the town's
-- hearth as save point (TOWN_SAVE, Hearthkeeper Bren); level, items, skills, quests and variables are untouched.
UPDATE characters SET last_map = 'f1_town01', x = 17, y = 22, save_map = 'f1_town01', save_x = 20, save_y = 23;
ALTER TABLE characters ALTER COLUMN last_map SET DEFAULT 'f1_town01';
