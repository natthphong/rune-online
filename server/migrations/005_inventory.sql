-- MVP3: inventory (one row per stack / per equipment piece), zeny, hotkeys, starter kit flag.
ALTER TABLE characters
  ADD COLUMN zeny      bigint  NOT NULL DEFAULT 0,
  ADD COLUMN hotkeys   jsonb   NOT NULL DEFAULT '[]',
  ADD COLUMN kit_given boolean NOT NULL DEFAULT false;

CREATE TABLE inventory (
  uid     bigserial PRIMARY KEY,
  char_id int  NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  item_id int  NOT NULL,
  amount  int  NOT NULL CHECK (amount > 0),
  equip   text,                 -- primary slot when worn (shared/rules/items.ts SLOTS), NULL in the bag
  refine  int  NOT NULL DEFAULT 0
);
CREATE INDEX inventory_char ON inventory (char_id);
