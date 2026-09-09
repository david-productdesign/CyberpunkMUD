# CyberpunkMUD

A multi-user dungeon set in **Sector 7, Kowloon Vertical** — forty floors of other
people's weather. Telnet in, walk the district, pick things up, and watch other
people do the same in real time.

Requires Node 26 (uses the built-in `node:sqlite`). **No dependencies, no build step.**

## Running it

```sh
node seed.js     # load world/*.json into mud.db — safe to re-run
node server.js   # listening on 127.0.0.1:4000
```

Then, in another terminal:

```sh
telnet localhost 4000
```

`MUD_DB`, `MUD_HOST` and `MUD_PORT` override the defaults.

## Playing

| | |
|---|---|
| Movement | `north` `south` `east` `west` `up` `down` (`n` `s` `e` `w` `u` `d`) |
| Looking  | `look [thing]` · `examine <thing>` (`l`, `x`) |
| Objects  | `take <thing>` · `drop <thing>` · `inventory` (`get`, `i`) |
| Talking  | `say <words>` · `emote <action>` · `who` (`'words`, `:action`) |
| System   | `help` · `quit` |

Verbs abbreviate: `n`, `exa`, `inv` all work.

## Security

**Telnet sends passphrases in cleartext.** That is the protocol, not a bug we can
patch out. Passphrases are stored scrypt-hashed and the server binds to
`127.0.0.1` by default, but treat this as a local/LAN toy until it grows a TLS or
SSH front end. Don't bind it to a public interface.

## Layout

```
server.js            entry point
seed.js              world/*.json -> database
world/               hand-authored rooms and objects (edit these)
src/net/             telnet, sessions, the listener
src/game/            login, command dispatch, rooms, movement, items, comms
src/db/              schema, player rows, passphrase hashing
test/smoke.test.js   drives two scripted telnet clients
```

Static content (rooms, item prototypes) is authored as JSON, seeded into SQLite,
and loaded into memory at boot. Mutable state (players, objects) is written back
to SQLite as it changes. Every object is one `items` row whose `location` is
`room:<id>` or `player:<id>`, so `take` and `drop` are a single indexed update
and a crash can neither duplicate nor lose anything.

## Tests

```sh
node --test
```

Two scripted telnet clients log in, see each other, move, talk, pass an object
between them, and reconnect to prove persistence.

## Where this is going

- **M2** — combat: NPCs on a tick loop, `attack`, damage, death and respawn.
- **M3** — the clinic opens: skills, cyberware slots, credits and vendors.
- **M4** — more areas, a documented area-file format, admin commands.
