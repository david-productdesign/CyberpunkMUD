// CyberpunkMUD — SSH server entry point.
//
//   bun seed.js     load the world files into the database
//   bun server.js   open the doors
//
// MUD_DB, MUD_HOST, MUD_PORT and MUD_HOST_KEY override the defaults.

import { openDatabase } from './src/db/db.js';
import { loadWorld } from './src/game/world.js';
import { startServer } from './src/net/listener.js';
import { savePlayer } from './src/db/players.js';
import { playingSessions } from './src/game/broadcast.js';

const db = openDatabase();
const world = loadWorld(db);

if (world.rooms.size === 0) {
  console.error('The world is empty. Run `bun seed.js` first.');
  process.exit(1);
}

const ctx = { db, world, sessions: new Map() };
const server = startServer(ctx, {
  host: process.env.MUD_HOST || '127.0.0.1',
  port: Number(process.env.MUD_PORT ?? 4022),
  hostKeyPath: process.env.MUD_HOST_KEY || 'ssh_host_ed25519_key',
});

// Save everyone before the process goes away.
function shutdown() {
  for (const session of playingSessions(ctx.sessions)) savePlayer(db, session);
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
