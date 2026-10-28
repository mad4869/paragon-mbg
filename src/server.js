import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { BatchClosedError, BatchService, LIMITS, ValidationError } from './batch.js';
import { config, legacyCutoffEnv, ROOT_DIR } from './config.js';
import { openDatabase } from './db.js';
import { buildRecapText, renderRecapPng } from './recap.js';
import { RecapScheduler } from './scheduler.js';
import { batchDateOf, cutoffToString, formatCutoff, isPastCutoff, isValidBatchDate } from './time.js';
import { createWhatsAppSender } from './whatsapp.js';

const db = openDatabase(config.dataDir);
const batches = new BatchService(db);
const cutoffLabel = () => formatCutoff(batches.cutoff);
const sender = createWhatsAppSender(config.whatsapp, { dataDir: config.dataDir });
const scheduler = new RecapScheduler({
  batches,
  sender,
  appTitle: config.appTitle,
  sendWhenEmpty: config.sendWhenEmpty,
  retryDelayMs: config.retryDelayMs,
  maxSendAttempts: config.maxSendAttempts,
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

const publicOrder = ({ id, batch_date, name, food, quantity, notes, created_at }) => ({ id, batchDate: batch_date, name, food, quantity, notes, createdAt: created_at });

// ---------------------------------------------------------------- publik

app.get('/api/status', (req, res) => {
  res.json({ ...batches.currentStatus(), appTitle: config.appTitle, cutoffLabel: cutoffLabel(), limits: LIMITS });
});

app.get('/api/orders', (req, res) => {
  res.json(batches.listOrders(batches.openBatchDate()).map(publicOrder));
});

app.post('/api/orders', (req, res) => {
  try {
    res.status(201).json(publicOrder(batches.placeOrder(req.body)));
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof BatchClosedError) return res.status(409).json({ error: err.message });
    throw err;
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

app.get('/api/admin/batch', requireAdmin, batchDateParam, (req, res) => {
  res.json({
    batch: batches.getBatch(req.batchDate) ?? { batch_date: req.batchDate, status: 'open', send_attempts: 0 },
    orders: batches.listOrders(req.batchDate).map(publicOrder),
    recapText: buildRecapText(scheduler.buildRecap(req.batchDate)),
    whatsapp: { provider: sender.name, targets: config.whatsapp.targets },
    isToday: req.batchDate === batchDateOf(batches.now()),
    pastCutoff: isPastCutoff(batches.cutoff, batches.now()),
    cutoffLabel: cutoffLabel(),
  });
});

app.get('/api/admin/recap.png', requireAdmin, batchDateParam, (req, res) => {
  res.type('png').set('Cache-Control', 'no-store').send(renderRecapPng(scheduler.buildRecap(req.batchDate)));
});

app.post('/api/admin/send', requireAdmin, batchDateParam, async (req, res) => {
  const today = batchDateOf(batches.now());
  if (req.batchDate > today || (req.batchDate === today && !isPastCutoff(batches.cutoff, batches.now()))) {
    return res.status(409).json({ error: `Batch masih dibuka. Rekap baru bisa dikirim setelah ${cutoffLabel()}.` });
  }
  try {
    batches.ensureBatch(req.batchDate);
    batches.markClosed(req.batchDate);
    await scheduler.sendRecap(req.batchDate);
    res.json({ ok: true, batch: batches.getBatch(req.batchDate) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Hanya batch hari ini yang bisa di-reset: batch lama tidak lagi menerima pesanan
// maupun dikirim otomatis, sedangkan batch besok memang masih dibuka.
app.post('/api/admin/reopen', requireAdmin, batchDateParam, (req, res) => {
  if (req.batchDate !== batchDateOf(batches.now())) {
    return res.status(409).json({ error: 'Hanya batch hari ini yang bisa di-reset.' });
  }
  const batch = batches.getBatch(req.batchDate);
  if (!batch || batch.status === 'open') {
    return res.status(409).json({ error: 'Batch ini masih dibuka, tidak perlu di-reset.' });
  }
  res.json({ ok: true, batch: batches.reopen(req.batchDate) });
});

function settingsResponse() {
  const today = batchDateOf(batches.now());
  return {
    cutoffTime: cutoffToString(batches.cutoff),
    cutoffLabel: cutoffLabel(),
    pastCutoff: isPastCutoff(batches.cutoff, batches.now()),
    todayStatus: batches.getBatch(today)?.status ?? 'open',
  };
}

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(settingsResponse()));

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    batches.setCutoff(req.body?.cutoffTime);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
  console.log(`[admin] Jam tutup diubah menjadi ${cutoffLabel()}.`);
  res.json(settingsResponse());
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  if (!batches.deleteOrder(Number(req.params.id))) return res.status(404).json({ error: 'Pesanan tidak ditemukan.' });
  res.status(204).end();
});

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT_DIR, 'public', 'admin.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

app.listen(config.port, () => {
  console.log(`${config.appTitle} berjalan di http://localhost:${config.port}`);
  console.log(`Jam tutup: ${cutoffLabel()} (ubah di /admin) · WhatsApp provider: ${sender.name} · tujuan: ${config.whatsapp.targets.join(', ') || '-'}`);
  if (legacyCutoffEnv) console.warn('CUTOFF_TIME di .env tidak dipakai lagi; atur jam tutup di halaman /admin.');
  if (!config.adminToken) console.warn('ADMIN_TOKEN belum diset: halaman admin tidak bisa diakses.');
  scheduler.start(config.schedulerIntervalMs);
});
