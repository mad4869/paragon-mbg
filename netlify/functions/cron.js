import { schedule } from '@netlify/functions';
import { scheduler } from '../../src/server.js';

// Dijalankan setiap 5 menit oleh Netlify Scheduled Functions.
// Scheduler akan mengecek apakah sudah melewati jam tutup dan mengirimkan rekap jika belum dikirim.
export const handler = schedule('*/5 * * * *', async () => {
  try {
    await scheduler.tick();
    return { statusCode: 200 };
  } catch (err) {
    console.error('[netlify-cron] Gagal mengeksekusi scheduler:', err);
    return { statusCode: 500, body: err.message };
  }
});
