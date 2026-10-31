-- Hair style chosen at creation (shared/look.ts HAIR_STYLES); the dye stays in hair_color. (hair_style is the retired 3D-avatar column.)
ALTER TABLE characters ADD COLUMN hairdo int NOT NULL DEFAULT 0;
