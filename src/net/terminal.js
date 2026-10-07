// Input for an SSH terminal.
//
// With a pty, the player's terminal is in raw mode: it sends every keystroke as
// it is pressed and prints nothing itself. Echoing, backspace and hiding the
// passphrase are therefore our job. Without a pty the client edits and echoes
// locally and only whole lines reach us.

import { StringDecoder } from 'node:string_decoder';

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_U = '\x15';
const BACKSPACE = '\x08';
const DELETE = '\x7f';
const ERASE_ONE = '\b \b';

// Characters that change how text is displayed rather than adding to it. C1
// controls (U+0080 to U+009F) work as escape sequences on some terminals, so
// one player could clear or scramble another's screen. Bidirectional controls
// reorder what follows them, so a `say` could be made to look like something
// else entirely. ESC and the C0 controls are handled separately below.
const DISPLAY_CONTROLS = /[\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function createTerminalInput(writeRaw, maxLine, { echo }) {
  const decoder = new StringDecoder('utf8'); // a character can straddle two chunks
  let buffer = ''; // the line being typed
  let hidden = false;
  let skipNewline = false; // a CR just ended a line, so a following LF is not another
  let escape = null; // null | 'start' | 'sequence' — inside an arrow key or similar

  const visible = () => echo && !hidden;
  const echoBack = (text) => {
    if (visible()) writeRaw(text);
  };

  function erase(count) {
    echoBack(ERASE_ONE.repeat(count));
  }

  // Arrow keys, function keys and the like arrive as ESC [ ... or ESC O ...,
  // ending in a byte from @ to ~. We have no line history, so drop them whole.
  function consumeEscape(char) {
    if (escape === 'start') {
      escape = char === '[' || char === 'O' ? 'sequence' : null;
      return;
    }
    if (char >= '@' && char <= '~') escape = null;
  }

  function handle(char, lines) {
    const wasCarriageReturn = skipNewline;
    skipNewline = false;

    if (escape) return consumeEscape(char);
    if (char === ESC) {
      escape = 'start';
      return;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\n' && wasCarriageReturn) return;
      skipNewline = char === '\r';
      echoBack('\r\n');
      lines.push(buffer);
      buffer = '';
      return;
    }
    if (char === DELETE || char === BACKSPACE) {
      if (!buffer) return;
      buffer = Array.from(buffer).slice(0, -1).join('');
      erase(1);
      return;
    }
    if (char === CTRL_C || char === CTRL_U) {
      erase(Array.from(buffer).length);
      buffer = '';
      return;
    }
    if (char < ' ') return; // tab and the other control keys mean nothing here
    if (DISPLAY_CONTROLS.test(char)) return;
    if (buffer.length >= maxLine) return;
    buffer += char;
    echoBack(char);
  }

  return {
    feed(chunk) {
      const lines = [];
      for (const char of decoder.write(chunk)) handle(char, lines);
      return lines;
    },
    hide() {
      hidden = true;
    },
    show() {
      hidden = false;
    },
    // What to reprint after something else has written over the player's line.
    unfinished: () => (visible() ? buffer : ''),
  };
}
