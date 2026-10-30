const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'pesan-makan:admin-token';

let token = '';
let current = null; // data batch yang sedang ditampilkan
let settings = null;
try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch {}

const STATUS_LABEL = { open: 'Dibuka', closed: 'Ditutup, belum terkirim', sent: 'Terkirim' };

function formatDateTime(iso) {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso)) + ' WIB';
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { ...options, headers: { 'X-Admin-Token': token, ...options.headers } });
  } catch (err) {
    console.error(`[Admin API Network Error] ${path}:`, err);
    throw new Error(`Koneksi gagal: ${err.message}`);
  }
  if (res.status === 401) {
    showLogin('Token admin tidak valid.');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    const msg = body?.error || (text && text.length < 200 ? text : null) || `HTTP ${res.status}`;
    console.error(`[Admin API Error ${res.status}] ${path}:`, msg);
    throw new Error(msg);
  }
  return res;
}

function showLogin(message = '') {
  token = '';
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
  $('login').hidden = false;
  $('panel').hidden = true;
  $('login-message').textContent = message;
}

function setMessage(text, kind) {
  const el = $('send-message');
  el.textContent = text;
  el.className = `message ${kind || ''}`;
}

function setSettingsMessage(text, kind) {
  const el = $('settings-message');
  el.textContent = text;
  el.className = `message ${kind || ''}`;
}

/** Jam sekarang di WIB, format "HH:MM" (sama dengan nilai input type=time). */
function wibNow() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
}

async function loadSettings() {
  settings = await (await api('/api/admin/settings')).json();
  $('cutoff').value = settings.cutoffTime;
}

const init = () => Promise.all([load(), loadSettings()]);

async function load() {
  const date = $('date').value;
  const data = await (await api(`/api/admin/batch?date=${encodeURIComponent(date)}`)).json();
  $('login').hidden = true;
  $('panel').hidden = false;
  if (!$('date').value) $('date').value = data.batch.batch_date;

  const b = data.batch;
  const rows = [
    ['Tanggal', b.batch_date],
    ['Status', STATUS_LABEL[b.status] || b.status],
    ['Ditutup', formatDateTime(b.closed_at)],
    ['Terkirim', formatDateTime(b.sent_at)],
    ['Percobaan kirim', String(b.send_attempts ?? 0)],
    ['Error terakhir', b.last_error || '–'],
    ['Provider WA', data.whatsapp.provider],
    ['Nomor tujuan', data.whatsapp.targets.join(', ') || '(belum diset)'],
  ];
  $('meta').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
  $('send').textContent = b.status === 'sent' ? 'Kirim ulang rekap' : 'Kirim rekap sekarang';
  $('reopen').hidden = !(data.isToday && b.status !== 'open');
  current = data;

  $('orders').replaceChildren(...data.orders.map(renderOrder));
  $('orders-empty').hidden = data.orders.length > 0;
  $('recap-text').textContent = data.recapText;

  const png = await (await api(`/api/admin/recap.png?date=${encodeURIComponent($('date').value)}`)).blob();
  const img = $('recap-img');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(png);
}

function renderOrder(o) {
  const li = document.createElement('li');
  const qty = document.createElement('span');
  qty.className = 'qty';
  qty.textContent = `${o.quantity}×`;
  const body = document.createElement('div');
  body.className = 'body';
  const food = document.createElement('div');
  food.textContent = o.food;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = [o.name, o.notes, formatDateTime(o.createdAt)].filter(Boolean).join(' · ');
  body.append(food, who);
  const del = document.createElement('button');
  del.className = 'danger';
  del.type = 'button';
  del.textContent = 'Hapus';
  del.addEventListener('click', async () => {
    if (!confirm(`Hapus pesanan ${o.name} (${o.food})?`)) return;
    try {
      await api(`/api/admin/orders/${o.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      if (err.message !== 'unauthorized') alert(err.message);
    }
  });
  li.append(qty, body, del);
  return li;
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  token = $('token').value.trim();
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
  init().catch((err) => { if (err.message !== 'unauthorized') $('login-message').textContent = err.message; });
});

$('send').addEventListener('click', async () => {
  if (!confirm('Kirim rekap batch ini ke WhatsApp sekarang?')) return;
  $('send').disabled = true;
  setMessage('Mengirim…');
  try {
    await api(`/api/admin/send?date=${encodeURIComponent($('date').value)}`, { method: 'POST' });
    setMessage('Rekap berhasil dikirim.', 'ok');
  } catch (err) {
    if (err.message !== 'unauthorized') setMessage(err.message, 'err');
  } finally {
    $('send').disabled = false;
    init().catch(() => {});
  }
});

$('reopen').addEventListener('click', async () => {
  const note = current.pastCutoff
    ? `Jam tutup (${current.cutoffLabel}) sudah lewat, jadi batch akan langsung ditutup lagi dan rekap dikirim ulang otomatis dalam ±30 detik.`
    : `Form akan menerima pesanan untuk hari ini lagi, dan rekap dikirim otomatis pukul ${current.cutoffLabel}.`;
  if (!confirm(`Reset batch hari ini? Pesanan yang sudah ada tetap tersimpan.\n\n${note}`)) return;
  $('reopen').disabled = true;
  try {
    await api(`/api/admin/reopen?date=${encodeURIComponent($('date').value)}`, { method: 'POST' });
    setMessage('Batch berhasil di-reset.', 'ok');
  } catch (err) {
    if (err.message !== 'unauthorized') setMessage(err.message, 'err');
  } finally {
    $('reopen').disabled = false;
    init().catch(() => {});
  }
});

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('cutoff').value;
  if (!value) return setSettingsMessage('Isi jam tutup terlebih dahulu.', 'err');
  if (value === settings.cutoffTime) return setSettingsMessage('Jam tutup tidak berubah.');

  const label = `${value.replace(':', '.')} WIB`;
  if (value <= wibNow() && settings.todayStatus === 'open') {
    const ok = confirm(`Pukul ${label} sudah lewat untuk hari ini.\n\nBatch hari ini akan langsung ditutup dan rekapnya dikirim dalam ±30 detik. Lanjutkan?`);
    if (!ok) return;
  }

  try {
    settings = await (await api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cutoffTime: value }),
    })).json();
    $('cutoff').value = settings.cutoffTime;
    setSettingsMessage(`Jam tutup disimpan: ${settings.cutoffLabel}. Langsung berlaku tanpa restart.`, 'ok');

    // Jam tutup dimundurkan, tapi batch hari ini sudah terlanjur ditutup/dikirim.
    if (!settings.pastCutoff && settings.todayStatus !== 'open') {
      const reopen = confirm(`Batch hari ini sudah ditutup sebelumnya.\n\nBuka kembali agar form menerima pesanan hari ini sampai ${settings.cutoffLabel}? Pesanan yang sudah ada tetap tersimpan.`);
      if (reopen) {
        await api('/api/admin/reopen', { method: 'POST' });
        setSettingsMessage(`Jam tutup disimpan: ${settings.cutoffLabel}. Batch hari ini dibuka kembali.`, 'ok');
        await loadSettings();
      }
    }
  } catch (err) {
    if (err.message !== 'unauthorized') setSettingsMessage(err.message, 'err');
  } finally {
    load().catch(() => {});
  }
});

$('refresh').addEventListener('click', () => load().catch((err) => setMessage(err.message, 'err')));
$('date').addEventListener('change', () => { setMessage(''); load().catch((err) => setMessage(err.message, 'err')); });
$('logout').addEventListener('click', () => showLogin());

if (token) init().catch(() => {});
else showLogin();
