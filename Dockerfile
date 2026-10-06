# CyberpunkMUD — one container, one SSH port, state on a volume at /data.
#
#   docker compose up --build      local, via compose.yaml
#   docker build -t cyberpunkmud . then run with a volume on /data and port 4022

# Pinned to the Bun version the test suite has been run against.
FROM oven/bun:1.4.2-slim

WORKDIR /app

# Dependencies first, so editing game code does not re-run the install.
# bunfig.toml keeps ssh2's optional native add-on out of the image.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY server.js seed.js ./
COPY src ./src
COPY world ./world

# The database and the SSH host key both live on the volume. Losing the key
# makes every returning player's ssh warn that the server has changed.
ENV MUD_HOST=0.0.0.0 \
    MUD_PORT=4022 \
    MUD_DB=/data/mud.db \
    MUD_HOST_KEY=/data/ssh_host_ed25519_key

# A fresh named volume copies this directory's ownership, so the bun user can write to it.
RUN mkdir /data && chown bun:bun /data
USER bun

EXPOSE 4022

# Seeding is idempotent and picks up world file changes shipped in a new image.
# `exec` hands PID 1 to Bun, so `docker stop` reaches the server's SIGTERM
# handler and everyone is saved, instead of stopping at the shell.
CMD ["sh", "-c", "bun seed.js && exec bun server.js"]
