-- C08: the character's map and save point, like rAthena's `char` table (last_map/last_x/last_y, save_map/save_x/save_y).
-- x / y already hold the last position; save_map NULL = the default respawn (the field's centre, start_point in char_athena.conf).
ALTER TABLE characters ADD COLUMN last_map text NOT NULL DEFAULT 'f1_field01';
ALTER TABLE characters ADD COLUMN save_map text;
ALTER TABLE characters ADD COLUMN save_x int;
ALTER TABLE characters ADD COLUMN save_y int;
