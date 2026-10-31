-- MVP2: accounts + up to 9 character slots per account (rAthena: login-server account, char-server slots).
CREATE TABLE accounts (
  id         serial PRIMARY KEY,
  username   text NOT NULL UNIQUE,          -- stored lowercase
  pass_hash  text NOT NULL,                 -- scrypt$N$r$p$salt$hash (base64)
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login timestamptz
);

ALTER TABLE characters
  ADD COLUMN id         serial UNIQUE,
  ADD COLUMN account_id int REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN slot       int,
  ADD COLUMN gender     char(1) NOT NULL DEFAULT 'M',
  ADD COLUMN hair_style int NOT NULL DEFAULT 0,
  ADD COLUMN hair_color int NOT NULL DEFAULT 0,
  ADD CONSTRAINT characters_slot_range CHECK (slot BETWEEN 0 AND 8),
  ADD CONSTRAINT characters_account_slot UNIQUE (account_id, slot);

-- characters created before accounts existed (dev/test only) have no owner and can't be selected
