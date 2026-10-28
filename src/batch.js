import { batchDateOf, cutoffInstant, cutoffToString, openBatchDateOf, parseCutoff } from './time.js';

export const LIMITS = { name: 60, food: 200, notes: 200, quantity: 50 };
export const DEFAULT_CUTOFF = { hour: 11, minute: 0 };

export class ValidationError extends Error {}
export class BatchClosedError extends Error {}

/**
 * Logika batch harian. `now` bisa di-inject agar mudah diuji.
 */
export class BatchService {
  constructor(db, { now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
  }

  /** Jam tutup harian (WIB), disimpan di database dan diubah lewat halaman admin. */
  get cutoff() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'cutoff_time'").get();
    return parseCutoff(row?.value) ?? DEFAULT_CUTOFF;
  }

  setCutoff(value) {
    const cutoff = parseCutoff(value);
    if (!cutoff) throw new ValidationError('Jam tutup tidak valid (format JJ:MM, 00:00–23:59).');
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('cutoff_time', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(cutoffToString(cutoff));
    return cutoff;
  }

  ensureBatch(batchDate) {
    this.db.prepare('INSERT OR IGNORE INTO batches (batch_date) VALUES (?)').run(batchDate);
    return this.getBatch(batchDate);
  }

  getBatch(batchDate) {
    return this.db.prepare('SELECT * FROM batches WHERE batch_date = ?').get(batchDate) ?? null;
  }

  /** Batch yang sedang menerima pesanan: hari ini sebelum cutoff, besok setelahnya. */
  openBatchDate(now = this.now()) {
    return openBatchDateOf(this.cutoff, now);
  }

  /** Status batch yang sedang dibuka, untuk ditampilkan di halaman. */
  currentStatus() {
    const now = this.now();
    const batchDate = this.openBatchDate(now);
    const batch = this.getBatch(batchDate);
    return {
      batchDate,
      today: batchDateOf(now),
      open: !batch || batch.status === 'open',
      cutoffAt: cutoffInstant(batchDate, this.cutoff).toISOString(),
      serverTime: now.toISOString(),
    };
  }

  listOrders(batchDate) {
    return this.db
      .prepare('SELECT * FROM orders WHERE batch_date = ? ORDER BY created_at, id')
      .all(batchDate);
  }

  placeOrder(input) {
    const order = validateOrder(input);
    const now = this.now();
    const batchDate = this.openBatchDate(now);
    const batch = this.ensureBatch(batchDate);
    // Normalnya selalu "open"; berjaga-jaga bila batch sudah ditutup lebih awal.
    if (batch.status !== 'open') {
      throw new BatchClosedError('Batch ini sudah ditutup.');
    }
    const info = this.db
      .prepare(`INSERT INTO orders (batch_date, name, food, quantity, notes, created_at)
                VALUES (@batchDate, @name, @food, @quantity, @notes, @createdAt)`)
      .run({ ...order, batchDate, createdAt: now.toISOString() });
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  }

  deleteOrder(id) {
    return this.db.prepare('DELETE FROM orders WHERE id = ?').run(id).changes > 0;
  }

  markClosed(batchDate) {
    this.ensureBatch(batchDate);
    this.db
      .prepare(`UPDATE batches SET status = 'closed', closed_at = COALESCE(closed_at, ?)
                WHERE batch_date = ? AND status = 'open'`)
      .run(this.now().toISOString(), batchDate);
  }

  /** Buka kembali batch: pesanan tetap ada, riwayat penutupan & pengiriman dihapus. */
  reopen(batchDate) {
    this.db
      .prepare(`UPDATE batches SET status = 'open', closed_at = NULL, sent_at = NULL, send_attempts = 0,
                last_attempt_at = NULL, last_error = NULL WHERE batch_date = ?`)
      .run(batchDate);
    return this.getBatch(batchDate);
  }

  recordAttempt(batchDate, error) {
    const now = this.now().toISOString();
    if (error) {
      this.db
        .prepare(`UPDATE batches SET send_attempts = send_attempts + 1, last_attempt_at = ?,
                  last_error = ? WHERE batch_date = ?`)
        .run(now, String(error.message || error).slice(0, 1000), batchDate);
    } else {
      this.db
        .prepare(`UPDATE batches SET status = 'sent', sent_at = ?, send_attempts = send_attempts + 1,
                  last_attempt_at = ?, last_error = NULL WHERE batch_date = ?`)
        .run(now, now, batchDate);
    }
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function validateOrder(input = {}) {
  const name = cleanText(input.name);
  const food = cleanText(input.food);
  const notes = cleanText(input.notes);
  const quantity = input.quantity === undefined || input.quantity === '' ? 1 : Number(input.quantity);

  if (!name) throw new ValidationError('Nama wajib diisi.');
  if (!food) throw new ValidationError('Makanan wajib diisi.');
  if (name.length > LIMITS.name) throw new ValidationError(`Nama maksimal ${LIMITS.name} karakter.`);
  if (food.length > LIMITS.food) throw new ValidationError(`Makanan maksimal ${LIMITS.food} karakter.`);
  if (notes.length > LIMITS.notes) throw new ValidationError(`Catatan maksimal ${LIMITS.notes} karakter.`);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.quantity) {
    throw new ValidationError(`Jumlah harus bilangan bulat 1–${LIMITS.quantity}.`);
  }
  return { name, food, quantity, notes };
}
