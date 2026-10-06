import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { MAX_LINE } from './session.js';
import { createTerminalInput } from './terminal.js';
import { openConnection, dropIdle, IDLE_MS } from './connection.js';

const { Server, utils } = ssh2;

export function startServer(ctx, { host, port, hostKeyPath }) {
  const hostKey = loadHostKey(hostKeyPath);
  const server = new Server({ hostKeys: [hostKey] }, (client) => handleClient(ctx, client));

  server.listen(port, host, () => {
    const address = server.address();
    console.log(`ssh listening on ${address.address}:${address.port}`);
  });

  return server;
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

function handleClient(ctx, client) {
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
    sshSession.on('shell', (acceptShell) => startShell(ctx, client, acceptShell(), hasPty));
  });

  client.on('error', (error) => {
    if (error.code === 'ECONNRESET') return; // a dropped connection is not an exception
    console.error(`ssh connection failed: ${error.message}`);
  });
}

function startShell(ctx, client, channel, hasPty) {
  const session = openConnection(ctx, channel, {
    input: (writeRaw) => createTerminalInput(writeRaw, MAX_LINE, { echo: hasPty }),
    // Without an exit status, `ssh` reports the session as a failure (255).
    end: () => {
      channel.exit(0);
      channel.end();
    },
  });

  // Unlike a socket, a channel has no idle timeout of its own.
  const idle = setTimeout(() => dropIdle(session), IDLE_MS);
  channel.on('data', () => idle.refresh());

  channel.on('close', () => {
    clearTimeout(idle);
    client.end(); // the game is over for this connection, so is the connection
  });
}
