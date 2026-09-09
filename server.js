// CyberpunkMUD — telnet server entry point.
//
//   node seed.js     load the world files into the database
//   node server.js   open the door
//
// MUD_DB, MUD_HOST and MUD_PORT override the defaults.

import { openDatabase } from './src/db/db.js';
import { loadWorld } from './src/game/world.js';
import { startServer } from './src/net/listener.js';
import { savePlayer } from './src/db/players.js';
import { playingSessions } from './src/game/broadcast.js';

const db = openDatabase();
const world = loadWorld(db);

if (world.rooms.size === 0) {
  console.error('The world is empty. Run `node seed.js` first.');
  process.exit(1);
}

const ctx = { db, world, sessions: new Map() };
const host = process.env.MUD_HOST || '127.0.0.1';
const port = Number(process.env.MUD_PORT ?? 4000);
const server = startServer(ctx, { host, port });

// Save everyone before the process goes away.
function shutdown() {
  for (const session of playingSessions(ctx.sessions)) savePlayer(db, session);
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
