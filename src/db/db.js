import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

// Open (creating if needed) the game database and make sure the schema is present.
export function openDatabase(path = process.env.MUD_DB || 'mud.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}
