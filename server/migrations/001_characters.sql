CREATE TABLE characters (
  name       text PRIMARY KEY,
  x          int NOT NULL,
  y          int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at    timestamptz NOT NULL DEFAULT now()
);
