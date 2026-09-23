import { stripTelnet, echoOff, echoOn } from './telnet.js';
import { dim } from './ansi.js';

const MAX_LINE = 4096; // a client sending this much without a newline is not typing

// A session is one socket and everything we know about who is on the other end
// of it. Plain object, mutated in place by the login machine and the commands.
export function createSession(socket, id) {
  return {
    id,
    socket,
    carry: Buffer.alloc(0), // half a telnet sequence, waiting for the rest
    buffer: '', // half a line, waiting for its newline
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
  const { clean, carry } = stripTelnet(chunk, session.carry);
  session.carry = carry;
  session.buffer += clean.toString('utf8');

  if (session.buffer.length > MAX_LINE) session.buffer = '';

  const lines = session.buffer.split('\n');
  session.buffer = lines.pop(); // the trailing fragment is not a line yet
  return lines.map((line) => line.replace(/\r$/, ''));
}

export function write(session, text) {
  if (!session.socket.destroyed) session.socket.write(text);
}

export function send(session, text = '') {
  write(session, `${text}\r\n`);
}

export function sendRaw(session, data) {
  if (!session.socket.destroyed) session.socket.write(data);
}

export function prompt(session) {
  if (session.state !== 'playing') return;
  write(session, dim(`[${session.hp}/${session.maxHp}hp] > `));
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
  sendRaw(session, echoOff());
}

// Turn echo back on and move to a fresh line, since the client printed nothing
// for the newline the player just typed.
export function endSecret(session) {
  sendRaw(session, echoOn());
  send(session);
}
