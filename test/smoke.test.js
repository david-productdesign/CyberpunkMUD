// Drives real SSH clients against a real server on a throwaway database.
// Everything the milestone promises is asserted here: login, co-presence,
// movement broadcasts, take/drop visibility, and persistence across a reconnect.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workDir;
let server;
let port;
let hostFingerprint;

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'mud-test-'));
  const env = {
    ...process.env,
    MUD_DB: join(workDir, 'test.db'),
    MUD_HOST: '127.0.0.1',
    MUD_PORT: '0',
    MUD_HOST_KEY: join(workDir, 'host_key'),
    // Every character here comes from 127.0.0.1. limits.test.js covers the cap.
    MUD_ACCOUNTS_PER_IP: '50',
  };

  execFileSync(process.execPath, [join(root, 'seed.js')], { cwd: root, env });

  server = spawn(process.execPath, [join(root, 'server.js')], { cwd: root, env });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  const startup = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server never reported its port:\n${output}`)), 10000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const listening = output.match(/ssh listening on \S+:(\d+)/);
      const key = output.match(/ssh host key (SHA256:\S+)/);
      if (listening && key) {
        clearTimeout(timer);
        resolve({ port: Number(listening[1]), fingerprint: key[1] });
      }
    });
  });
  ({ port, fingerprint: hostFingerprint } = startup);
});

after(() => {
  server?.kill();
  rmSync(workDir, { recursive: true, force: true });
});

// --- a scripted SSH client ----------------------------------------------------

// Connects the way `ssh -p <port> anyone@host` would, checking the server's key
// against the fingerprint it logged. With `pty`, keystrokes go out raw, as a
// real terminal sends them, and the server does the echoing.
function connect({ pty = true } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new ssh2.Client();
    conn.on('error', reject);
    conn.on('ready', () => {
      conn.shell(pty ? { term: 'xterm-256color', cols: 80, rows: 24 } : false, (error, stream) => {
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
    conn.connect({
      host: '127.0.0.1',
      port,
      username: 'anyone',
      hostHash: 'sha256',
      hostVerifier: (hexDigest) =>
        `SHA256:${Buffer.from(hexDigest, 'hex').toString('base64').replace(/=+$/, '')}` === hostFingerprint,
    });
  });
}

// Raw keystrokes, exactly as a terminal would send them.
function type(client, keys) {
  client.socket.write(keys);
}

// A terminal sends Enter as a lone carriage return.
function say(client, line) {
  type(client, `${line}\r`);
}

// Pull the plug without saying goodbye, like a dropped network link.
function drop(client) {
  client.conn.destroy();
}

async function waitUntilClosed(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!client.closed) {
    if (Date.now() > deadline) throw new Error('the SSH connection stayed open');
    await delay(15);
  }
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
  const rev = await connect();
  const mox = await connect();

  await t.test('a new character can be created and lands in the start room', async () => {
    await createCharacter(rev, 'Rev', 'hunter22');
    assert.doesNotMatch(rev.text, /hunter22/, 'the passphrase is never echoed');
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

  const returning = await connect();

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
    drop(returning);
  });

  await t.test('a bad passphrase is rejected', async () => {
    const impostor = await connect();
    await waitFor(impostor, /Operative handle: /);
    say(impostor, 'Rev');
    await waitFor(impostor, /Passphrase: /);
    say(impostor, 'wrongwrong');
    await waitFor(impostor, /That passphrase is wrong\./);
    drop(impostor);
  });

  drop(rev);
  drop(mox);
});

// Move, and return everything up to the prompt that follows the new room, so
// whatever happened on arrival is included and nothing is left unread.
async function walk(client, direction, roomPattern) {
  say(client, direction);
  return waitFor(client, new RegExp(`${roomPattern.source}[\\s\\S]*?hp\\] > `));
}

test('laser trips', async (t) => {
  const kat = await connect();
  let zed = await connect();
  await createCharacter(kat, 'Kat', 'wirecut1');
  await createCharacter(zed, 'Zed', 'blastme2');

  await t.test('arming a trip is seen by its owner and hinted to the room', async () => {
    await walk(kat, 'north', /Ganzo's Noodle Stall/);
    await walk(zed, 'north', /Ganzo's Noodle Stall/);
    say(kat, 'trip');
    await waitFor(kat, /You string a laser trip/);
    await waitFor(zed, /Kat crouches by the entrance/);
    say(kat, 'look');
    const view = await waitFor(kat, /Exits:[^\r\n]*/);
    assert.match(view, /Your laser trip is armed here\./);
    say(zed, 'look');
    const zedView = await waitFor(zed, /Exits:[^\r\n]*/);
    assert.doesNotMatch(zedView, /laser trip/, 'only the owner sees the beam');
  });

  await t.test('the owner walks through their own trip', async () => {
    await walk(kat, 'south', /Neon Alley/);
    const view = await walk(kat, 'north', /Ganzo's Noodle Stall/);
    assert.doesNotMatch(view, /detonates/);
    assert.match(view, /\[30\/30hp\]/);
  });

  await t.test('another player walking in loses 15 HP', async () => {
    await walk(zed, 'south', /Neon Alley/);
    const view = await walk(zed, 'north', /Ganzo's Noodle Stall/);
    assert.match(view, /the trip detonates\. You take 15 damage\./);
    assert.match(view, /\[15\/30hp\]/);
    await waitFor(kat, /Zed walks into a laser trip\./);
  });

  await t.test('a trip only goes off once', async () => {
    await walk(zed, 'south', /Neon Alley/);
    const view = await walk(zed, 'north', /Ganzo's Noodle Stall/);
    assert.doesNotMatch(view, /detonates/);
    assert.match(view, /\[15\/30hp\]/);
  });

  await t.test('damage survives a reconnect', async () => {
    drop(zed);
    await waitFor(kat, /Zed unjacks and is gone\./);
    zed = await connect();
    await waitFor(zed, /Operative handle: /);
    say(zed, 'Zed');
    await waitFor(zed, /Passphrase: /);
    say(zed, 'blastme2');
    await waitFor(zed, /Ganzo's Noodle Stall/);
    say(zed, 'look');
    await waitFor(zed, /\[15\/30hp\] > /);
  });

  await t.test('arming a new trip powers down the old one', async () => {
    say(kat, 'trip');
    await waitFor(kat, /You string a laser trip/);
    await walk(kat, 'south', /Neon Alley/);
    say(kat, 'trip');
    await waitFor(kat, /Your old laser trip in Ganzo's Noodle Stall powers down\./);
    await walk(kat, 'east', /Grey Market/);

    // The noodle stall is clear now: walking out of it is safe.
    say(zed, 'look');
    await waitFor(zed, /Exits:[^\r\n]*/);
  });

  await t.test('a trip that takes the last HP flatlines the victim', async () => {
    say(zed, 'south');
    await waitFor(zed, /You take 15 damage\./);
    await waitFor(kat, /Your laser trip in Neon Alley goes off\. Zed caught it and flatlined\./);

    // Nothing typed during the sequence reaches the world.
    say(zed, 'look');
    await waitFor(zed, /You are flatlined\. Nothing you do reaches the world\./);

    const sequence = await waitFor(zed, /Mama Vex's Ripperdoc Clinic[\s\S]*?hp\] > /, 15000);
    assert.match(sequence, /BPM 0/);
    assert.ok(sequence.includes('███████╗██╗      █████╗ ████████╗'), 'the FLATLINE banner is shown');
    assert.match(sequence, /\[30\/30hp\] > $/, 'back at full HP');
  });

  await t.test('the revived player is back in the world', async () => {
    const view = await walk(zed, 'south', /Grey Market/);
    assert.match(view, /Kat is here\./);
    await waitFor(kat, /Zed arrives from the north\./);
  });

  await t.test('a room holds only one trip', async () => {
    say(zed, 'trip');
    await waitFor(zed, /You string a laser trip/);
    say(kat, 'trip');
    await waitFor(kat, /Someone else already has a beam strung across this room\./);
  });

  drop(zed);
  drop(kat);
});

test('the terminal', async (t) => {
  const ash = await connect();
  const bea = await connect();

  await t.test('the banner says the link is encrypted', async () => {
    await waitFor(ash, /Operative handle: /);
    assert.match(ash.text, /This link is encrypted\./);
  });

  await t.test('a handle is echoed and a passphrase is not', async () => {
    type(ash, 'Ash\r');
    const echoed = await waitFor(ash, /Create a new operative\? \(y\/n\) /);
    assert.match(echoed, /^Ash\r\n/, 'the handle is echoed back as it is typed');
    type(ash, 'y\r');
    await waitFor(ash, /Choose a passphrase: /);
    type(ash, 'neonrain\r');
    const afterSecret = await waitFor(ash, /Confirm passphrase: /);
    assert.doesNotMatch(afterSecret, /neonrain/);
    type(ash, 'neonrain\r');
    const arrival = await waitFor(ash, /Neon Alley/);
    assert.doesNotMatch(arrival, /neonrain/);
  });

  await t.test('a second player arrives', async () => {
    await createCharacter(bea, 'Bea', 'copper55');
    await waitFor(ash, /Bea arrives\./);
  });

  await t.test('backspace edits the line on screen and in the command', async () => {
    type(ash, 'loox\x7fk\r');
    const view = await waitFor(ash, /Exits:[^\r\n]*/);
    assert.match(view, /hp\] > \x1b\[0mloox\x08 \x08k\r\n/);
    assert.match(view, /Bea is here\./);
  });

  await t.test('arrow keys are ignored rather than typed', async () => {
    type(ash, '\x1b[A\x1b[Dlook\r');
    const view = await waitFor(ash, /Exits:[^\r\n]*/);
    assert.match(view, /hp\] > \x1b\[0mlook\r\n/);
  });

  await t.test('a half-typed line is redrawn after an interruption', async () => {
    await waitFor(ash, /hp\] > /);
    type(ash, "'hel");
    await waitFor(ash, /'hel/);
    say(bea, 'emote waves');
    const redraw = await waitFor(ash, /Bea waves\r\n[^\r\n]*hp\] > [^']*'hel/);
    assert.ok(redraw);
    type(ash, 'lo\r');
    await waitFor(bea, /Ash says, "hello"/);
  });

  await t.test('without a pty, whole lines still work and nothing is echoed', async () => {
    const plain = await connect({ pty: false });
    await waitFor(plain, /Operative handle: /);
    type(plain, 'Ash\n');
    const reply = await waitFor(plain, /Passphrase: /);
    assert.doesNotMatch(reply, /^Ash/);
    plain.conn.end();
  });

  await t.test('a connection gets only one game', async () => {
    await assert.rejects(
      new Promise((resolve, reject) => ash.conn.shell((error, stream) => (error ? reject(error) : resolve(stream)))),
    );
  });

  await t.test('quitting closes the SSH connection', async () => {
    type(ash, 'quit\r');
    await waitFor(ash, /You unjack\./);
    await waitFor(bea, /Ash unjacks and is gone\./);
    await waitUntilClosed(ash);
  });

  await t.test('a dropped SSH connection is announced', async () => {
    const back = await connect();
    await waitFor(back, /Operative handle: /);
    type(back, 'Ash\r');
    await waitFor(back, /Passphrase: /);
    type(back, 'neonrain\r');
    await waitFor(back, /Neon Alley/);
    await waitFor(bea, /Ash jacks back in\./);
    back.conn.end();
    await waitFor(bea, /Ash unjacks and is gone\./);
  });

  drop(bea);
});
