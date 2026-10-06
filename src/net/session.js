import { dim } from './ansi.js';

export const MAX_LINE = 4096; // a client sending this much without a newline is not typing

// A session is one connection and everything we know about who is on the other
// end of it. Plain object, mutated in place by the login machine and the commands.
//
// `socket` is the SSH channel carrying the bytes, and `input` is the line
// reader from terminal.js that turns its keystrokes into commands.
export function createSession(socket, id, { input, end }) {
  return {
    id,
    socket,
    input,
    end, // closes this connection the way its protocol expects
    queue: [], // lines waiting to be handled
    draining: false,
    state: 'name', // 'name' | 'confirm-new' | 'new-password' | 'confirm-password' | 'password' | 'playing' | 'dead'
    playerId: null,
    name: null,
    roomId: null,
    hp: 0,
    maxHp: 0,
    attempts: 0,
    pending: null, // scratch space for the login machine
  };
}

// Feed raw socket data in, get complete lines out.
export function feed(session, chunk) {
  return session.input.feed(chunk);
}

// Every disconnect the game decides on goes through here.
export function hangUp(session) {
  session.end();
}

export function write(session, text) {
  if (!session.socket.destroyed) session.socket.write(text);
}

export function send(session, text = '') {
  write(session, `${text}\r\n`);
}

export function prompt(session) {
  if (session.state !== 'playing') return;
  write(session, dim(`[${session.hp}/${session.maxHp}hp] > `));
  // The half-typed line is ours to draw, and an interrupt just wrote over it.
  const unfinished = session.input.unfinished();
  if (unfinished) write(session, unfinished);
}

// Deliver a message the player did not ask for. The leading newline gets us off
// whatever half-typed line they are sitting on before we print over it.
export function sendInterrupt(session, text) {
  if (session.socket.destroyed) return;
  write(session, `\r\n${text}\r\n`);
  prompt(session);
}

export function askSecret(session, label) {
  write(session, label);
  session.input.hide();
}

// Turn echo back on and move to a fresh line, since the client printed nothing
// for the newline the player just typed.
export function endSecret(session) {
  session.input.show();
  send(session);
}
