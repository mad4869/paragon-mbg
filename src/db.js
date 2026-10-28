import fs from 'node:fs';
import path from 'node:path';
// SQLite bawaan Node.js (>= 22.13): tidak perlu kompilasi, Python, atau build tools.
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS batches (
      batch_date       TEXT PRIMARY KEY,           -- YYYY-MM-DD (WIB)
      status           TEXT NOT NULL DEFAULT 'open', -- open | closed | sent
      closed_at        TEXT,
      sent_at          TEXT,
      send_attempts    INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  TEXT,
      last_error       TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_date  TEXT NOT NULL REFERENCES batches(batch_date),
      name        TEXT NOT NULL,
      food        TEXT NOT NULL,
      quantity    INTEGER NOT NULL DEFAULT 1,
      notes       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_batch ON orders(batch_date);

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);

  return db;
}
