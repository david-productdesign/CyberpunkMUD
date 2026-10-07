// The defences against abuse: connection caps, the login deadline, passphrase
// and account-creation throttles, flood control, output backlog, and the
// filtering of characters that could tamper with other players' screens.
//
// Real servers are started with tiny limits so each one can be hit in seconds.
// The small building blocks are tested directly with fake clocks.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { createBucket } from '../src/net/rate.js';
import { createGate, normaliseIp } from '../src/net/gate.js';
import { createWindowCounter } from '../src/game/throttle.js';
import { createTerminalInput } from '../src/net/terminal.js';
import { readLimits, MAX_OUTPUT_BACKLOG, COMMAND_BURST } from '../src/net/limits.js';
import { createSession, write } from '../src/net/session.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const servers = [];

after(() => {
  for (const server of servers) {
    server.process.kill();
    rmSync(server.workDir, { recursive: true, force: true });
  }
});

// --- a server with its own limits ---------------------------------------------

async function startServer(limits) {
  const workDir = mkdtempSync(join(tmpdir(), 'mud-limits-'));
  const env = {
    ...process.env,
    MUD_DB: join(workDir, 'test.db'),
    MUD_HOST: '127.0.0.1',
    MUD_PORT: '0',
    MUD_HOST_KEY: join(workDir, 'host_key'),
    ...limits,
  };
  execFileSync(process.execPath, [join(root, 'seed.js')], { cwd: root, env });

  const child = spawn(process.execPath, [join(root, 'server.js')], { cwd: root, env });
  const server = { process: child, workDir, log: '', port: 0 };
  servers.push(server);
  child.stdout.on('data', (chunk) => {
    server.log += chunk;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  const deadline = Date.now() + 10000;
  while (!server.port) {
    if (Date.now() > deadline) throw new Error(`server never reported its port:\n${server.log}`);
    const listening = server.log.match(/ssh listening on \S+:(\d+)/);
    if (listening) server.port = Number(listening[1]);
    await delay(15);
  }
  return server;
}

async function waitForLog(server, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(server.log)) {
    if (Date.now() > deadline) throw new Error(`server never logged ${pattern}\n--- log ---\n${server.log}`);
    await delay(15);
  }
}

// --- clients ------------------------------------------------------------------

// A bare TCP connection that never speaks SSH. Resolves once connected. It
// still reads (and ignores) the server's greeting: a socket that never reads
// never sees the server hang up either.
function openRawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
    socket.resume();
  });
}

function waitForSocketClose(socket, timeoutMs = 5000, label = 'the socket') {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} stayed open`)), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// An SSH client with a pty, as `ssh -p <port> anyone@host` would open.
function connect(server) {
  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client();
    conn.on('error', reject);
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, stream) => {
        if (error) return reject(error);
        stream.setEncoding('utf8');
        const client = { conn, socket: stream, text: '', cursor: 0, closed: false };
        stream.on('data', (chunk) => {
          client.text += chunk;
        });
        conn.on('close', () => {
          client.closed = true;
        });
        resolve(client);
      });
    });
    conn.connect({ host: '127.0.0.1', port: server.port, username: 'anyone' });
  });
}

function say(client, line) {
  client.socket.write(`${line}\r`);
}

async function waitFor(client, pattern, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unread = client.text.slice(client.cursor);
    const match = unread.match(pattern);
    if (match) {
      const end = match.index + match[0].length;
      client.cursor += end;
      return unread.slice(0, end);
    }
    await delay(15);
  }
  throw new Error(`timed out waiting for ${pattern}\n--- unread ---\n${client.text.slice(client.cursor)}`);
}

async function waitUntilClosed(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!client.closed) {
    if (Date.now() > deadline) throw new Error('the SSH connection stayed open');
    await delay(15);
  }
}

async function createCharacter(client, name, passphrase) {
  await waitFor(client, /Operative handle: /);
  say(client, name);
  await waitFor(client, /Create a new operative\? \(y\/n\) /);
  say(client, 'y');
  await waitFor(client, /Choose a passphrase: /);
  say(client, passphrase);
  await waitFor(client, /Confirm passphrase: /);
  say(client, passphrase);
  await waitFor(client, /Neon Alley[\s\S]*?hp\] > /);
}

async function tryPassphrase(client, name, passphrase) {
  await waitFor(client, /Operative handle: /);
  say(client, name);
  await waitFor(client, /Passphrase: /);
  say(client, passphrase);
}

// --- against a running server ---------------------------------------------------

test('connections and logins are limited per address', async (t) => {
  const server = await startServer({
    MUD_MAX_CONNECTIONS_PER_IP: '3',
    MUD_LOGIN_TIMEOUT_SECONDS: '2',
    MUD_LOGIN_FAILURES_PER_IP: '2',
    MUD_ACCOUNTS_PER_IP: '1',
  });

  await t.test('one address cannot hold more than its share of connections', async () => {
    const held = await Promise.all([1, 2, 3].map(() => openRawSocket(server.port)));
    const extra = await openRawSocket(server.port);
    await waitForSocketClose(extra, 1000, 'the connection over the cap');
    await waitForLog(server, /connection refused: too many connections from this address ip=127\.0\.0\.1/);

    held[0].destroy();
    await delay(100); // the server notices the close and frees the slot
    const replacement = await openRawSocket(server.port);
    await delay(200);
    assert.equal(replacement.destroyed, false, 'a freed slot can be used again');

    for (const socket of [...held, replacement]) socket.destroy();
    await delay(100);
  });

  await t.test('a connection that never speaks SSH is dropped at the login deadline', async () => {
    const silent = await openRawSocket(server.port);
    await delay(1000);
    assert.equal(silent.destroyed, false, 'still open before the deadline');
    await waitForSocketClose(silent, 3000, 'the silent connection');
    await waitForLog(server, /login timed out ip=127\.0\.0\.1/);
  });

  await t.test('a player who never finishes logging in is told and dropped', async () => {
    const idler = await connect(server);
    await waitFor(idler, /Operative handle: /);
    await waitFor(idler, /Took too long to log in\. The link drops\./, 4000);
    await waitUntilClosed(idler);
  });

  let rev;

  await t.test('the first new character from an address is created and logged', async () => {
    rev = await connect(server);
    await createCharacter(rev, 'Rev', 'hunter22');
    await waitForLog(server, /account created handle=Rev ip=127\.0\.0\.1/);
  });

  await t.test('logging in in time is not cut off by the deadline', async () => {
    await delay(2500);
    say(rev, 'look');
    await waitFor(rev, /Neon Alley/);
    assert.equal(rev.closed, false);
  });

  await t.test('a second new character from the same address is refused', async () => {
    const second = await connect(server);
    await waitFor(second, /Operative handle: /);
    say(second, 'Mox');
    await waitFor(second, /Create a new operative\? \(y\/n\) /);
    say(second, 'y');
    const reply = await waitFor(second, /Operative handle: /);
    assert.match(reply, /Too many new operatives from your address lately/);
    assert.doesNotMatch(reply, /Choose a passphrase/, 'refused before any passphrase is hashed');
    await waitForLog(server, /account creation refused: limit reached ip=127\.0\.0\.1/);
    second.conn.end();
  });

  await t.test('flooding commands is refused once, then normal play resumes', async () => {
    rev.socket.write('look\r'.repeat(40));
    await delay(500);
    const flooded = rev.text.slice(rev.cursor);
    rev.cursor = rev.text.length;
    const warnings = flooded.match(/Slow down\. Your deck is dropping commands\./g) ?? [];
    assert.equal(warnings.length, 1, 'one warning, not one per dropped line');
    // About one burst's worth: the previous step's `look` spent a token, and a
    // token or two can refill while the 40 lines are handled.
    const looks = (flooded.match(/Neon Alley/g) ?? []).length;
    assert.ok(
      looks >= COMMAND_BURST - 2 && looks <= COMMAND_BURST + 2,
      `about ${COMMAND_BURST} of the 40 should get through, not ${looks}`,
    );

    await delay(1000);
    say(rev, 'look');
    await waitFor(rev, /Neon Alley/);
  });

  await t.test('wrong passphrases from one address lock it out before more hashing', async () => {
    const guesser = await connect(server);
    await tryPassphrase(guesser, 'Rev', 'wrong-one');
    await waitFor(guesser, /That passphrase is wrong\./);
    await waitForLog(server, /login failed handle=Rev ip=127\.0\.0\.1/);
    say(guesser, 'wrong-two');
    await waitFor(guesser, /That passphrase is wrong\./);
    say(guesser, 'hunter22'); // even the right one: the address is locked out
    await waitFor(guesser, /Too many wrong passphrases lately\. The link drops\./);
    await waitUntilClosed(guesser);
    await waitForLog(server, /login refused: address locked out handle=Rev ip=127\.0\.0\.1/);

    const retry = await connect(server);
    await waitFor(retry, /Operative handle: /);
    say(retry, 'Rev');
    await waitFor(retry, /Too many wrong passphrases lately/, 3000);
    await waitUntilClosed(retry);
  });

  rev.conn.end();
});

test('passphrase guessing is limited per handle, and players cannot send screen controls', async (t) => {
  const server = await startServer({
    MUD_LOGIN_FAILURES_PER_HANDLE: '2',
    MUD_ACCOUNTS_PER_IP: '5',
  });

  const ada = await connect(server);
  let bo = await connect(server);
  await createCharacter(ada, 'Ada', 'lattice9');
  await createCharacter(bo, 'Bom', 'quartz77');

  await t.test('a handle with too many wrong guesses is locked, other handles are not', async () => {
    const guesser = await connect(server);
    await tryPassphrase(guesser, 'Ada', 'nope-one');
    await waitFor(guesser, /That passphrase is wrong\./);
    say(guesser, 'nope-two');
    await waitFor(guesser, /That passphrase is wrong\./);
    say(guesser, 'lattice9');
    await waitFor(guesser, /Too many wrong passphrases lately/);
    await waitForLog(server, /login refused: handle locked out handle=Ada ip=127\.0\.0\.1/);

    // Same address, different handle: the address itself is not locked.
    // Logging in again takes over Bom's body, so this connection becomes Bom.
    const other = await connect(server);
    await tryPassphrase(other, 'Bom', 'quartz77');
    await waitFor(other, /Neon Alley/);
    await waitForLog(server, /login handle=Bom ip=127\.0\.0\.1/);
    bo = other;
  });

  await t.test('C1 and bidirectional controls never reach another player', async () => {
    // U+009B is a one-character "ESC [": with 2J it clears the screen.
    // U+202E reverses the text after it.
    say(ada, "'hi \u009b2J ‮esrever done");
    const heard = await waitFor(bo, /Ada says, "[^"]*done"/);
    assert.match(heard, /Ada says, "hi 2J esrever done"/);
    assert.ok(!heard.includes('\u009b') && !heard.includes('‮'));
  });

  ada.conn.end();
  bo.conn.end();
});

// --- the building blocks ---------------------------------------------------------

function fakeClock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

test('a command bucket allows a burst, then refills over time', () => {
  const clock = fakeClock();
  const bucket = createBucket({ capacity: 3, perSecond: 2, now: clock.now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  clock.advance(499);
  assert.equal(bucket.take(), false, 'not quite one token back yet');
  clock.advance(1);
  assert.equal(bucket.take(), true);
  clock.advance(60_000);
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false], 'refills only to capacity');
});

test('the gate caps connections overall and per address', () => {
  const gate = createGate({ maxConnections: 3, maxConnectionsPerIp: 2 });
  assert.equal(gate.admit('10.0.0.1'), null);
  assert.equal(gate.admit('10.0.0.1'), null);
  assert.equal(gate.admit('10.0.0.1'), 'too many connections from this address');
  assert.equal(gate.admit('10.0.0.2'), null);
  assert.equal(gate.admit('10.0.0.3'), 'server full');
  gate.release('10.0.0.1');
  assert.equal(gate.admit('10.0.0.3'), null, 'a released slot is free again');
  assert.equal(normaliseIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(normaliseIp('2001:db8::1'), '2001:db8::1');
});

test('a window counter forgets events once they age out', () => {
  const clock = fakeClock();
  const counter = createWindowCounter(1000, clock.now);
  counter.add('a');
  clock.advance(600);
  counter.add('a');
  counter.add('b');
  assert.equal(counter.count('a'), 2);
  clock.advance(500);
  assert.equal(counter.count('a'), 1, 'the first one is over a second old');
  assert.equal(counter.count('b'), 1);
  clock.advance(1000);
  assert.equal(counter.count('a'), 0);
});

test('terminal input drops display controls but keeps ordinary text', () => {
  const input = createTerminalInput(() => {}, 512, { echo: false });
  const lines = input.feed(Buffer.from('a\u0085b\u009bc‎d‪e⁧f؜g café ✓\r', 'utf8'));
  assert.deepEqual(lines, ['abcdefg café ✓']);
});

test('a player who stops reading output is cut off, once', () => {
  const socket = { destroyed: false, writableLength: 0, write(text) { this.writableLength += text.length; } };
  let aborts = 0;
  const session = createSession(socket, 1, { ip: '10.0.0.9', abort: () => (aborts += 1) });
  const chunk = 'x'.repeat(64 * 1024);
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 4; i += 1) write(session, chunk);
    assert.equal(aborts, 0, 'exactly at the limit is still allowed');
    write(session, 'x');
    write(session, 'y');
  } finally {
    console.log = originalLog;
  }
  assert.equal(MAX_OUTPUT_BACKLOG, 4 * 64 * 1024);
  assert.equal(aborts, 1);
});

test('limits come from the environment, and a bad value stops the server', () => {
  assert.equal(readLimits({}).maxConnectionsPerIp, 8);
  assert.equal(readLimits({ MUD_MAX_CONNECTIONS_PER_IP: '3' }).maxConnectionsPerIp, 3);
  assert.throws(() => readLimits({ MUD_ACCOUNTS_PER_IP: '0' }), /MUD_ACCOUNTS_PER_IP must be a whole number of 1 or more/);
  assert.throws(() => readLimits({ MUD_LOGIN_TIMEOUT_SECONDS: 'soon' }), /MUD_LOGIN_TIMEOUT_SECONDS/);
});
