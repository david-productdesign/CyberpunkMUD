// Minimal telnet protocol handling.
//
// We are a deliberately rude telnet server: we strip every command a client
// sends us and never answer negotiation. The one thing we do send is ECHO,
// because it is what stops a client echoing a password back onto the screen.

const IAC = 255; // "interpret as command" — introduces every telnet sequence
const SE = 240;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;
const OPT_ECHO = 1;

const MAX_CARRY = 64; // a partial sequence longer than this is junk, not telnet

// Remove telnet command sequences from a chunk of socket data.
// A sequence can be cut in half by a chunk boundary, so the returned `carry`
// must be handed back in with the next chunk.
export function stripTelnet(chunk, carry = Buffer.alloc(0)) {
  const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
  const clean = [];
  let i = 0;

  while (i < data.length) {
    if (data[i] !== IAC) {
      clean.push(data[i]);
      i += 1;
      continue;
    }
    const rest = data.length - i;
    const command = data[i + 1];

    if (rest < 2) return incomplete(clean, data, i);
    if (command === IAC) {
      clean.push(IAC); // IAC IAC is an escaped literal 0xFF
      i += 2;
      continue;
    }
    if (command === WILL || command === WONT || command === DO || command === DONT) {
      if (rest < 3) return incomplete(clean, data, i);
      i += 3;
      continue;
    }
    if (command === SB) {
      const end = findSubnegotiationEnd(data, i + 2);
      if (end === -1) return incomplete(clean, data, i);
      i = end;
      continue;
    }
    i += 2; // a two-byte command we have no opinion about
  }
  return { clean: Buffer.from(clean), carry: Buffer.alloc(0) };
}

function incomplete(clean, data, i) {
  const tail = data.subarray(i);
  return {
    clean: Buffer.from(clean),
    carry: tail.length > MAX_CARRY ? Buffer.alloc(0) : tail,
  };
}

function findSubnegotiationEnd(data, start) {
  for (let i = start; i < data.length - 1; i += 1) {
    if (data[i] === IAC && data[i + 1] === SE) return i + 2;
  }
  return -1;
}

// "I will echo for you" — a compliant client stops echoing locally, which is
// how the password prompt stays blank.
export const echoOff = () => Buffer.from([IAC, WILL, OPT_ECHO]);
export const echoOn = () => Buffer.from([IAC, WONT, OPT_ECHO]);
