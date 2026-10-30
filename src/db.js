import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

export async function openDatabase({ dataDir, url, authToken } = {}) {
  let client;
  if (url) {
    client = createClient({ url, authToken });
  } else {
    if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error('TURSO_DATABASE_URL belum diatur di Netlify Environment Variables.');
    }
    const dir = dataDir || 'data';
    fs.mkdirSync(dir, { recursive: true });
    client = createClient({ url: `file:${path.join(dir, 'app.db')}` });
  }

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS batches (
      batch_date       TEXT PRIMARY KEY,
      status           TEXT NOT NULL DEFAULT 'open',
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

  return client;
}
