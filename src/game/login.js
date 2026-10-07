import { send, write, askSecret, endSecret, hangUp } from '../net/session.js';
import { brightMagenta, dim, green, red } from '../net/ansi.js';
import { hashPassword, verifyPassword } from '../db/auth.js';
import { findPlayerByName, createPlayer, savePlayer } from '../db/players.js';
import { toRoom } from './broadcast.js';
import { describeRoom } from './room.js';
import { START_ROOM } from './world.js';

const NAME_PATTERN = /^[A-Za-z]{3,16}$/;
const MIN_PASSPHRASE = 6;
const MAX_ATTEMPTS = 3;

const BANNER = [
  '',
  brightMagenta('  ╔═══════════════════════════════════════════════╗'),
  brightMagenta('  ║   S E C T O R   7  ·  KOWLOON VERTICAL        ║'),
  brightMagenta('  ╚═══════════════════════════════════════════════╝'),
  dim('  Forty floors of other people\'s weather.'),
  dim('  This link is encrypted. Nothing else here is.'),
  '',
];

export function greet(session) {
  for (const line of BANNER) send(session, line);
  write(session, 'Operative handle: ');
}

// The login state machine. Each state consumes one line and decides where the
// session goes next; `session.pending` carries the half-built character.
export async function handleLoginLine(session, line, ctx) {
  const input = line.trim();
  switch (session.state) {
    case 'name':
      return handleName(session, input, ctx);
    case 'confirm-new':
      return handleConfirmNew(session, input, ctx);
    case 'new-password':
      return handleNewPassword(session, input);
    case 'confirm-password':
      return handleConfirmPassword(session, input, ctx);
    case 'password':
      return handlePassword(session, input, ctx);
    default:
      return undefined;
  }
}

function handleName(session, input, ctx) {
  if (!NAME_PATTERN.test(input)) {
    send(session, red('Handles are 3 to 16 letters, nothing else. Sector 7 is not creative about this.'));
    return write(session, 'Operative handle: ');
  }

  const name = input[0].toUpperCase() + input.slice(1).toLowerCase();
  const player = findPlayerByName(ctx.db, name);

  if (player) {
    if (refuseIfLockedOut(session, player.name, ctx)) return undefined;
    session.pending = { player };
    session.state = 'password';
    return askSecret(session, 'Passphrase: ');
  }

  session.pending = { name };
  session.state = 'confirm-new';
  return write(session, `No record of "${name}" in Sector 7. Create a new operative? (y/n) `);
}

function handleConfirmNew(session, input, ctx) {
  if (/^y(es)?$/i.test(input)) {
    // Checked before the passphrase is chosen, so a bot cannot make us hash it.
    if (ctx.throttles.accountsByIp.count(session.ip) >= ctx.limits.accountsPerIp) {
      console.log(`account creation refused: limit reached ip=${session.ip}`);
      session.pending = null;
      session.state = 'name';
      send(session, red('Too many new operatives from your address lately. Try again later, or log in to one you have.'));
      return write(session, 'Operative handle: ');
    }
    session.state = 'new-password';
    return askSecret(session, 'Choose a passphrase: ');
  }
  session.pending = null;
  session.state = 'name';
  return write(session, 'Operative handle: ');
}

function handleNewPassword(session, input) {
  endSecret(session);
  if (input.length < MIN_PASSPHRASE) {
    send(session, red(`At least ${MIN_PASSPHRASE} characters. You are not the only one who wants this handle.`));
    return askSecret(session, 'Choose a passphrase: ');
  }
  session.pending.password = input;
  session.state = 'confirm-password';
  return askSecret(session, 'Confirm passphrase: ');
}

async function handleConfirmPassword(session, input, ctx) {
  endSecret(session);
  if (input !== session.pending.password) {
    session.state = 'new-password';
    send(session, red('Those did not match.'));
    return askSecret(session, 'Choose a passphrase: ');
  }

  const { name } = session.pending;
  const { hash, salt } = await hashPassword(input);

  // Someone may have claimed the handle while we were hashing.
  if (findPlayerByName(ctx.db, name)) {
    session.pending = null;
    session.state = 'name';
    send(session, red('That handle was taken out from under you. Pick another.'));
    return write(session, 'Operative handle: ');
  }

  const player = createPlayer(ctx.db, { name, hash, salt, roomId: START_ROOM });
  ctx.throttles.accountsByIp.add(session.ip);
  console.log(`account created handle=${name} ip=${session.ip}`);
  send(session, green(`Welcome to Sector 7, ${name}. Nobody is coming to help you.`));
  return enterWorld(session, player, ctx, 'arrives');
}

async function handlePassword(session, input, ctx) {
  endSecret(session);
  const { player } = session.pending;
  // Again here, not just at the handle: failures from elsewhere can pile up
  // while this player is typing, and each guess costs a scrypt hash.
  if (refuseIfLockedOut(session, player.name, ctx)) return undefined;
  const ok = await verifyPassword(input, player.password_hash, player.password_salt);

  if (!ok) {
    ctx.throttles.loginFailuresByIp.add(session.ip);
    ctx.throttles.loginFailuresByHandle.add(player.name);
    console.log(`login failed handle=${player.name} ip=${session.ip}`);
    session.attempts += 1;
    if (session.attempts >= MAX_ATTEMPTS) {
      send(session, red('Too many bad passphrases. The link drops.'));
      return hangUp(session);
    }
    send(session, red('That passphrase is wrong.'));
    return askSecret(session, 'Passphrase: ');
  }

  console.log(`login handle=${player.name} ip=${session.ip}`);
  return enterWorld(session, player, ctx, 'jacks back in');
}

// Too many wrong passphrases lately, from this address or for this handle.
// Returns true when the player has been turned away.
function refuseIfLockedOut(session, handle, ctx) {
  const { throttles, limits } = ctx;
  const byIp = throttles.loginFailuresByIp.count(session.ip) >= limits.loginFailuresPerIp;
  const byHandle = throttles.loginFailuresByHandle.count(handle) >= limits.loginFailuresPerHandle;
  if (!byIp && !byHandle) return false;

  console.log(`login refused: ${byIp ? 'address' : 'handle'} locked out handle=${handle} ip=${session.ip}`);
  send(session, red('Too many wrong passphrases lately. The link drops. Try again in 15 minutes.'));
  hangUp(session);
  return true;
}

// Attach a session to a character and put it in the world.
function enterWorld(session, player, ctx, verb) {
  disconnectOther(session, player, ctx);

  session.playerId = player.id;
  session.name = player.name;
  // A room can vanish if the world files were edited under a sleeping player.
  session.roomId = ctx.world.rooms.has(player.room_id) ? player.room_id : START_ROOM;
  session.hp = player.hp;
  session.maxHp = player.max_hp;
  session.state = 'playing';
  session.pending = null;
  savePlayer(ctx.db, session);

  send(session, '');
  send(session, describeRoom(ctx, session));
  toRoom(ctx.sessions, session.roomId, `${session.name} ${verb}.`, session);
}

// One body per character: an older connection loses the argument.
function disconnectOther(session, player, ctx) {
  for (const other of ctx.sessions.values()) {
    if (other !== session && other.playerId === player.id) {
      send(other, red('Another connection has taken over this body.'));
      hangUp(other);
    }
  }
}
