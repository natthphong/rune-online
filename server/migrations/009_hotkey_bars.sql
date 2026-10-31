-- F05: the shortcut window's four bars. characters.hotkeys (jsonb, 005) now holds MAX_HOTKEYS = 38 entries — 9 x 4 bars +
-- 2 quickslots (rAthena mmo.hpp, shared/rules/hotkey.ts) — instead of 9; old 9-entry lists load as bar 1. hotkey_rowshift is
-- the bar rotation picked with the window's up/down arrows, kept per character like rAthena's char.hotkey_rowshift
-- (clif_parse_HotkeyRowShift, char.cpp:314).
UPDATE characters SET hotkeys = '[]' WHERE jsonb_typeof(hotkeys) <> 'array';
ALTER TABLE characters
  ADD COLUMN hotkey_rowshift smallint NOT NULL DEFAULT 0 CHECK (hotkey_rowshift BETWEEN 0 AND 3),
  ADD CONSTRAINT characters_hotkeys_max CHECK (jsonb_typeof(hotkeys) = 'array' AND jsonb_array_length(hotkeys) <= 38);
