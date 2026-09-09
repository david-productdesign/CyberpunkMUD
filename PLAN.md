# CyberpunkMUD — Milestone 1

## Context

The repo is empty (a README holding `v26.8.1`). We're building a Multi-User Dungeon from
scratch: a telnet server where several people connect at once, share a persistent world, and
see each other move and talk.

Milestone 1 is the smallest thing that is genuinely a MUD and genuinely multiplayer: connect
over telnet, create or log into a character, walk a small hand-written cyberpunk district,
look at things, talk, and pick objects up and put them down — with other players' arrivals,
departures, speech, and item-handling visible in the room. Combat, NPCs, skills and cyberware
come later; M1 exists to prove the connection layer, the command loop, the room broadcast
model, and persistence all work together.

Decisions already made: **telnet** (raw TCP), **SQLite** via `node:sqlite`, and a sketched
starting district (Sector 7, Kowloon Vertical) that you can rewrite freely.

### Assumptions worth flagging

- **World content is authored as JSON, then seeded into SQLite.** Hand-writing rooms as SQL
  `INSERT`s is miserable. `world/*.json` is the editable source of truth for static content;
  `node seed.js` loads it into the `rooms` / `item_protos` tables. SQLite remains the single
  store the running server reads and writes. Re-seeding never touches player data.
- **Telnet sends passwords in cleartext.** That is inherent to the protocol, not a bug we can
  fix. The server binds to `127.0.0.1` by default (`HOST` env var to override) and passwords
  are stored `scrypt`-hashed, but treat this as a local/LAN toy until there's a TLS or SSH
  front end. Worth a line in the README.
- **Zero dependencies.** `node:net`, `node:sqlite`, `node:crypto`, `node:test` cover
  everything. No `package.json` dependencies, no build step.

## Architecture

Plain ES modules, small functions, no classes. A session is a plain object; the world is a
plain object graph; commands are entries in a lookup table.

```
server.js              entry: open db, load world, listen
src/
  net/
    listener.js        net.createServer, socket lifecycle, session registry
    session.js         per-socket line buffering, write helpers, prompt
    telnet.js          strip IAC sequences; WILL/WONT ECHO for password entry
    ansi.js            color helpers (cyan rooms, yellow items, dim exits)
  game/
    login.js           name -> password | create-character state machine
    dispatch.js        command table + prefix matching + argument split
    world.js           build in-memory room/proto index from db at boot
    room.js            describe a room; who and what is in it
    move.js            movement + arrival/departure broadcasts
    comm.js            say, emote, who
    items.js           take, drop, inventory, examine
    broadcast.js       send to a room, to everyone, excluding a session
  db/
    schema.sql         table definitions
    db.js              open DatabaseSync, prepared statements
    players.js         find/create/save a player row
    auth.js            scrypt hash + timing-safe verify
world/
  sector7.json         rooms
  items.json           item prototypes and their starting locations
seed.js                load world/*.json into the db (idempotent)
test/
  smoke.test.js        drives two scripted telnet clients, asserts they see each other
```

Every file stays well under 300 lines; `dispatch.js` and `items.js` are the largest.

## Data model

Static content (`rooms`, `item_protos`) is seeded and read-mostly — loaded into memory at boot
for fast lookup. Mutable state (`players`, `items`) is written through to SQLite as it changes.

```sql
CREATE TABLE players (
  id            INTEGER PRIMARY KEY,
  name          TEXT UNIQUE COLLATE NOCASE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  body INT, reflex INT, intellect INT, cool INT,   -- BODY / REFLEX / INT / COOL
  hp INT, max_hp INT,
  created_at INT, last_seen_at INT
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY, area TEXT,
  name TEXT, description TEXT,
  exits TEXT                                        -- JSON: {"north":"s7-noodle"}
);

CREATE TABLE item_protos (
  id TEXT PRIMARY KEY,
  name TEXT,            -- "a carton of cold ramen"
  keywords TEXT,        -- "ramen carton noodles"
  room_desc TEXT,       -- line shown when it lies on the ground
  description TEXT,     -- shown by `examine`
  portable INT          -- 0 = scenery, cannot be taken
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  proto_id TEXT NOT NULL REFERENCES item_protos(id),
  location TEXT NOT NULL   -- 'room:s7-alley' or 'player:3'
);
CREATE INDEX idx_items_location ON items(location);
```

The `location` string is the trick that keeps `take` and `drop` to a single `UPDATE` each and
makes "what's in this room / in my pack" one indexed `SELECT`. Stat columns exist now so
Milestone 3 doesn't need a migration.

## How it works

**Connection.** `net.createServer` per socket → a session object:
`{ id, socket, buffer, state, playerId, name, roomId }`, held in a `Map` keyed by session id.
Incoming chunks append to `buffer`; complete lines (split on `\n`, `\r` stripped, telnet IAC
sequences removed by `telnet.js`) are dispatched one at a time. Sockets get an idle timeout.

**Login.** `session.state` walks `'name' → 'password'` for a returning player, or
`'name' → 'new-password' → 'confirm-password' → 'playing'` for a new one. Names are validated
(3–16 chars, letters only) and checked case-insensitively. Before each password prompt the
server sends `IAC WILL ECHO` so the client stops local echo, and `IAC WONT ECHO` after — this
is the one piece of real telnet negotiation we need. Logging in as a character who is already
connected disconnects the older session rather than allowing two bodies.

**Command loop.** Once `state === 'playing'`, each line goes to `dispatch.js`: split verb from
argument string, resolve the verb against a flat table with prefix matching (so `n`, `no`,
`north` all work, and the table order decides ties), call
`handler(session, args, ctx)` where `ctx = { db, world, sessions }`. Unknown verbs get a
cyberpunk-flavoured error. A prompt is re-rendered after output.

**Broadcast.** `broadcast.js` filters the session Map by `roomId` and writes to each socket,
with an `except` argument for "everyone but the actor". Movement sends three messages — one to
the mover, a departure line to the old room, an arrival line to the new one.

**Persistence.** Player row saved on room change and on disconnect. Item `location` updated
immediately on take/drop, so a crash can't duplicate or vanish objects.

**Commands in M1.** `look`/`l`, `examine`/`x`, `north`/`south`/`east`/`west`/`up`/`down` (+
single-letter forms), `say`/`'`, `emote`/`:`, `who`, `inventory`/`i`, `take`/`get`, `drop`,
`help`, `quit`.

## The starting district (edit freely)

**Sector 7 — Kowloon Vertical.** A stacked slum grown inside a dead arcology: rain that never
reaches the ground floor, noodle steam, cheap chrome, and everyone one bad week from the Sump.

| id | Room | Notes |
|---|---|---|
| `s7-alley` | Neon Alley | starting room; signage in three languages |
| `s7-noodle` | Ganzo's Noodle Stall | warm, crowded, smells of pork fat and solder |
| `s7-market` | Grey Market Stalls | unlicensed chrome under tarpaulins |
| `s7-clinic` | Mama Vex's Ripperdoc Clinic | Milestone 3 hooks live here |
| `s7-stair` | East Stairwell | vertical spine of the district |
| `s7-catwalk` | Level 12 Catwalk | open to the rain, look down at the alley |
| `s7-roof` | Rooftop, Rain | the only sky in Sector 7 |
| `s7-sump` | The Sump | flooded sublevel; where the district throws things away |

Items: a carton of cold ramen, a length of rebar sharpened at one end, a cracked optic implant,
a scuffed credchip, a plastic tarp (scenery, not portable).

Characters start with BODY/REFLEX/INT/COOL at 5 each and 30 HP. Cyberware slots (3) are a
schema and lore concept in M1 only.

## Verification

1. `node seed.js` — creates `mud.db`, loads the 8 rooms and the item prototypes. Run it twice
   to confirm it's idempotent.
2. `node server.js` — should log `listening on 127.0.0.1:4000`.
3. In two terminals, `telnet localhost 4000`. Create two characters and check by hand:
   - password entry doesn't echo
   - both players see each other in `look` and `who`
   - moving produces departure and arrival lines in the right rooms
   - `say` and `emote` reach the other player only when in the same room
   - one player `take`s the ramen, the other sees it leave the ground; `drop` reverses it
   - `quit`, reconnect — you're in the room you left, still holding the ramen
4. `node --test` — `test/smoke.test.js` opens two scripted `net.Socket` clients against a
   temp-file database and asserts on the transcript (login, co-presence, movement broadcast,
   take/drop visibility, persistence across reconnect).
5. `kill` the server mid-session and restart to confirm no item duplication.

## After M1

- **M2** — combat: NPCs with a tick loop, `attack`, HP/damage, death and respawn.
- **M3** — the clinic opens: skills, cyberware slots, credits and vendors.
- **M4** — content scale: more areas, an area-file format worth documenting, admin commands.
