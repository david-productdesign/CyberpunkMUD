import { send, sendInterrupt } from '../net/session.js';
import { red } from '../net/ansi.js';
import { savePlayer } from '../db/players.js';
import { playingSessions, toRoom } from './broadcast.js';
import { killPlayer } from './death.js';

const TRIP_DAMAGE = 15;

export function findTrip(db, roomId) {
  return db.prepare('SELECT room_id, owner_id FROM trips WHERE room_id = ?').get(roomId) ?? null;
}

function findTripByOwner(db, ownerId) {
  return db.prepare('SELECT room_id, owner_id FROM trips WHERE owner_id = ?').get(ownerId) ?? null;
}

function roomName(ctx, roomId) {
  return ctx.world.rooms.get(roomId)?.name ?? 'somewhere that no longer exists';
}

export function cmdTrip(session, args, ctx) {
  const existing = findTrip(ctx.db, session.roomId);
  if (existing?.owner_id === session.playerId) {
    return send(session, 'Your laser trip is already armed here.');
  }
  if (existing) return send(session, red('Someone else already has a beam strung across this room.'));

  const previous = findTripByOwner(ctx.db, session.playerId);
  if (previous) {
    ctx.db.prepare('DELETE FROM trips WHERE room_id = ?').run(previous.room_id);
    send(session, `Your old laser trip in ${roomName(ctx, previous.room_id)} powers down.`);
  }

  ctx.db
    .prepare('INSERT INTO trips (room_id, owner_id, set_at) VALUES (?, ?, ?)')
    .run(session.roomId, session.playerId, Date.now());
  send(session, 'You string a laser trip across the way in and arm it. The beam fades to invisible.');
  toRoom(ctx.sessions, session.roomId, `${session.name} crouches by the entrance and fiddles with something.`, session);
}

// Called after a player walks into a room. Their own trip lets them pass.
export function springTrip(session, ctx) {
  const trip = findTrip(ctx.db, session.roomId);
  if (!trip || trip.owner_id === session.playerId) return;

  ctx.db.prepare('DELETE FROM trips WHERE room_id = ?').run(trip.room_id);

  const damage = Math.min(TRIP_DAMAGE, session.hp);
  session.hp -= damage;
  savePlayer(ctx.db, session);

  send(session, red(`A red line flickers across your shins and the trip detonates. You take ${damage} damage.`));
  toRoom(ctx.sessions, session.roomId, red(`${session.name} walks into a laser trip. The blast fills the room.`), session);
  notifyOwner(trip, session, ctx);

  if (session.hp === 0) killPlayer(session, ctx);
}

// The owner hears about it wherever they are, unless they watched it happen.
function notifyOwner(trip, victim, ctx) {
  const owner = playingSessions(ctx.sessions).find((s) => s.playerId === trip.owner_id);
  if (!owner || owner.roomId === trip.room_id) return;
  sendInterrupt(owner, `Your laser trip in ${roomName(ctx, trip.room_id)} goes off. ${victim.name} caught it${victim.hp === 0 ? ' and flatlined' : ''}.`);
}
