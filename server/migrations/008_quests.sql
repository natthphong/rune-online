-- C01/C02: quest log + permanent character variables, like rAthena's `quest` and `char_reg_num` tables (sql-files/main.sql).
-- quest.state: 0 inactive, 1 active, 2 complete (e_quest_state); time: expiry in unix seconds, 0 = no limit;
-- count1..3: kill counters per objective (MAX_QUEST_OBJECTIVES 3). Written through on every change (server/src/quests.ts).
CREATE TABLE quest (
  char_id  int      NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  quest_id int      NOT NULL,
  state    smallint NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 2),
  time     bigint   NOT NULL DEFAULT 0,
  count1   int      NOT NULL DEFAULT 0,
  count2   int      NOT NULL DEFAULT 0,
  count3   int      NOT NULL DEFAULT 0,
  PRIMARY KEY (char_id, quest_id)
);

-- Permanent character variables set by NPC scripts (`set f1_guide, 1`); a variable set to 0 has no row.
CREATE TABLE char_reg_num (
  char_id int    NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  "key"   text   NOT NULL,
  "index" int    NOT NULL DEFAULT 0,
  value   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (char_id, "key", "index")
);
