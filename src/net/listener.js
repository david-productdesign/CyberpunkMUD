import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import ssh2 from 'ssh2';
import { MAX_LINE, send, hangUp } from './session.js';
import { createTerminalInput } from './terminal.js';
import { openConnection, dropIdle, IDLE_MS } from './connection.js';
import { createGate, normaliseIp } from './gate.js';
import { red } from './ansi.js';

const { Server, utils } = ssh2;

// After telling a slow player why they are being dropped, how long their
// client gets to close politely before the socket is cut.
const GOODBYE_GRACE_MS = 2000;

export function startServer(ctx, { host, port, hostKeyPath }) {
  const hostKey = loadHostKey(hostKeyPath);
  const ssh = new Server({ hostKeys: [hostKey] });
  const gate = createGate(ctx.limits);
  const links = new Map(); // "ip:port" -> link, for matching ssh2's clients to our sockets

  ssh.on('connection', (client, info) => {
    const link = links.get(linkKey(info.ip, info.port));
    if (!link) return client.end(); // the socket closed before ssh2 got this far
    handleClient(ctx, client, link);
  });

  // ssh2 only hears about a connection once the client has sent its SSH
  // greeting, so a socket that never sends one would be invisible to it and
  // held open for good. We accept sockets ourselves, apply the limits and the
  // login deadline, and only then hand them to ssh2.
  const server = createServer((socket) => acceptSocket(ctx, ssh, gate, links, socket));
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`ssh listening on ${address.address}:${address.port}`);
  });

  return server;
}

function linkKey(ip, port) {
  return `${ip}:${port}`;
}

// A link is everything we know about one TCP connection, shared between the
// socket and the game session that eventually runs over it.
function acceptSocket(ctx, ssh, gate, links, socket) {
  const ip = normaliseIp(socket.remoteAddress);
  const refusal = gate.admit(ip);
  if (refusal) {
    console.log(`connection refused: ${refusal} ip=${ip}`);
    socket.destroy();
    return;
  }

  const key = linkKey(socket.remoteAddress, socket.remotePort);
  const link = { ip, socket, session: null };
  links.set(key, link);
  console.log(`connection ip=${ip}`);

  const deadline = setTimeout(() => enforceLoginDeadline(link), ctx.limits.loginTimeoutSeconds * 1000);
  socket.on('close', () => {
    clearTimeout(deadline);
    links.delete(key);
    gate.release(ip);
  });
  // Synchronously, so ssh2's own error listener is on the socket before any
  // I/O can happen.
  ssh.injectSocket(socket);
}

function enforceLoginDeadline(link) {
  const { session, socket } = link;
  if (session?.playerId) return; // made it into the world in time

  console.log(`login timed out ip=${link.ip}`);
  if (!session) {
    socket.destroy(); // never got as far as a shell, so there is no one to tell
    return;
  }
  send(session, red('Took too long to log in. The link drops.'));
  hangUp(session);
  setTimeout(() => socket.destroy(), GOODBYE_GRACE_MS).unref();
}

// The host key is what lets a returning player know they reached the same
// server. Losing it means every client warns that the key changed.
function loadHostKey(path) {
  if (!existsSync(path)) {
    const { private: privateKey } = utils.generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey, { mode: 0o600, flag: 'wx' });
    console.log(`generated a new ssh host key at ${path}`);
  }

  const key = readFileSync(path);
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) {
    throw new Error(`cannot read ssh host key ${path}: ${parsed.message}`);
  }
  console.log(`ssh host key ${fingerprint(parsed.getPublicSSH())}`);
  return key;
}

// The same SHA256:... string `ssh` shows when it asks whether to trust a host.
function fingerprint(publicKey) {
  const digest = createHash('sha256').update(publicKey).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

function handleClient(ctx, client, link) {
  let shellOpened = false;

  // Any SSH login is let in. The game asks for a handle and passphrase itself;
  // SSH is only here so that exchange is encrypted.
  client.on('authentication', (auth) => auth.accept());

  client.on('session', (accept, reject) => {
    // One game per connection; a second shell on the same link is refused.
    if (shellOpened) return reject();
    shellOpened = true;

    const sshSession = accept();
    let hasPty = false;

    sshSession.on('pty', (acceptPty) => {
      hasPty = true;
      acceptPty?.();
    });
    sshSession.on('window-change', (acceptChange) => acceptChange?.());
    sshSession.on('shell', (acceptShell) => startShell(ctx, client, link, acceptShell(), hasPty));
  });

  client.on('error', (error) => {
    if (error.code === 'ECONNRESET') return; // a dropped connection is not an exception
    console.error(`ssh connection failed: ${error.message}`);
  });
}

function startShell(ctx, client, link, channel, hasPty) {
  const session = openConnection(ctx, channel, {
    ip: link.ip,
    input: (writeRaw) => createTerminalInput(writeRaw, MAX_LINE, { echo: hasPty }),
    // Without an exit status, `ssh` reports the session as a failure (255).
    end: () => {
      channel.exit(0);
      channel.end();
    },
    // A polite end would queue behind output the client is not reading.
    abort: () => link.socket.destroy(),
  });
  link.session = session;

  // Unlike a socket, a channel has no idle timeout of its own.
  const idle = setTimeout(() => dropIdle(session), IDLE_MS);
  channel.on('data', () => idle.refresh());

  channel.on('close', () => {
    clearTimeout(idle);
    client.end(); // the game is over for this connection, so is the connection
  });
}
