import { createSession, feed, send, prompt, hangUp } from './session.js';
import { greet, handleLoginLine } from '../game/login.js';
import { dispatch } from '../game/dispatch.js';
import { savePlayer } from '../db/players.js';
import { toRoom } from '../game/broadcast.js';
import { dim, red } from './ansi.js';

export const IDLE_MS = 30 * 60 * 1000;

let nextId = 1;

// Everything a connection needs once its SSH shell channel is open.
export function openConnection(ctx, stream, { input, end }) {
  const writeRaw = (data) => {
    if (!stream.destroyed) stream.write(data);
  };
  const session = createSession(stream, nextId++, { input: input(writeRaw), end });
  ctx.sessions.set(session.id, session);

  stream.on('data', (chunk) => {
    for (const line of feed(session, chunk)) enqueue(session, line, ctx);
  });
  stream.on('close', () => handleClose(session, ctx));

  greet(session);
  return session;
}

export function dropIdle(session) {
  send(session, red('Link idle too long. Dropping you.'));
  hangUp(session);
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
      else if (session.state === 'dead') send(session, dim('You are flatlined. Nothing you do reaches the world.'));
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
