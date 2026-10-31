-- C04: learned skills, like rAthena's `skill` table (sql-files/main.sql: char_id, id, lv, flag): one row per learned skill
-- (flag is always SKILL_FLAG_PERMANENT here, so it is not stored). Written through on every skill point (server/src/skills.ts).
CREATE TABLE skill (
  char_id int      NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  id      int      NOT NULL,
  lv      smallint NOT NULL CHECK (lv > 0),
  PRIMARY KEY (char_id, id)
);
