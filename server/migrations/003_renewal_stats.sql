-- MVP1: rAthena Renewal character model. Earlier test characters restart at Lv1 with the 48 starting stat points.
ALTER TABLE characters
  ADD COLUMN job          text NOT NULL DEFAULT 'Novice',
  ADD COLUMN job_level    int  NOT NULL DEFAULT 1,
  ADD COLUMN job_exp      int  NOT NULL DEFAULT 0,
  ADD COLUMN str          int  NOT NULL DEFAULT 1,
  ADD COLUMN agi          int  NOT NULL DEFAULT 1,
  ADD COLUMN vit          int  NOT NULL DEFAULT 1,
  ADD COLUMN "int"        int  NOT NULL DEFAULT 1,
  ADD COLUMN dex          int  NOT NULL DEFAULT 1,
  ADD COLUMN luk          int  NOT NULL DEFAULT 1,
  ADD COLUMN stat_points  int  NOT NULL DEFAULT 48,
  ADD COLUMN skill_points int  NOT NULL DEFAULT 0,
  ADD COLUMN hp           int,
  ADD COLUMN sp           int;
UPDATE characters SET level = 1, exp = 0;
