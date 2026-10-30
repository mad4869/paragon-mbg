import path from 'node:path';
import { ROOT_DIR } from './config.js';
import { formatBatchDate, formatWibTime } from './time.js';

const FONT_DIR = path.join(ROOT_DIR, 'assets', 'fonts');
const FONT_FILES = ['Inter-Regular.otf', 'Inter-SemiBold.otf', 'Inter-Bold.otf'].map((f) =>
  path.join(FONT_DIR, f),
);

/**
 * Kelompokkan pesanan per menu. Karena field makanan berupa free text,
 * pencocokan dibuat longgar: abaikan huruf besar/kecil dan spasi berlebih.
 */
export function summarize(orders) {
  const groups = new Map();
  for (const o of orders) {
    const key = o.food.toLowerCase().replace(/\s+/g, ' ').trim();
    const g = groups.get(key) ?? { food: o.food, quantity: 0, orderers: [] };
    g.quantity += o.quantity;
    g.orderers.push(o.name);
    groups.set(key, g);
  }
  const items = [...groups.values()].sort(
    (a, b) => b.quantity - a.quantity || a.food.localeCompare(b.food, 'id'),
  );
  return {
    items,
    totalPortions: orders.reduce((sum, o) => sum + o.quantity, 0),
    totalOrders: orders.length,
    uniqueOrderers: new Set(orders.map((o) => o.name.toLowerCase())).size,
  };
}

export function buildRecapText({ appTitle, batchDate, cutoffLabel, orders }) {
  const { items, totalPortions, totalOrders } = summarize(orders);
  const lines = [
    `*Rekap Pesanan — ${appTitle}*`,
    formatBatchDate(batchDate),
    `Batch ditutup pukul ${cutoffLabel}`,
    '',
  ];

  if (orders.length === 0) {
    lines.push('Tidak ada pesanan untuk batch hari ini.');
    return lines.join('\n');
  }

  lines.push('*Ringkasan per menu*');
  for (const item of items) lines.push(`• ${item.quantity}× ${item.food}`);
  lines.push('', '*Detail pesanan*');
  orders.forEach((o, i) => {
    const notes = o.notes ? ` (${o.notes})` : '';
    lines.push(`${i + 1}. ${o.name} — ${o.food} ×${o.quantity}${notes}`);
  });
  lines.push('', `Total: *${totalPortions} porsi* dari ${totalOrders} pesanan`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Gambar rekap (SVG -> PNG)
// ---------------------------------------------------------------------------

const C = {
  bg: '#f8fafc',
  card: '#ffffff',
  header: '#0f766e',
  headerSub: '#ccfbf1',
  text: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  stripe: '#f1f5f9',
  accent: '#0f766e',
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Bungkus teks per kata berdasarkan perkiraan lebar karakter Inter. */
export function wrapText(text, maxWidth, fontSize, weight = 400) {
  const charWidth = fontSize * (weight >= 600 ? 0.6 : 0.56);
  const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
  const lines = [];
  let current = '';
  for (let word of String(text).split(' ')) {
    while (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function textBlock(lines, x, y, { size, lineHeight, weight = 400, fill = C.text, anchor = 'start' }) {
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${esc(line)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`;
}

export function buildRecapSvg({ appTitle, batchDate, cutoffLabel, orders, generatedAt = new Date() }) {
  const W = 1080;
  const PAD = 56;
  const INNER = W - PAD * 2;
  const { items, totalPortions, totalOrders } = summarize(orders);
  const parts = [];
  let y = 0;

  // Header
  parts.push(`<rect x="0" y="0" width="${W}" height="190" fill="${C.header}"/>`);
  parts.push(textBlock(['REKAP PESANAN'], PAD, 64, { size: 22, lineHeight: 0, weight: 600, fill: C.headerSub }));
  parts.push(textBlock(wrapText(appTitle, INNER, 44, 700).slice(0, 1), PAD, 116, { size: 44, lineHeight: 0, weight: 700, fill: '#ffffff' }));
  parts.push(textBlock([`${formatBatchDate(batchDate)} · ditutup ${cutoffLabel}`], PAD, 160, { size: 24, lineHeight: 0, fill: C.headerSub }));
  y = 190 + 40;

  // Kartu statistik
  const stats = [
    ['Total porsi', totalPortions],
    ['Pesanan', totalOrders],
    ['Jenis menu', items.length],
  ];
  const gap = 24;
  const cardW = (INNER - gap * 2) / 3;
  stats.forEach(([label, value], i) => {
    const x = PAD + i * (cardW + gap);
    parts.push(`<rect x="${x}" y="${y}" width="${cardW}" height="112" rx="16" fill="${C.card}" stroke="${C.line}"/>`);
    parts.push(textBlock([String(value)], x + 24, y + 58, { size: 44, lineHeight: 0, weight: 700, fill: C.accent }));
    parts.push(textBlock([label], x + 24, y + 92, { size: 20, lineHeight: 0, fill: C.muted }));
  });
  y += 112 + 48;

  if (orders.length === 0) {
    parts.push(textBlock(['Tidak ada pesanan untuk batch hari ini.'], W / 2, y + 40, { size: 28, lineHeight: 0, fill: C.muted, anchor: 'middle' }));
    y += 100;
  } else {
    // Ringkasan per menu
    parts.push(textBlock(['Ringkasan per menu'], PAD, y + 28, { size: 28, lineHeight: 0, weight: 700 }));
    y += 52;
    const sumSize = 26;
    const sumLh = 34;
    for (const item of items) {
      const lines = wrapText(item.food, INNER - 140, sumSize);
      const rowH = lines.length * sumLh + 22;
      parts.push(textBlock(lines, PAD, y + 36, { size: sumSize, lineHeight: sumLh }));
      parts.push(textBlock([`${item.quantity}×`], W - PAD, y + 36, { size: sumSize, lineHeight: 0, weight: 700, fill: C.accent, anchor: 'end' }));
      y += rowH;
      parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}"/>`);
    }
    y += 48;

    // Detail pesanan
    parts.push(textBlock(['Detail pesanan'], PAD, y + 28, { size: 28, lineHeight: 0, weight: 700 }));
    y += 52;
    const cols = [
      { key: 'no', label: 'No', w: 64 },
      { key: 'name', label: 'Nama', w: 220 },
      { key: 'food', label: 'Pesanan', w: 380 },
      { key: 'quantity', label: 'Jml', w: 76 },
      { key: 'notes', label: 'Catatan', w: INNER - 64 - 220 - 380 - 76 },
    ];
    const size = 22;
    const lh = 30;
    const cellPad = 12;

    parts.push(`<rect x="${PAD}" y="${y}" width="${INNER}" height="48" rx="10" fill="${C.header}"/>`);
    let x = PAD;
    for (const col of cols) {
      parts.push(textBlock([col.label], x + cellPad, y + 32, { size: 20, lineHeight: 0, weight: 600, fill: '#ffffff' }));
      x += col.w;
    }
    y += 48;

    orders.forEach((o, i) => {
      const values = { no: String(i + 1), name: o.name, food: o.food, quantity: String(o.quantity), notes: o.notes || '–' };
      const wrapped = cols.map((col) => wrapText(values[col.key], col.w - cellPad * 2, size));
      const rowH = Math.max(...wrapped.map((l) => l.length)) * lh + 20;
      if (i % 2 === 1) parts.push(`<rect x="${PAD}" y="${y}" width="${INNER}" height="${rowH}" fill="${C.stripe}"/>`);
      let cx = PAD;
      cols.forEach((col, ci) => {
        const fill = col.key === 'notes' && !o.notes ? C.muted : C.text;
        const weight = col.key === 'name' ? 600 : 400;
        parts.push(textBlock(wrapped[ci], cx + cellPad, y + 32, { size, lineHeight: lh, weight, fill }));
        cx += col.w;
      });
      y += rowH;
      parts.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="${C.line}"/>`);
    });
    y += 40;
  }

  // Footer
  parts.push(textBlock([`Dibuat otomatis pukul ${formatWibTime(generatedAt)} WIB`], PAD, y + 20, { size: 18, lineHeight: 0, fill: C.muted }));
  y += 56;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="Inter, sans-serif">
<rect width="100%" height="100%" fill="${C.bg}"/>
${parts.join('\n')}
</svg>`;
}

let resvgModule = null;
async function getResvg() {
  if (!resvgModule) {
    resvgModule = await import('@resvg/resvg-js');
  }
  return resvgModule.Resvg;
}

export async function renderRecapPng(recap) {
  const Resvg = await getResvg();
  const svg = buildRecapSvg(recap);
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: true, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}
