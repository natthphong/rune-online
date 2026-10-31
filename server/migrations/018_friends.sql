-- 2.3.0: friend list, like rAthena's char_friends (sql-files/main.sql): one row per side (A lists B, B lists A), MAX_FRIENDS 40
-- (enforced by server/src/friends.ts). seq keeps the list in the order the friends were added.
CREATE TABLE friends (
  char_id   int    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  friend_id int    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  seq       bigserial,
  PRIMARY KEY (char_id, friend_id)
);
