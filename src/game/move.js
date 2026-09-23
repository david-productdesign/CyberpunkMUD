import { send } from '../net/session.js';
import { red } from '../net/ansi.js';
import { savePlayer } from '../db/players.js';
import { toRoom } from './broadcast.js';
import { describeRoom } from './room.js';
import { springTrip } from './trips.js';

const OPPOSITE = {
  north: 'the south',
  south: 'the north',
  east: 'the west',
  west: 'the east',
  up: 'below',
  down: 'above',
};

export function cmdMove(session, direction, ctx) {
  const room = ctx.world.rooms.get(session.roomId);
  const destinationId = room?.exits[direction];

  if (!destinationId) return send(session, red(`There is no way ${direction} from here.`));
  if (!ctx.world.rooms.has(destinationId)) {
    return send(session, red('That way is sealed off. Report it to whoever built this place.'));
  }

  toRoom(ctx.sessions, session.roomId, `${session.name} heads ${direction}.`, session);
  session.roomId = destinationId;
  savePlayer(ctx.db, session); // room changes are cheap and worth persisting immediately
  toRoom(ctx.sessions, destinationId, `${session.name} arrives from ${OPPOSITE[direction]}.`, session);

  send(session, describeRoom(ctx, session));
  springTrip(session, ctx);
}
