-- 2.4.0: pets, like rAthena's `pet` table (sql-files/main.sql): one row per pet, owned by a character. incubate = it is in its egg
-- (pet_return_egg) or not hatched yet; a hatched pet (incubate false) is the character's pet out (sd->status.pet_id), which comes back
-- out at login and follows across maps. The egg is an inventory row that points at its pet (rAthena keeps the pet id in the egg's
-- card1/card2 with card0 = CARD0_PET; we give the row its own column). A pet that runs away (intimacy 0) loses its row and its egg.
CREATE TABLE pet (
  id        serial  PRIMARY KEY,
  char_id   int     NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  mob_id    int     NOT NULL,
  name      text    NOT NULL,
  renamed   boolean NOT NULL DEFAULT false,
  level     int     NOT NULL DEFAULT 1,
  hunger    int     NOT NULL DEFAULT 100,
  intimacy  int     NOT NULL DEFAULT 250,
  equip     int     NOT NULL DEFAULT 0,
  autofeed  boolean NOT NULL DEFAULT false,
  incubate  boolean NOT NULL DEFAULT true
);
CREATE INDEX pet_char ON pet (char_id);
ALTER TABLE inventory ADD COLUMN pet_id int;
