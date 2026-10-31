-- F05: a character's shortcut bar is seeded once with what it owns and can use (shared/rules/hotkey.ts seedHotkeys): the
-- starter consumables, the sit action and the gear swaps. The flag keeps a player who later empties a slot from having it
-- refilled. Characters made before this migration are seeded on their next login (only their empty slots are touched).
ALTER TABLE characters ADD COLUMN hotkeys_seeded boolean NOT NULL DEFAULT false;
