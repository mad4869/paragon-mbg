// WIB = UTC+7 sepanjang tahun (tidak ada daylight saving), jadi cukup geser 7 jam.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** Komponen tanggal/jam dalam WIB untuk sebuah instant. */
export function wibParts(date = new Date()) {
  const d = new Date(date.getTime() + WIB_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** Kunci batch harian, format YYYY-MM-DD (tanggal WIB). */
export function batchDateOf(date = new Date()) {
  const p = wibParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Instant (UTC) saat cutoff pada tanggal batch tertentu. */
export function cutoffInstant(batchDate, cutoff) {
  const [y, m, d] = batchDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, cutoff.hour, cutoff.minute) - WIB_OFFSET_MS);
}

export function isPastCutoff(cutoff, date = new Date()) {
  return date.getTime() >= cutoffInstant(batchDateOf(date), cutoff).getTime();
}

export function isValidBatchDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** "Rabu, 28 Oktober 2026" */
export function formatBatchDate(batchDate) {
  const [y, m, d] = batchDate.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${HARI[weekday]}, ${d} ${BULAN[m - 1]} ${y}`;
}

/** "09.42" (jam WIB) */
export function formatWibTime(date) {
  const p = wibParts(date);
  return `${String(p.hour).padStart(2, '0')}.${String(p.minute).padStart(2, '0')}`;
}

/** Tanggal batch berikutnya, mis. "2026-10-31" -> "2026-11-01". */
export function nextBatchDate(batchDate) {
  const [y, m, d] = batchDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Batch yang sedang menerima pesanan: hari ini sebelum cutoff, besok setelah cutoff. */
export function openBatchDateOf(cutoff, date = new Date()) {
  const today = batchDateOf(date);
  return isPastCutoff(cutoff, date) ? nextBatchDate(today) : today;
}

/** "11:00" atau "11.00" -> { hour: 11, minute: 0 }; null bila tidak valid. */
export function parseCutoff(value) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(value ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** { hour: 11, minute: 0 } -> "11:00" (format input type=time). */
export function cutoffToString({ hour, minute }) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** { hour: 11, minute: 0 } -> "11.00 WIB" */
export function formatCutoff(cutoff) {
  return `${cutoffToString(cutoff).replace(':', '.')} WIB`;
}
