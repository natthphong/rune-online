-- C11: cards compounded into slotted equipment. rAthena keeps them in the inventory row (inventory.card0..card3, sql-files/main.sql,
-- MAX_SLOTS 4): the item id of the card in each slot, 0 = empty. The first free slot is filled (pc_insert_card); nothing removes one.
ALTER TABLE inventory
  ADD COLUMN card0 int NOT NULL DEFAULT 0,
  ADD COLUMN card1 int NOT NULL DEFAULT 0,
  ADD COLUMN card2 int NOT NULL DEFAULT 0,
  ADD COLUMN card3 int NOT NULL DEFAULT 0;
