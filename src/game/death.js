import { send, prompt } from '../net/session.js';
import { bold, dim, green, red, yellow } from '../net/ansi.js';
import { savePlayer } from '../db/players.js';
import { toRoom } from './broadcast.js';
import { describeRoom } from './room.js';

// Mama Vex's chair is where Sector 7 puts people back together.
export const RESPAWN_ROOM = 's7-clinic';

const FLATLINE = [
  '  ███████╗██╗      █████╗ ████████╗██╗     ██╗███╗   ██╗███████╗',
  '  ██╔════╝██║     ██╔══██╗╚══██╔══╝██║     ██║████╗  ██║██╔════╝',
  '  █████╗  ██║     ███████║   ██║   ██║     ██║██╔██╗ ██║█████╗',
  '  ██╔══╝  ██║     ██╔══██║   ██║   ██║     ██║██║╚██╗██║██╔══╝',
  '  ██║     ███████╗██║  ██║   ██║   ███████╗██║██║ ╚████║███████╗',
  '  ╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝╚═╝  ╚═══╝╚══════╝',
];

// A heartbeat is a two-row trace: the spike on top, the baseline underneath.
// Longer gaps between beats read as a slowing pulse.
function trace(gap, beats, colour, label) {
  const top = `   /\\   ${' '.repeat(gap)}`.repeat(beats);
  const base = `__/  \\/\\${'_'.repeat(gap)}`.repeat(beats);
  return [colour(`  ${top}`), colour(`  ${base}  ${label}`)];
}

const FLAT = '_'.repeat(52);

// Each step is some lines and how long to hold them before the next.
const SEQUENCE = [
  { pause: 500, lines: ['', dim('  :: BIOMONITOR // LINK TELEMETRY ::'), ...trace(1, 5, green, 'BPM 148')] },
  { pause: 600, lines: trace(8, 3, yellow, 'BPM 61') },
  { pause: 700, lines: ['', red(`  ${'_'.repeat(20)}/\\${'_'.repeat(30)}  BPM 12`)] },
  { pause: 900, lines: ['', red(`  ${FLAT}  BPM 0`)] },
  { pause: 1200, lines: ['', ...FLATLINE.map((line) => bold(red(line))), ''] },
  { pause: 900, lines: [dim('  Signal lost. Your implants dump their last buffer into the dark.')] },
  { pause: 1000, lines: [dim('  . . .')] },
  {
    pause: 400,
    lines: [
      '',
      green('  > COLD REBOOT ........ ok'),
      green('  > NEURAL HANDSHAKE ... ok'),
      yellow('  > WARRANTY ........... void'),
      '',
      'The surgical rig draws a long needle out of your chest and folds its arms away.',
      'Mama Vex is still not in. Somebody paid for this.',
      '',
    ],
  },
];

// The body is back in the chair with full HP before the sequence starts, so a
// dropped connection mid-sequence loses nothing.
export function killPlayer(session, ctx) {
  toRoom(ctx.sessions, session.roomId, red(`${session.name} hits the floor and does not get up.`), session);

  session.state = 'dead'; // out of every room, and their typing goes nowhere
  session.roomId = RESPAWN_ROOM;
  session.hp = session.maxHp;
  savePlayer(ctx.db, session);

  playSequence(session, ctx, 0);
}

function playSequence(session, ctx, index) {
  if (!stillHere(session, ctx)) return;
  if (index === SEQUENCE.length) return revive(session, ctx);

  const step = SEQUENCE[index];
  for (const line of step.lines) send(session, line);
  setTimeout(() => playSequence(session, ctx, index + 1), step.pause);
}

// They may have quit, dropped, or been taken over by a new login meanwhile.
function stillHere(session, ctx) {
  return ctx.sessions.get(session.id) === session && !session.socket.writableEnded;
}

function revive(session, ctx) {
  session.state = 'playing';
  send(session, describeRoom(ctx, session));
  prompt(session);
  toRoom(ctx.sessions, session.roomId, `${session.name} jerks awake in the chair, gasping.`, session);
}
