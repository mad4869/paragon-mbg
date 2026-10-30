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
  async getCutoff() {
    const res = await this.db.execute("SELECT value FROM settings WHERE key = 'cutoff_time'");
    return parseCutoff(res.rows[0]?.value) ?? DEFAULT_CUTOFF;
  }

  async setCutoff(value) {
    const cutoff = parseCutoff(value);
    if (!cutoff) throw new ValidationError('Jam tutup tidak valid (format JJ:MM, 00:00–23:59).');
    await this.db.execute({
      sql: `INSERT INTO settings (key, value) VALUES ('cutoff_time', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [cutoffToString(cutoff)],
    });
    return cutoff;
  }

  async ensureBatch(batchDate) {
    await this.db.execute({
      sql: 'INSERT OR IGNORE INTO batches (batch_date) VALUES (?)',
      args: [batchDate],
    });
    return this.getBatch(batchDate);
  }

  async getBatch(batchDate) {
    const res = await this.db.execute({
      sql: 'SELECT * FROM batches WHERE batch_date = ?',
      args: [batchDate],
    });
    return res.rows[0] ?? null;
  }

  /** Batch yang sedang menerima pesanan: hari ini sebelum cutoff, besok setelahnya. */
  async openBatchDate(now = this.now()) {
    const cutoff = await this.getCutoff();
    return openBatchDateOf(cutoff, now);
  }

  /** Status batch yang sedang dibuka, untuk ditampilkan di halaman. */
  async currentStatus() {
    const now = this.now();
    const cutoff = await this.getCutoff();
    const batchDate = openBatchDateOf(cutoff, now);
    const batch = await this.getBatch(batchDate);
    return {
      batchDate,
      today: batchDateOf(now),
      open: !batch || batch.status === 'open',
      cutoffAt: cutoffInstant(batchDate, cutoff).toISOString(),
      serverTime: now.toISOString(),
    };
  }

  async listOrders(batchDate) {
    const res = await this.db.execute({
      sql: 'SELECT * FROM orders WHERE batch_date = ? ORDER BY created_at, id',
      args: [batchDate],
    });
    return res.rows;
  }

  async placeOrder(input) {
    const order = validateOrder(input);
    const now = this.now();
    const batchDate = await this.openBatchDate(now);
    const batch = await this.ensureBatch(batchDate);
    // Normalnya selalu "open"; berjaga-jaga bila batch sudah ditutup lebih awal.
    if (batch.status !== 'open') {
      throw new BatchClosedError('Batch ini sudah ditutup.');
    }
    const info = await this.db.execute({
      sql: `INSERT INTO orders (batch_date, name, food, quantity, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [batchDate, order.name, order.food, order.quantity, order.notes, now.toISOString()],
    });
    const id = Number(info.lastInsertRowid);
    const res = await this.db.execute({
      sql: 'SELECT * FROM orders WHERE id = ?',
      args: [id],
    });
    return res.rows[0];
  }

  async deleteOrder(id) {
    const res = await this.db.execute({
      sql: 'DELETE FROM orders WHERE id = ?',
      args: [id],
    });
    return res.rowsAffected > 0;
  }

  async markClosed(batchDate) {
    await this.ensureBatch(batchDate);
    await this.db.execute({
      sql: `UPDATE batches SET status = 'closed', closed_at = COALESCE(closed_at, ?)
            WHERE batch_date = ? AND status = 'open'`,
      args: [this.now().toISOString(), batchDate],
    });
  }

  /** Buka kembali batch: pesanan tetap ada, riwayat penutupan & pengiriman dihapus. */
  async reopen(batchDate) {
    await this.db.execute({
      sql: `UPDATE batches SET status = 'open', closed_at = NULL, sent_at = NULL, send_attempts = 0,
            last_attempt_at = NULL, last_error = NULL WHERE batch_date = ?`,
      args: [batchDate],
    });
    return this.getBatch(batchDate);
  }

  async recordAttempt(batchDate, error) {
    const now = this.now().toISOString();
    if (error) {
      await this.db.execute({
        sql: `UPDATE batches SET send_attempts = send_attempts + 1, last_attempt_at = ?,
              last_error = ? WHERE batch_date = ?`,
        args: [now, String(error.message || error).slice(0, 1000), batchDate],
      });
    } else {
      await this.db.execute({
        sql: `UPDATE batches SET status = 'sent', sent_at = ?, send_attempts = send_attempts + 1,
              last_attempt_at = ?, last_error = NULL WHERE batch_date = ?`,
        args: [now, now, batchDate],
      });
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
