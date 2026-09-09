// Load the hand-authored world files into the database.
//
// Idempotent by design: rooms and item prototypes are upserted, so editing the
// JSON and re-running this picks up your changes. Seeded objects carry a stable
// `spawn_key`, so re-running never duplicates them and never touches an object a
// player has already picked up and moved.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/db/db.js';

const worldFile = (name) => fileURLToPath(new URL(`./world/${name}`, import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(worldFile(name), 'utf8'));

function seedRooms(db, area, rooms) {
  const upsert = db.prepare(
    `INSERT INTO rooms (id, area, name, description, exits) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       area = excluded.area, name = excluded.name,
       description = excluded.description, exits = excluded.exits`
  );
  for (const room of rooms) {
    upsert.run(room.id, area, room.name, room.description, JSON.stringify(room.exits ?? {}));
  }
}

function seedProtos(db, protos) {
  const upsert = db.prepare(
    `INSERT INTO item_protos (id, name, keywords, room_desc, description, portable)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, keywords = excluded.keywords, room_desc = excluded.room_desc,
       description = excluded.description, portable = excluded.portable`
  );
  for (const proto of protos) {
    const roomDesc = proto.roomDesc || `${proto.name} is here.`;
    upsert.run(proto.id, proto.name, proto.keywords, roomDesc, proto.description, proto.portable ? 1 : 0);
  }
}

function seedSpawns(db, spawns) {
  // INSERT OR IGNORE against the unique spawn_key: an object that already
  // exists is left exactly where the players left it.
  const insert = db.prepare(
    'INSERT OR IGNORE INTO items (proto_id, location, spawn_key) VALUES (?, ?, ?)'
  );
  let created = 0;
  for (const spawn of spawns) {
    const result = insert.run(spawn.proto, `room:${spawn.room}`, spawn.key);
    created += result.changes;
  }
  return created;
}

// Fail loudly on a typo in the world files rather than at 2am in the game.
function validateExits(rooms) {
  const ids = new Set(rooms.map((room) => room.id));
  for (const room of rooms) {
    for (const [direction, target] of Object.entries(room.exits ?? {})) {
      if (!ids.has(target)) {
        throw new Error(`${room.id}: exit "${direction}" points at unknown room "${target}"`);
      }
    }
  }
}

const sector7 = readJson('sector7.json');
const items = readJson('items.json');
validateExits(sector7.rooms);

const db = openDatabase();
seedRooms(db, sector7.area, sector7.rooms);
seedProtos(db, items.protos);
const spawned = seedSpawns(db, items.spawns);
db.close();

console.log(
  `seeded ${sector7.rooms.length} rooms, ${items.protos.length} item prototypes, ` +
    `${spawned} new object${spawned === 1 ? '' : 's'} placed`
);
