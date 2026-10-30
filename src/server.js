import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { BatchClosedError, BatchService, LIMITS, ValidationError } from './batch.js';
import { config, legacyCutoffEnv, ROOT_DIR } from './config.js';
import { openDatabase } from './db.js';
import { buildRecapText, renderRecapPng } from './recap.js';
import { RecapScheduler } from './scheduler.js';
import { batchDateOf, cutoffToString, formatCutoff, isPastCutoff, isValidBatchDate } from './time.js';
import { createWhatsAppSender } from './whatsapp.js';

export const db = openDatabase({
  dataDir: config.dataDir,
  url: config.tursoDatabaseUrl,
  authToken: config.tursoAuthToken,
});
export const batches = new BatchService(db);
const cutoffLabel = async () => formatCutoff(await batches.getCutoff());
export const sender = (() => {
  try {
    return createWhatsAppSender(config.whatsapp, { dataDir: config.dataDir });
  } catch (err) {
    console.warn('[whatsapp] Peringatan sender:', err.message);
    return {
      name: config.whatsapp.provider || 'disabled',
      async send() {
        throw new Error(`WhatsApp sender belum siap: ${err.message}`);
      },
    };
  }
})();
export const scheduler = new RecapScheduler({
  batches,
  sender,
  appTitle: config.appTitle,
  sendWhenEmpty: config.sendWhenEmpty,
  retryDelayMs: config.retryDelayMs,
  maxSendAttempts: config.maxSendAttempts,
});

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const publicOrder = ({ id, batch_date, name, food, quantity, notes, created_at }) => ({
  id,
  batchDate: batch_date,
  name,
  food,
  quantity,
  notes,
  createdAt: created_at,
});

// ---------------------------------------------------------------- publik

app.get('/api/status', async (req, res, next) => {
  try {
    const status = await batches.currentStatus();
    const label = await cutoffLabel();
    res.json({ ...status, appTitle: config.appTitle, cutoffLabel: label, limits: LIMITS });
  } catch (err) {
    next(err);
  }
});

app.get('/api/orders', async (req, res, next) => {
  try {
    const openDate = await batches.openBatchDate();
    const orders = await batches.listOrders(openDate);
    res.json(orders.map(publicOrder));
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders', async (req, res, next) => {
  try {
    const order = await batches.placeOrder(req.body);
    res.status(201).json(publicOrder(order));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof BatchClosedError) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------- admin

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || req.query.token || '';
  const expected = config.adminToken;
  const ok =
    expected &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Token admin tidak valid.' });
  next();
}

function batchDateParam(req, res, next) {
  const date = req.query.date || batchDateOf(batches.now());
  if (!isValidBatchDate(date)) return res.status(400).json({ error: 'Parameter date harus berformat YYYY-MM-DD.' });
  req.batchDate = date;
  next();
}

app.get('/api/admin/batch', requireAdmin, batchDateParam, async (req, res, next) => {
  try {
    const batch = await batches.getBatch(req.batchDate);
    const orders = await batches.listOrders(req.batchDate);
    const recap = await scheduler.buildRecap(req.batchDate);
    const cutoff = await batches.getCutoff();
    const now = batches.now();
    res.json({
      batch: batch ?? { batch_date: req.batchDate, status: 'open', send_attempts: 0 },
      orders: orders.map(publicOrder),
      recapText: buildRecapText(recap),
      whatsapp: { provider: sender.name, targets: config.whatsapp.targets },
      isToday: req.batchDate === batchDateOf(now),
      pastCutoff: isPastCutoff(cutoff, now),
      cutoffLabel: formatCutoff(cutoff),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/recap.png', requireAdmin, batchDateParam, async (req, res, next) => {
  try {
    const recap = await scheduler.buildRecap(req.batchDate);
    const png = await renderRecapPng(recap);
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch (err) {
    next(err);
  }
});

app.post('/api/admin/send', requireAdmin, batchDateParam, async (req, res) => {
  try {
    const cutoff = await batches.getCutoff();
    const now = batches.now();
    const today = batchDateOf(now);
    if (req.batchDate > today || (req.batchDate === today && !isPastCutoff(cutoff, now))) {
      return res.status(409).json({ error: `Batch masih dibuka. Rekap baru bisa dikirim setelah ${formatCutoff(cutoff)}.` });
    }
    await batches.ensureBatch(req.batchDate);
    await batches.markClosed(req.batchDate);
    await scheduler.sendRecap(req.batchDate);
    res.json({ ok: true, batch: await batches.getBatch(req.batchDate) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/admin/reopen', requireAdmin, batchDateParam, async (req, res, next) => {
  try {
    if (req.batchDate !== batchDateOf(batches.now())) {
      return res.status(409).json({ error: 'Hanya batch hari ini yang bisa di-reset.' });
    }
    const batch = await batches.getBatch(req.batchDate);
    if (!batch || batch.status === 'open') {
      return res.status(409).json({ error: 'Batch ini masih dibuka, tidak perlu di-reset.' });
    }
    res.json({ ok: true, batch: await batches.reopen(req.batchDate) });
  } catch (err) {
    next(err);
  }
});

async function settingsResponse() {
  const now = batches.now();
  const today = batchDateOf(now);
  const cutoff = await batches.getCutoff();
  const todayBatch = await batches.getBatch(today);
  return {
    cutoffTime: cutoffToString(cutoff),
    cutoffLabel: formatCutoff(cutoff),
    pastCutoff: isPastCutoff(cutoff, now),
    todayStatus: todayBatch?.status ?? 'open',
  };
}

app.get('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    res.json(await settingsResponse());
  } catch (err) {
    next(err);
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    await batches.setCutoff(req.body?.cutoffTime);
    const label = formatCutoff(await batches.getCutoff());
    console.log(`[admin] Jam tutup diubah menjadi ${label}.`);
    res.json(await settingsResponse());
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

app.delete('/api/admin/orders/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!(await batches.deleteOrder(Number(req.params.id)))) {
      return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Endpoint untuk webhook / cron runner
app.post('/api/cron/tick', async (req, res, next) => {
  try {
    await scheduler.tick();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT_DIR, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

// Hanya jalankan listener & scheduler bila dijalankan langsung (bukan di-import oleh serverless lambda)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun && !process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  batches.getCutoff().then((cutoff) => {
    const initialCutoffLabel = formatCutoff(cutoff);
    app.listen(config.port, () => {
      console.log(`${config.appTitle} berjalan di http://localhost:${config.port}`);
      console.log(`Jam tutup: ${initialCutoffLabel} (ubah di /admin) · WhatsApp provider: ${sender.name} · tujuan: ${config.whatsapp.targets.join(', ') || '-'}`);
      if (legacyCutoffEnv) console.warn('CUTOFF_TIME di .env tidak dipakai lagi; atur jam tutup di halaman /admin.');
      if (!config.adminToken) console.warn('ADMIN_TOKEN belum diset: halaman admin tidak bisa diakses.');
      scheduler.start(config.schedulerIntervalMs);
    });
  }).catch((err) => {
    console.error('Gagal membaca pengaturan database:', err);
  });
}
