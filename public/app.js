const $ = (id) => document.getElementById(id);
const form = $('order-form');
const NAME_KEY = 'pesan-makan:name';

let status = null;
let clockOffset = 0; // selisih jam server - jam browser
let submitting = false;

function formatDate(batchDate) {
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${batchDate}T00:00:00Z`));
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}j ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}d`;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  } catch (err) {
    console.error(`[API Network Error] ${path}:`, err);
    throw new Error(`Koneksi gagal: ${err.message}`);
  }

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    console.error(`[API Non-JSON HTTP ${res.status}] ${path}:`, text);
  }

  if (!res.ok) {
    const msg = body?.error || (text && text.length < 200 ? text : null) || `HTTP ${res.status}`;
    console.error(`[API Error ${res.status}] ${path}:`, msg);
    throw new Error(`Permintaan gagal: ${msg}`);
  }
  return body;
}

async function loadStatus() {
  status = await api('/api/status');
  clockOffset = new Date(status.serverTime).getTime() - Date.now();
  document.title = status.appTitle;
  $('title').textContent = status.appTitle;
  $('date').textContent = `Batch ${formatDate(status.batchDate)}`;
  $('orders-title').textContent = status.batchDate === status.today ? 'Pesanan hari ini' : 'Pesanan untuk besok';
  $('food').maxLength = status.limits.food;
  $('name').maxLength = status.limits.name;
  $('notes').maxLength = status.limits.notes;
  $('quantity').max = status.limits.quantity;
  renderStatus();
}

function renderStatus() {
  if (!status) return;
  const remaining = new Date(status.cutoffAt).getTime() - (Date.now() + clockOffset);
  const isToday = status.batchDate === status.today;
  const open = status.open && remaining > 0;

  $('status').classList.toggle('closed', !open);
  $('status').classList.toggle('next', open && !isToday);
  if (!open) {
    $('status-text').textContent = 'Batch ini sudah ditutup.';
  } else if (isToday) {
    $('status-text').textContent = `Dibuka hingga ${status.cutoffLabel}`;
  } else {
    $('status-text').textContent =
      `Batch hari ini sudah ditutup pukul ${status.cutoffLabel}. Pesanan baru masuk batch besok.`;
  }
  $('countdown').textContent = open ? `ditutup dalam ${formatDuration(remaining)}` : '';
  for (const el of form.elements) el.disabled = !open;
  $('submit').disabled = !open || submitting;

  // Begitu melewati cutoff, server sudah berpindah ke batch berikutnya.
  if (status.open && remaining <= 0) {
    status.open = false;
    showMessage('', '');
    Promise.all([loadStatus(), loadOrders()]).catch(() => {});
  }
}

async function loadOrders() {
  const orders = await api('/api/orders');
  const list = $('orders');
  list.replaceChildren(
    ...orders.map((o) => {
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
      who.textContent = o.notes ? `${o.name} · ${o.notes}` : o.name;
      body.append(food, who);
      li.append(qty, body);
      return li;
    }),
  );
  $('orders-empty').hidden = orders.length > 0;
  const portions = orders.reduce((n, o) => n + o.quantity, 0);
  $('summary').innerHTML = orders.length
    ? `<span><strong>${orders.length}</strong> pesanan</span><span><strong>${portions}</strong> porsi</span>`
    : '';
}

function showMessage(text, kind) {
  const el = $('form-message');
  el.textContent = text;
  el.className = `message ${kind}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (!data.name.trim() || !data.food.trim()) {
    showMessage('Nama dan makanan wajib diisi.', 'err');
    return;
  }
  submitting = true;
  renderStatus();
  try {
    const order = await api('/api/orders', { method: 'POST', body: JSON.stringify(data) });
    try { localStorage.setItem(NAME_KEY, data.name.trim()); } catch {}
    showMessage(`Pesanan "${order.food}" ×${order.quantity} tercatat untuk batch ${formatDate(order.batchDate)}. Terima kasih, ${order.name}!`, 'ok');
    $('food').value = '';
    $('notes').value = '';
    $('quantity').value = 1;
    await loadOrders();
  } catch (err) {
    showMessage(err.message, 'err');
    await loadStatus().catch(() => {});
  } finally {
    submitting = false;
    renderStatus();
  }
});

try { $('name').value = localStorage.getItem(NAME_KEY) || ''; } catch {}

loadStatus().catch((err) => { $('status-text').textContent = err.message; });
loadOrders().catch(() => {});
setInterval(renderStatus, 1000);
setInterval(() => loadOrders().catch(() => {}), 30_000);
// Jam tutup bisa diubah admin kapan saja.
setInterval(() => loadStatus().catch(() => {}), 60_000);
