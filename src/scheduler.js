import { buildRecapText, renderRecapPng } from './recap.js';
import { batchDateOf, formatCutoff, isPastCutoff } from './time.js';

/**
 * Menutup batch setelah cutoff, membuat rekap, lalu mengirimkannya via WhatsApp.
 * Pengecekan dilakukan berkala (bukan cron sekali jalan), sehingga bila server
 * sempat mati saat jam 11.00, rekap tetap terkirim begitu server hidup lagi.
 */
export class RecapScheduler {
  constructor({ batches, sender, appTitle, sendWhenEmpty, retryDelayMs, maxSendAttempts, logger = console }) {
    Object.assign(this, { batches, sender, appTitle, sendWhenEmpty, retryDelayMs, maxSendAttempts, logger });
    this.sending = false;
    this.timer = null;
  }

  start(intervalMs) {
    const run = () => this.tick().catch((err) => this.logger.error('[scheduler]', err));
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    const now = this.batches.now();
    const cutoff = await this.batches.getCutoff();
    if (!isPastCutoff(cutoff, now)) return;

    const batchDate = batchDateOf(now);
    await this.batches.markClosed(batchDate);
    const batch = await this.batches.getBatch(batchDate);

    if (batch.status === 'sent') return;
    if (batch.send_attempts >= this.maxSendAttempts) return;
    if (batch.last_attempt_at && now - new Date(batch.last_attempt_at) < this.retryDelayMs) return;

    const orders = await this.batches.listOrders(batchDate);
    if (orders.length === 0 && !this.sendWhenEmpty) {
      await this.batches.recordAttempt(batchDate, null);
      this.logger.log(`[scheduler] Batch ${batchDate} kosong, rekap tidak dikirim (SEND_WHEN_EMPTY=false).`);
      return;
    }
    await this.sendRecap(batchDate);
  }

  async buildRecap(batchDate) {
    const cutoff = await this.batches.getCutoff();
    const orders = await this.batches.listOrders(batchDate);
    return { appTitle: this.appTitle, batchDate, cutoffLabel: formatCutoff(cutoff), orders, generatedAt: this.batches.now() };
  }

  /** Kirim rekap sebuah batch. Dipakai scheduler maupun tombol "kirim ulang" di admin. */
  async sendRecap(batchDate) {
    if (this.sending) throw new Error('Pengiriman rekap lain sedang berjalan, coba lagi sebentar.');
    this.sending = true;
    try {
      const recap = await this.buildRecap(batchDate);
      const text = buildRecapText(recap);
      let image = null;
      try {
        image = renderRecapPng(recap);
      } catch (err) {
        this.logger.error('[scheduler] Gagal membuat gambar rekap, kirim teks saja:', err);
      }

      await this.sender.send({ text, image, filename: `rekap-${batchDate}.png` });
      await this.batches.recordAttempt(batchDate, null);
      this.logger.log(`[scheduler] Rekap ${batchDate} terkirim via ${this.sender.name} (${recap.orders.length} pesanan).`);
    } catch (err) {
      await this.batches.recordAttempt(batchDate, err);
      this.logger.error(`[scheduler] Gagal mengirim rekap ${batchDate}:`, err.message);
      throw err;
    } finally {
      this.sending = false;
    }
  }
}
