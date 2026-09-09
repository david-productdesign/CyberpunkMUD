// Player rows. Reads happen at login; writes happen on room change and on
// disconnect, which is often enough that a crash costs a player nothing.

export function findPlayerByName(db, name) {
  // The name column is COLLATE NOCASE, so this lookup is case-insensitive.
  return db.prepare('SELECT * FROM players WHERE name = ?').get(name) ?? null;
}

export function findPlayerById(db, id) {
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) ?? null;
}

export function createPlayer(db, { name, hash, salt, roomId }) {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO players (name, password_hash, password_salt, room_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, hash, salt, roomId, now, now);
  return findPlayerById(db, Number(result.lastInsertRowid));
}

// Write a live session's mutable state back to its row.
export function savePlayer(db, session) {
  if (!session.playerId) return;
  db.prepare('UPDATE players SET room_id = ?, hp = ?, last_seen_at = ? WHERE id = ?')
    .run(session.roomId, session.hp, Date.now(), session.playerId);
}
