import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BatchClosedError, BatchService, ValidationError } from '../src/batch.js';
import { openDatabase } from '../src/db.js';
import { buildRecapSvg, buildRecapText, renderRecapPng, summarize, wrapText } from '../src/recap.js';
import { RecapScheduler } from '../src/scheduler.js';
import { batchDateOf, cutoffInstant, formatBatchDate, isPastCutoff } from '../src/time.js';
import { chunkText } from '../src/whatsapp.js';

const CUTOFF = { hour: 11, minute: 0 };
const wib = (iso) => new Date(`${iso}+07:00`);

async function setup(startIso) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesan-makan-'));
  const clock = { now: wib(startIso) };
  const db = await openDatabase({ dataDir: dir });
  const batches = new BatchService(db, { now: () => clock.now });
  return { dir, clock, batches };
}

const silent = { log() {}, error() {} };

test('tanggal batch dan cutoff mengikuti WIB', () => {
  // 23.30 UTC tanggal 27 = 06.30 WIB tanggal 28
  assert.equal(batchDateOf(new Date('2026-10-27T23:30:00Z')), '2026-10-28');
  assert.equal(cutoffInstant('2026-10-28', CUTOFF).toISOString(), '2026-10-28T04:00:00.000Z');
  assert.equal(isPastCutoff(CUTOFF, wib('2026-10-28T10:59:59')), false);
  assert.equal(isPastCutoff(CUTOFF, wib('2026-10-28T11:00:00')), true);
  assert.equal(formatBatchDate('2026-10-28'), 'Rabu, 28 Oktober 2026');
});

test('pesanan setelah cutoff otomatis masuk batch besok', async () => {
  const { clock, batches } = await setup('2026-10-28T09:00:00');
  const order = await batches.placeOrder({ name: '  Andi ', food: 'Nasi   goreng', quantity: '2' });
  assert.equal(order.name, 'Andi');
  assert.equal(order.food, 'Nasi goreng');
  assert.equal(order.quantity, 2);
  assert.equal(order.batch_date, '2026-10-28');
  assert.equal((await batches.currentStatus()).batchDate, '2026-10-28');

  clock.now = wib('2026-10-28T11:00:00');
  const status = await batches.currentStatus();
  assert.equal(status.batchDate, '2026-10-29');
  assert.equal(status.today, '2026-10-28');
  assert.equal(status.cutoffAt, '2026-10-29T04:00:00.000Z');
  assert.equal((await batches.placeOrder({ name: 'Budi', food: 'Soto' })).batch_date, '2026-10-29');

  // Lewat tengah malam: tetap batch yang sama sampai cutoff berikutnya
  clock.now = wib('2026-10-29T08:00:00');
  assert.equal((await batches.placeOrder({ name: 'Citra', food: 'Bakso' })).batch_date, '2026-10-29');
  assert.equal((await batches.listOrders('2026-10-28')).length, 1);
  assert.equal((await batches.listOrders('2026-10-29')).length, 2);

  // Pergantian bulan
  clock.now = wib('2026-10-31T15:00:00');
  assert.equal((await batches.placeOrder({ name: 'Dewi', food: 'Pecel' })).batch_date, '2026-11-01');
});

test('batch yang sudah ditutup lebih awal menolak pesanan', async () => {
  const { batches } = await setup('2026-10-28T09:00:00');
  await batches.markClosed('2026-10-28');
  assert.equal((await batches.currentStatus()).open, false);
  await assert.rejects(batches.placeOrder({ name: 'Andi', food: 'Soto' }), BatchClosedError);
});

test('validasi input pesanan', async () => {
  const { batches } = await setup('2026-10-28T09:00:00');
  await assert.rejects(batches.placeOrder({ name: '', food: 'Soto' }), ValidationError);
  await assert.rejects(batches.placeOrder({ name: 'A', food: '   ' }), ValidationError);
  await assert.rejects(batches.placeOrder({ name: 'A', food: 'Soto', quantity: 0 }), ValidationError);
  await assert.rejects(batches.placeOrder({ name: 'A', food: 'Soto', quantity: 1.5 }), ValidationError);
  await assert.rejects(batches.placeOrder({ name: 'A', food: 'x'.repeat(201) }), ValidationError);
});

test('rekap mengelompokkan menu free text tanpa peduli kapitalisasi/spasi', () => {
  const orders = [
    { name: 'Andi', food: 'Nasi Goreng', quantity: 1, notes: 'pedas' },
    { name: 'Budi', food: 'nasi  goreng', quantity: 2, notes: '' },
    { name: 'Citra', food: 'Mie ayam', quantity: 1, notes: '' },
  ];
  const s = summarize(orders);
  assert.equal(s.totalPortions, 4);
  assert.deepEqual(s.items.map((i) => [i.food, i.quantity]), [['Nasi Goreng', 3], ['Mie ayam', 1]]);

  const text = buildRecapText({ appTitle: 'Makan', batchDate: '2026-10-28', cutoffLabel: '11.00 WIB', orders });
  assert.match(text, /• 3× Nasi Goreng/);
  assert.match(text, /1\. Andi — Nasi Goreng ×1 \(pedas\)/);
  assert.match(text, /Total: \*4 porsi\* dari 3 pesanan/);

  const empty = buildRecapText({ appTitle: 'Makan', batchDate: '2026-10-28', cutoffLabel: '11.00 WIB', orders: [] });
  assert.match(empty, /Tidak ada pesanan/);
});

test('gambar rekap ter-render sebagai PNG dan teks di-escape', async () => {
  const orders = [{ name: 'A & B <x>', food: 'Ayam geprek '.repeat(10), quantity: 1, notes: '' }];
  const recap = { appTitle: 'Makan', batchDate: '2026-10-28', cutoffLabel: '11.00 WIB', orders };
  assert.match(buildRecapSvg(recap), /A &amp; B &lt;x&gt;/);
  const png = await renderRecapPng(recap);
  assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from('PNG')]);
});

test('wrapText dan chunkText membatasi panjang baris', () => {
  for (const line of wrapText('Nasi goreng spesial pakai telur ceplok dua', 200, 20)) {
    assert.ok(line.length <= Math.floor(200 / (20 * 0.56)));
  }
  assert.ok(chunkText('a\n'.repeat(3000), 4096).every((c) => c.length <= 4096));
});

test('scheduler mengirim sekali setelah cutoff dan retry bila gagal', async () => {
  const { clock, batches } = await setup('2026-10-28T10:00:00');
  const sent = [];
  let failNext = true;
  const sender = {
    name: 'fake',
    async send(payload) {
      if (failNext) {
        failNext = false;
        throw new Error('jaringan putus');
      }
      sent.push(payload);
    },
  };
  const scheduler = new RecapScheduler({
    batches, sender, appTitle: 'Makan',
    sendWhenEmpty: true, retryDelayMs: 60_000, maxSendAttempts: 3, logger: silent,
  });

  await batches.placeOrder({ name: 'Andi', food: 'Soto', quantity: 1 });
  await scheduler.tick();
  assert.equal(sent.length, 0, 'belum lewat cutoff');

  clock.now = wib('2026-10-28T11:00:10');
  // Pesanan setelah cutoff masuk batch besok, tidak ikut rekap hari ini
  await batches.placeOrder({ name: 'Telat', food: 'Bakso', quantity: 1 });
  await assert.rejects(scheduler.tick(), /jaringan putus/);
  assert.equal((await batches.getBatch('2026-10-28')).status, 'closed');
  assert.equal((await batches.getBatch('2026-10-28')).last_error, 'jaringan putus');

  clock.now = wib('2026-10-28T11:00:40');
  await scheduler.tick();
  assert.equal(sent.length, 0, 'menunggu jeda retry');

  clock.now = wib('2026-10-28T11:01:30');
  await scheduler.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1× Soto/);
  assert.doesNotMatch(sent[0].text, /Bakso/);
  assert.ok(Buffer.isBuffer(sent[0].image));
  assert.equal(sent[0].filename, 'rekap-2026-10-28.png');
  assert.equal((await batches.getBatch('2026-10-28')).status, 'sent');

  clock.now = wib('2026-10-28T13:00:00');
  await scheduler.tick();
  assert.equal(sent.length, 1, 'tidak dikirim dua kali');
});

test('batch kosong tidak dikirim bila SEND_WHEN_EMPTY=false', async () => {
  const { batches } = await setup('2026-10-28T11:30:00');
  const sent = [];
  const scheduler = new RecapScheduler({
    batches, sender: { name: 'fake', send: async (p) => sent.push(p) }, appTitle: 'Makan',
    sendWhenEmpty: false, retryDelayMs: 0, maxSendAttempts: 3, logger: silent,
  });
  await scheduler.tick();
  assert.equal(sent.length, 0);
  assert.equal((await batches.getBatch('2026-10-28')).status, 'sent');
});

test('reset batch: pesanan diterima lagi dan rekap dikirim ulang di cutoff baru', async () => {
  const { clock, batches } = await setup('2026-10-28T11:30:00');
  const sent = [];
  const scheduler = new RecapScheduler({
    batches, sender: { name: 'fake', send: async (p) => sent.push(p) }, appTitle: 'Makan',
    sendWhenEmpty: true, retryDelayMs: 0, maxSendAttempts: 3, logger: silent,
  });

  // Rekap hari ini sudah terkirim dengan cutoff 11.00
  await scheduler.tick();
  assert.equal(sent.length, 1);

  // Cutoff dimundurkan ke 15.00: batch tetap tertutup sampai di-reset
  await batches.setCutoff('15:00');
  clock.now = wib('2026-10-28T12:00:00');
  assert.equal((await batches.currentStatus()).open, false);
  await assert.rejects(batches.placeOrder({ name: 'Andi', food: 'Soto' }), BatchClosedError);

  const batch = await batches.reopen('2026-10-28');
  assert.equal(batch.status, 'open');
  assert.equal(batch.send_attempts, 0);
  assert.equal(batch.sent_at, null);
  assert.equal((await batches.placeOrder({ name: 'Andi', food: 'Soto' })).batch_date, '2026-10-28');

  await scheduler.tick();
  assert.equal(sent.length, 1, 'belum lewat cutoff baru');
  clock.now = wib('2026-10-28T15:00:05');
  await scheduler.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /1× Soto/);
});

test('jam tutup disimpan di database dan langsung berlaku', async () => {
  const { dir, clock, batches } = await setup('2026-10-28T12:00:00');
  assert.deepEqual(await batches.getCutoff(), { hour: 11, minute: 0 }, 'default 11.00');
  assert.equal((await batches.currentStatus()).batchDate, '2026-10-29');

  assert.deepEqual(await batches.setCutoff('14.30'), { hour: 14, minute: 30 });
  assert.equal((await batches.currentStatus()).batchDate, '2026-10-28', 'langsung berlaku tanpa restart');
  assert.equal((await batches.currentStatus()).cutoffAt, '2026-10-28T07:30:00.000Z');

  for (const bad of ['', '24:00', '12:60', 'jam 11', undefined]) {
    await assert.rejects(batches.setCutoff(bad), ValidationError);
  }
  assert.deepEqual(await batches.getCutoff(), { hour: 14, minute: 30 }, 'nilai lama tetap bila input salah');

  // Tetap tersimpan setelah aplikasi dijalankan ulang
  const db2 = await openDatabase({ dataDir: dir });
  const reopened = new BatchService(db2, { now: () => clock.now });
  assert.deepEqual(await reopened.getCutoff(), { hour: 14, minute: 30 });

  // Scheduler mengikuti jam tutup yang baru
  const sent = [];
  const scheduler = new RecapScheduler({
    batches, sender: { name: 'fake', send: async (p) => sent.push(p) }, appTitle: 'Makan',
    sendWhenEmpty: true, retryDelayMs: 0, maxSendAttempts: 3, logger: silent,
  });
  await scheduler.tick();
  assert.equal(sent.length, 0);
  clock.now = wib('2026-10-28T14:30:00');
  await scheduler.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ditutup pukul 14\.30 WIB/);
});
