-- W01 r2: Hearthmoor is rebuilt as a walled town of 57x57 cells (buildings, a fountain plaza; shared/town.ts) and the four fields
-- grew from 72-76 to 104-108 cells with their old content anchored to their gates (shared/maps.ts FIELD_THEMES).
-- Town: every position there moves to the plaza (TOWN_START, inside Guide Lio's greeting area) and every town save point to the
-- hearth (TOWN_SAVE, Hearthkeeper Bren's chapel); the old cells now lie inside buildings or walls.
-- Fields: a position moves with its field's content (plains +32,+16, woods +0,+16, highlands +16,+32, mire +16,+0); the ground
-- itself was regenerated, so the server's login fallback (nearestWalkable) takes anyone now standing in water or a thicket.
UPDATE characters SET x = 24, y = 31 WHERE last_map = 'f1_town01';
UPDATE characters SET save_x = 22, save_y = 22 WHERE save_map = 'f1_town01';
UPDATE characters SET x = x + 32, y = y + 16 WHERE last_map = 'f1_field01';
UPDATE characters SET y = y + 16 WHERE last_map = 'f1_field02';
UPDATE characters SET x = x + 16, y = y + 32 WHERE last_map = 'f1_field03';
UPDATE characters SET x = x + 16 WHERE last_map = 'f1_field04';
UPDATE characters SET save_x = save_x + 32, save_y = save_y + 16 WHERE save_map = 'f1_field01';
UPDATE characters SET save_y = save_y + 16 WHERE save_map = 'f1_field02';
UPDATE characters SET save_x = save_x + 16, save_y = save_y + 32 WHERE save_map = 'f1_field03';
UPDATE characters SET save_x = save_x + 16 WHERE save_map = 'f1_field04';
