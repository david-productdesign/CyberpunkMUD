-- Mutable state (players, items) and seeded static content (rooms, item_protos)
-- share one database. Re-running the schema is safe.

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  name          TEXT UNIQUE COLLATE NOCASE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  body          INTEGER NOT NULL DEFAULT 5,
  reflex        INTEGER NOT NULL DEFAULT 5,
  intellect     INTEGER NOT NULL DEFAULT 5,
  cool          INTEGER NOT NULL DEFAULT 5,
  hp            INTEGER NOT NULL DEFAULT 30,
  max_hp        INTEGER NOT NULL DEFAULT 30,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  area        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  exits       TEXT NOT NULL DEFAULT '{}'   -- JSON: {"north": "s7-noodle"}
);

CREATE TABLE IF NOT EXISTS item_protos (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,   -- "a carton of cold ramen"
  keywords    TEXT NOT NULL,   -- "ramen carton noodles"
  room_desc   TEXT NOT NULL,   -- the line shown when it lies on the ground
  description TEXT NOT NULL,   -- shown by `examine`
  portable    INTEGER NOT NULL DEFAULT 1
);

-- One row per physical object in the world. `location` is 'room:<id>' or
-- 'player:<id>', which keeps take/drop to a single indexed UPDATE.
-- `spawn_key` is set only on seeded objects so re-seeding cannot duplicate them.
CREATE TABLE IF NOT EXISTS items (
  id        INTEGER PRIMARY KEY,
  proto_id  TEXT NOT NULL REFERENCES item_protos(id),
  location  TEXT NOT NULL,
  spawn_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_items_location ON items(location);

-- Armed laser trips. One per room, and one per owner: arming a new trip
-- replaces the owner's old one. A trip is deleted when it goes off.
CREATE TABLE IF NOT EXISTS trips (
  room_id  TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL UNIQUE REFERENCES players(id),
  set_at   INTEGER NOT NULL
);
