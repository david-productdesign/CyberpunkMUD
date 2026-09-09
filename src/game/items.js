import { send } from '../net/session.js';
import { red, yellow } from '../net/ansi.js';
import { toRoom } from './broadcast.js';

const roomKey = (roomId) => `room:${roomId}`;
const playerKey = (playerId) => `player:${playerId}`;

// Every object at a location, joined against the in-memory prototypes.
export function itemsAt(ctx, location) {
  return ctx.db
    .prepare('SELECT id, proto_id FROM items WHERE location = ? ORDER BY id')
    .all(location)
    .map((row) => ({ id: row.id, proto: ctx.world.protos.get(row.proto_id) }))
    .filter((item) => item.proto);
}

// Match what the player typed against item keywords, by prefix, so "take ram"
// finds the ramen.
export function matchItem(items, arg) {
  const needle = arg.trim().toLowerCase();
  if (!needle) return null;
  return (
    items.find((item) => item.proto.keywords.some((word) => word === needle)) ??
    items.find((item) => item.proto.keywords.some((word) => word.startsWith(needle))) ??
    null
  );
}

function moveItem(ctx, itemId, location) {
  ctx.db.prepare('UPDATE items SET location = ? WHERE id = ?').run(location, itemId);
}

export function cmdTake(session, args, ctx) {
  if (!args) return send(session, 'Take what?');

  const item = matchItem(itemsAt(ctx, roomKey(session.roomId)), args);
  if (!item) return send(session, red("You don't see that here."));
  if (!item.proto.portable) return send(session, red(`${item.proto.name} is not going anywhere with you.`));

  moveItem(ctx, item.id, playerKey(session.playerId));
  send(session, `You pick up ${item.proto.name}.`);
  toRoom(ctx.sessions, session.roomId, `${session.name} picks up ${item.proto.name}.`, session);
}

export function cmdDrop(session, args, ctx) {
  if (!args) return send(session, 'Drop what?');

  const item = matchItem(itemsAt(ctx, playerKey(session.playerId)), args);
  if (!item) return send(session, red("You aren't carrying that."));

  moveItem(ctx, item.id, roomKey(session.roomId));
  send(session, `You drop ${item.proto.name}.`);
  toRoom(ctx.sessions, session.roomId, `${session.name} drops ${item.proto.name}.`, session);
}

export function cmdInventory(session, args, ctx) {
  const carried = itemsAt(ctx, playerKey(session.playerId));
  if (carried.length === 0) return send(session, 'You are carrying nothing but the clothes you stand in.');

  send(session, 'You are carrying:');
  for (const item of carried) send(session, `  ${yellow(item.proto.name)}`);
}

export function cmdExamine(session, args, ctx) {
  if (!args) return send(session, 'Examine what?');

  const nearby = [...itemsAt(ctx, playerKey(session.playerId)), ...itemsAt(ctx, roomKey(session.roomId))];
  const item = matchItem(nearby, args);
  if (item) return send(session, item.proto.description);

  // Failing an object, maybe they meant a person.
  const needle = args.trim().toLowerCase();
  const other = [...ctx.sessions.values()].find(
    (s) => s.state === 'playing' && s.roomId === session.roomId && s.name.toLowerCase().startsWith(needle)
  );
  if (other) {
    const label = other === session ? 'You look' : `${other.name} looks`;
    return send(session, `${label} like someone Sector 7 has not finished with yet. [${other.hp}/${other.maxHp}hp]`);
  }

  send(session, red("You don't see that here."));
}
