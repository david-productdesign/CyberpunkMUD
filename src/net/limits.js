// Every number that stands between the game and someone trying to knock it
// over or guess their way into a character. Each can be overridden from the
// environment; the tests use that to make them small enough to hit.

const SETTINGS = {
  // Open connections at once, across everyone and from one address. Players
  // behind one home or campus router share an address, so the per-address cap
  // leaves room for a few of them.
  maxConnections: { env: 'MUD_MAX_CONNECTIONS', fallback: 200 },
  maxConnectionsPerIp: { env: 'MUD_MAX_CONNECTIONS_PER_IP', fallback: 8 },

  // From TCP connect to standing in the world. Long enough for a new player to
  // read the banner and pick a passphrase; short enough that a connection
  // parked at the handle prompt does not hold a slot.
  loginTimeoutSeconds: { env: 'MUD_LOGIN_TIMEOUT_SECONDS', fallback: 120 },

  // Wrong passphrases allowed in FAILURE_WINDOW_MS. Checked before the scrypt
  // hash runs, so they also cap how much hashing one address can make us do.
  // The per-handle limit stops guessing spread across many addresses; it is
  // higher so one person cannot easily lock someone else out.
  loginFailuresPerIp: { env: 'MUD_LOGIN_FAILURES_PER_IP', fallback: 10 },
  loginFailuresPerHandle: { env: 'MUD_LOGIN_FAILURES_PER_HANDLE', fallback: 20 },

  // New characters from one address in ACCOUNT_WINDOW_MS.
  accountsPerIp: { env: 'MUD_ACCOUNTS_PER_IP', fallback: 3 },
};

export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

// Commands a player can fire off back to back, and how fast that allowance
// refills. Comfortably above typing speed, well below a script.
export const COMMAND_BURST = 20;
export const COMMANDS_PER_SECOND = 4;

// Output queued for a player whose client has stopped reading. Past this they
// are dropped rather than left to grow the server's memory without end.
export const MAX_OUTPUT_BACKLOG = 256 * 1024;

export function readLimits(env = process.env) {
  const limits = {};
  for (const [name, { env: variable, fallback }] of Object.entries(SETTINGS)) {
    limits[name] = readPositiveInteger(env, variable, fallback);
  }
  return limits;
}

// A typo in a limit should stop the server, not quietly switch the limit off.
function readPositiveInteger(env, variable, fallback) {
  const raw = env[variable];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${variable} must be a whole number of 1 or more, not "${raw}"`);
  }
  return value;
}
