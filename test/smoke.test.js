// Drives real telnet clients against a real server on a throwaway database.
// Everything the milestone promises is asserted here: login, co-presence,
// movement broadcasts, take/drop visibility, and persistence across a reconnect.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workDir;
let server;
let port;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'mud-test-'));
  const env = { ...process.env, MUD_DB: join(workDir, 'test.db'), MUD_HOST: '127.0.0.1', MUD_PORT: '0' };

  execFileSync(process.execPath, [join(root, 'seed.js')], { cwd: root, env });

  server = spawn(process.execPath, [join(root, 'server.js')], { cwd: root, env });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server never reported a port')), 10000);
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/listening on \S+:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
});

after(() => {
  server?.kill();
  rmSync(workDir, { recursive: true, force: true });
});

// --- a scripted telnet client -------------------------------------------------

function connect() {
  const socket = net.createConnection(port, '127.0.0.1');
  // latin1 keeps raw telnet bytes visible as characters so we can assert on them.
  socket.setEncoding('latin1');
  const client = { socket, text: '', cursor: 0 };
  socket.on('data', (chunk) => {
    client.text += chunk;
  });
  socket.on('error', () => {});
  return client;
}

function say(client, line) {
  client.socket.write(`${line}\r\n`);
}

// Wait for a pattern in output we have not already consumed, and return
// everything from the cursor through the match.
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

async function createCharacter(client, name, passphrase) {
  await waitFor(client, /Operative handle: /);
  say(client, name);
  await waitFor(client, /Create a new operative\? \(y\/n\) /);
  say(client, 'y');
  await waitFor(client, /Choose a passphrase: /);
  say(client, passphrase);
  await waitFor(client, /Confirm passphrase: /);
  say(client, passphrase);
  await waitFor(client, /Neon Alley/);
}

// --- the test -----------------------------------------------------------------

test('two operatives share Sector 7', async (t) => {
  const rev = connect();
  const mox = connect();

  await t.test('a new character can be created and lands in the start room', async () => {
    await createCharacter(rev, 'Rev', 'hunter22');
    // The server offers to echo on our behalf, which is what hides the passphrase.
    assert.match(rev.text, /\xff\xfb\x01/, 'server should send IAC WILL ECHO before a passphrase');
  });

  await t.test('players see each other arrive', async () => {
    await createCharacter(mox, 'Mox', 'chrome99');
    await waitFor(rev, /Mox arrives\./);
  });

  await t.test('who lists everyone online', async () => {
    say(rev, 'who');
    const listing = await waitFor(rev, /2 operatives jacked in:[\s\S]*?Mox\s+\S[^\r\n]*/);
    assert.match(listing, /Rev/);
    assert.match(listing, /Mox/);
  });

  await t.test('look shows the other player in the room', async () => {
    say(rev, 'look');
    const view = await waitFor(rev, /Exits:[^\r\n]*/);
    assert.match(view, /Neon Alley/);
    assert.match(view, /Mox is here\./);
    assert.match(view, /scuffed credchip/);
  });

  await t.test('movement is announced to both rooms', async () => {
    say(mox, 'north');
    await waitFor(mox, /Ganzo's Noodle Stall/);
    await waitFor(rev, /Mox heads north\./);
  });

  await t.test('taking an object removes it from the room for everyone', async () => {
    say(mox, 'take ramen');
    await waitFor(mox, /You pick up a carton of cold ramen\./);

    say(rev, 'north');
    const view = await waitFor(rev, /Exits:[^\r\n]*/);
    assert.match(view, /Ganzo's Noodle Stall/);
    assert.match(view, /Mox is here\./);
    assert.doesNotMatch(view, /carton of cold ramen/, 'the ramen is in Mox\'s hands, not on the counter');
  });

  await t.test('scenery cannot be taken', async () => {
    say(mox, 'south');
    await waitFor(mox, /Neon Alley/);
    say(mox, 'east');
    await waitFor(mox, /Grey Market/);
    say(mox, 'take tarp');
    await waitFor(mox, /not going anywhere with you/);
    say(mox, 'west');
    say(mox, 'north');
    await waitFor(mox, /Ganzo's Noodle Stall/);
  });

  await t.test('say and emote reach the room', async () => {
    say(rev, "'the ramen was mine");
    await waitFor(mox, /Rev says, "the ramen was mine"/);
    say(mox, ':shrugs, chewing');
    await waitFor(rev, /Mox shrugs, chewing/);
  });

  await t.test('an unknown verb is refused', async () => {
    say(rev, 'flimflam');
    await waitFor(rev, /"flimflam" is not in your deck's command set/);
  });

  await t.test('a blocked exit is refused', async () => {
    say(rev, 'west');
    await waitFor(rev, /There is no way west from here\./);
  });

  await t.test('quitting is announced', async () => {
    say(mox, 'quit');
    await waitFor(rev, /Mox unjacks and is gone\./);
  });

  const returning = connect();

  await t.test('room and inventory survive a reconnect', async () => {
    await waitFor(returning, /Operative handle: /);
    say(returning, 'Mox');
    await waitFor(returning, /Passphrase: /);
    say(returning, 'chrome99');
    // Back in the room they logged out of, still holding what they picked up.
    await waitFor(returning, /Ganzo's Noodle Stall/);
    say(returning, 'i');
    await waitFor(returning, /You are carrying:[\s\S]*carton of cold ramen/);
  });

  await t.test('dropping puts it back on the ground for everyone', async () => {
    say(returning, 'drop ramen');
    await waitFor(returning, /You drop a carton of cold ramen\./);
    await waitFor(rev, /Mox drops a carton of cold ramen\./);
    returning.socket.destroy();
  });

  await t.test('a bad passphrase is rejected', async () => {
    const impostor = connect();
    await waitFor(impostor, /Operative handle: /);
    say(impostor, 'Rev');
    await waitFor(impostor, /Passphrase: /);
    say(impostor, 'wrongwrong');
    await waitFor(impostor, /That passphrase is wrong\./);
    impostor.socket.destroy();
  });

  rev.socket.destroy();
  mox.socket.destroy();
});
