import { send } from '../net/session.js';
import { brightCyan, dim, magenta, red, yellow } from '../net/ansi.js';
import { sessionsInRoom } from './broadcast.js';
import { itemsAt, cmdExamine } from './items.js';
import { findTrip } from './trips.js';

// The room as this player sees it right now: title, prose, what is lying
// around, who else is standing here, and the way out.
export function describeRoom(ctx, session) {
  const room = ctx.world.rooms.get(session.roomId);
  if (!room) return red('You are nowhere. This is a bug, not a plot point.');

  const lines = [brightCyan(room.name), room.description];

  for (const item of itemsAt(ctx, `room:${room.id}`)) {
    if (item.proto.roomDesc) lines.push(yellow(item.proto.roomDesc));
  }
  // Only the person who set it knows where the beam is.
  if (findTrip(ctx.db, room.id)?.owner_id === session.playerId) {
    lines.push(red('Your laser trip is armed here.'));
  }
  for (const other of sessionsInRoom(ctx.sessions, room.id, session)) {
    lines.push(magenta(`${other.name} is here.`));
  }

  const exits = Object.keys(room.exits);
  lines.push(dim(`Exits: ${exits.length ? exits.join(', ') : 'none'}`));
  return lines.join('\r\n');
}

export function cmdLook(session, args, ctx) {
  if (args) return cmdExamine(session, args, ctx);
  send(session, describeRoom(ctx, session));
}
