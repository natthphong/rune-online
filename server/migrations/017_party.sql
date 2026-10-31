-- 2.3.0: parties, like rAthena's `party` table (sql-files/main.sql: party_id, name, exp, item, leader_id, leader_char) with the
-- membership in its own table instead of `char.party_id` (MAX_PARTY 12 is enforced by server/src/party.ts).
-- exp_share / item_share: 0 = each take their own, 1 = even share (party.exp / party.item & 2). The leader is a character: deleting
-- it deletes the party, like a leader leaving breaks the party (int_party.cpp mapif_parse_PartyLeave).
CREATE TABLE party (
  id         serial   PRIMARY KEY,
  name       text     NOT NULL,
  exp_share  smallint NOT NULL DEFAULT 0 CHECK (exp_share IN (0, 1)),
  item_share smallint NOT NULL DEFAULT 0 CHECK (item_share IN (0, 1)),
  leader_id  int      NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX party_name_unique ON party (lower(name));

CREATE TABLE party_member (
  party_id  int NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  char_id   int NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, char_id)
);
