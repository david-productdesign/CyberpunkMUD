import net from 'node:net';
import { createSession, feed, send, prompt } from './session.js';
import { greet, handleLoginLine } from '../game/login.js';
import { dispatch } from '../game/dispatch.js';
import { savePlayer } from '../db/players.js';
import { toRoom } from '../game/broadcast.js';
import { red } from './ansi.js';

const IDLE_MS = 30 * 60 * 1000;

export function startServer(ctx, { host, port }) {
  let nextId = 1;

  const server = net.createServer((socket) => {
    const session = createSession(socket, nextId++);
    ctx.sessions.set(session.id, session);

    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS);
    socket.on('timeout', () => {
      send(session, red('Link idle too long. Dropping you.'));
      socket.end();
    });
    socket.on('data', (chunk) => {
      for (const line of feed(session, chunk)) enqueue(session, line, ctx);
    });
    socket.on('error', () => {}); // a dropped connection is not an exception
    socket.on('close', () => handleClose(session, ctx));

    greet(session);
  });

  server.listen(port, host, () => {
    const address = server.address();
    console.log(`listening on ${address.address}:${address.port}`);
  });

  return server;
}

// Lines are handled strictly one at a time. Login steps are async (scrypt), and
// without a queue a fast client could interleave two lines through one state.
function enqueue(session, line, ctx) {
  session.queue.push(line);
  if (!session.draining) drain(session, ctx);
}

async function drain(session, ctx) {
  session.draining = true;
  while (session.queue.length > 0 && !session.socket.destroyed) {
    const line = session.queue.shift();
    try {
      if (session.state === 'playing') dispatch(session, line, ctx);
      else await handleLoginLine(session, line, ctx);
    } catch (error) {
      console.error('command failed:', error);
      send(session, red('Something in the system glitched. The command did not take.'));
    }
    prompt(session);
  }
  session.draining = false;
}

function handleClose(session, ctx) {
  if (!ctx.sessions.delete(session.id)) return;
  if (session.state !== 'playing') return;

  savePlayer(ctx.db, session);
  session.state = 'closed'; // keep them out of their own departure broadcast
  toRoom(ctx.sessions, session.roomId, `${session.name} unjacks and is gone.`);
}
