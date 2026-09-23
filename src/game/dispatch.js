import { send } from '../net/session.js';
import { red } from '../net/ansi.js';
import { cmdMove } from './move.js';
import { cmdLook } from './room.js';
import { cmdTake, cmdDrop, cmdInventory, cmdExamine } from './items.js';
import { cmdTrip } from './trips.js';
import { cmdSay, cmdEmote, cmdWho, cmdHelp, cmdQuit } from './comm.js';

const direction = (name) => ({
  name,
  aliases: [name[0]],
  run: (session, args, ctx) => cmdMove(session, name, ctx),
});

// Table order decides prefix matches, so the useful verbs come first.
const COMMANDS = [
  direction('north'),
  direction('south'),
  direction('east'),
  direction('west'),
  direction('up'),
  direction('down'),
  { name: 'look', aliases: ['l'], run: cmdLook },
  { name: 'examine', aliases: ['x', 'exam'], run: cmdExamine },
  { name: 'inventory', aliases: ['i', 'inv'], run: cmdInventory },
  { name: 'take', aliases: ['get'], run: cmdTake },
  { name: 'drop', aliases: [], run: cmdDrop },
  { name: 'trip', aliases: [], run: cmdTrip },
  { name: 'say', aliases: [], run: cmdSay },
  { name: 'emote', aliases: ['me'], run: cmdEmote },
  { name: 'who', aliases: [], run: cmdWho },
  { name: 'help', aliases: ['?'], run: cmdHelp },
  { name: 'quit', aliases: [], run: cmdQuit },
];

// An exact alias beats a prefix, so "e" is east rather than examine.
function findCommand(verb) {
  return (
    COMMANDS.find((command) => command.name === verb) ??
    COMMANDS.find((command) => command.aliases.includes(verb)) ??
    COMMANDS.find((command) => command.name.startsWith(verb)) ??
    null
  );
}

export function dispatch(session, line, ctx) {
  const raw = line.trim();
  if (!raw) return;

  // Two punctuation shortcuts that do not take a space after the verb.
  if (raw.startsWith("'")) return cmdSay(session, raw.slice(1).trim(), ctx);
  if (raw.startsWith(':')) return cmdEmote(session, raw.slice(1).trim(), ctx);

  const split = raw.indexOf(' ');
  const verb = (split === -1 ? raw : raw.slice(0, split)).toLowerCase();
  const args = split === -1 ? '' : raw.slice(split + 1).trim();

  const command = findCommand(verb);
  if (!command) {
    return send(session, red(`"${verb}" is not in your deck's command set. Try 'help'.`));
  }
  return command.run(session, args, ctx);
}
