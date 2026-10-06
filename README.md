# CyberpunkMUD

A multi-user dungeon set in **Sector 7, Kowloon Vertical** — forty floors of other
people's weather. SSH in, walk the district, pick things up, and watch other
people do the same in real time.

Runs on [Bun](https://bun.sh) (tested with 1.4.2). No build step. One runtime
dependency, [`ssh2`](https://github.com/mscdex/ssh2), for the SSH server.

## Running it

```sh
bun install     # ssh2 only; bunfig.toml skips its optional native add-on
bun seed.js     # load world/*.json into mud.db — safe to re-run
bun server.js   # listening on 127.0.0.1:4022
```

Then, in another terminal:

```sh
ssh -p 4022 anyone@localhost   # any username, no SSH password
```

SSH accepts any login; the game then asks for your handle and passphrase as
usual. The first start generates an ed25519 host key at `ssh_host_ed25519_key`
(git-ignored) and every start logs its fingerprint, so players can check the
one `ssh` shows them. Keep that file: replacing it makes every client warn that
the host key changed.

| Variable | Default | |
|---|---|---|
| `MUD_DB` | `mud.db` | database file |
| `MUD_HOST` | `127.0.0.1` | interface to listen on |
| `MUD_PORT` | `4022` | SSH port |
| `MUD_HOST_KEY` | `ssh_host_ed25519_key` | SSH host key file |

## Running it in Docker

```sh
docker compose up --build -d   # build the image and start it
ssh -p 4022 anyone@localhost
docker compose logs -f         # seeding, host key fingerprint, errors
docker compose down            # stop; the data volume is kept
```

The container seeds the world on every start (it is idempotent) and then runs
the server as the unprivileged `bun` user. Everything that must survive lives on
the `mud-data` volume at `/data`: the database and the SSH host key. Back that
volume up; `docker compose down -v` deletes it, and with it every character and
the host key.

`compose.yaml` publishes the port on `127.0.0.1` only, for local testing. To run
the image elsewhere, mount a volume on `/data` and publish port 4022:

```sh
docker build -t cyberpunkmud .
docker run -d --name cyberpunkmud -v mud-data:/data -p 4022:4022 cyberpunkmud
```

Run exactly one container per volume. Live sessions are held in memory and the
world is one SQLite file, so the game cannot be scaled across containers, and
SQLite needs the volume on local disk, not a network file system.

## Playing

| | |
|---|---|
| Movement | `north` `south` `east` `west` `up` `down` (`n` `s` `e` `w` `u` `d`) |
| Looking  | `look [thing]` · `examine <thing>` (`l`, `x`) |
| Objects  | `take <thing>` · `drop <thing>` · `inventory` (`get`, `i`) |
| Traps    | `trip` — arm a laser trip here; the next player to walk in loses 15 HP |
| Talking  | `say <words>` · `emote <action>` · `who` (`'words`, `:action`) |
| System   | `help` · `quit` |

Verbs abbreviate: `n`, `exa`, `inv` all work.

Hit 0 HP and you flatline: a death sequence plays, then you wake in Mama Vex's
clinic at full HP, still carrying everything you had.

## Security

SSH encrypts the whole session, passphrase included, and passphrases are stored
scrypt-hashed. SSH itself lets anyone in: identity is the game's handle and
passphrase, not an SSH key or account. The server binds to `127.0.0.1` by
default; `MUD_HOST=0.0.0.0 bun server.js` opens it to other machines.

## Layout

```
server.js            entry point
seed.js              world/*.json -> database
world/               hand-authored rooms and objects (edit these)
src/net/             SSH listener, terminal input, sessions
src/game/            login, command dispatch, rooms, movement, items, comms
src/db/              schema, player rows, passphrase hashing
test/smoke.test.js   drives scripted SSH clients
```

Static content (rooms, item prototypes) is authored as JSON, seeded into SQLite,
and loaded into memory at boot. Mutable state (players, objects) is written back
to SQLite as it changes. Every object is one `items` row whose `location` is
`room:<id>` or `player:<id>`, so `take` and `drop` are a single indexed update
and a crash can neither duplicate nor lose anything.

## Tests

```sh
bun run test
```

That runs `bun test --timeout 60000`. The longer timeout matters: Bun stops a
test after 5 seconds by default, and the laser-trip test sits through the whole
flatline sequence.

Scripted SSH clients log in, see each other, move, talk, pass an object between
them, and reconnect to prove persistence. They also check the host key, echo
and passphrase hiding, and line editing.

## Where this is going

- **M2** — combat: NPCs on a tick loop, `attack`, damage, death and respawn.
- **M3** — the clinic opens: skills, cyberware slots, credits and vendors.
- **M4** — more areas, a documented area-file format, admin commands.
