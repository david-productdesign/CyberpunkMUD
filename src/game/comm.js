import { send, hangUp } from '../net/session.js';
import { dim, green, red } from '../net/ansi.js';
import { playingSessions, toRoom } from './broadcast.js';

export function cmdSay(session, args, ctx) {
  if (!args) return send(session, 'Say what?');
  send(session, green(`You say, "${args}"`));
  toRoom(ctx.sessions, session.roomId, green(`${session.name} says, "${args}"`), session);
}

export function cmdEmote(session, args, ctx) {
  if (!args) return send(session, 'Emote what?');
  const line = `${session.name} ${args}`;
  send(session, line);
  toRoom(ctx.sessions, session.roomId, line, session);
}

export function cmdWho(session, args, ctx) {
  const online = playingSessions(ctx.sessions);
  send(session, dim(`${online.length} operative${online.length === 1 ? '' : 's'} jacked in:`));
  for (const other of online) {
    const room = ctx.world.rooms.get(other.roomId);
    send(session, `  ${other.name.padEnd(18)}${dim(room ? room.name : 'nowhere')}`);
  }
}

const HELP = [
  'Movement    north south east west up down  (n s e w u d)',
  'Looking     look [thing]   examine <thing>   (l, x)',
  'Objects     take <thing>   drop <thing>   inventory   (get, i)',
  'Traps       trip           arm a laser trip in this room',
  "Talking     say <words>    emote <action>   who        ('words, :action)",
  'System      help   quit',
];

export function cmdHelp(session) {
  send(session, dim('Sector 7 runs on a short command set. Abbreviations work.'));
  for (const line of HELP) send(session, `  ${line}`);
}

export function cmdQuit(session, args, ctx) {
  send(session, red('You unjack. Sector 7 carries on without you.'));
  hangUp(session);
}
