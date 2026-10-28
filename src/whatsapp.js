import fs from 'node:fs';
import path from 'node:path';

/**
 * Provider WhatsApp. Semua provider mengimplementasikan
 *   send({ text, image, filename }) -> Promise<void>
 * di mana `image` adalah Buffer PNG (boleh null bila render gagal).
 */
export function createWhatsAppSender(waConfig, { dataDir, logger = console } = {}) {
  switch (waConfig.provider) {
    case 'console':
      return consoleProvider({ dataDir, logger, targets: waConfig.targets });
    case 'fonnte':
      requireConfig(waConfig, ['fonnteToken', 'targets'], 'fonnte');
      return fonnteProvider(waConfig);
    case 'cloudapi':
      requireConfig(waConfig, ['cloudApiToken', 'cloudApiPhoneNumberId', 'targets'], 'cloudapi');
      return cloudApiProvider(waConfig);
    default:
      throw new Error(`WA_PROVIDER tidak dikenal: "${waConfig.provider}" (pilih: console, fonnte, cloudapi)`);
  }
}

function requireConfig(waConfig, keys, provider) {
  const missing = keys.filter((k) => (Array.isArray(waConfig[k]) ? waConfig[k].length === 0 : !waConfig[k]));
  if (missing.length) {
    throw new Error(`Konfigurasi WhatsApp provider "${provider}" belum lengkap: ${missing.join(', ')}`);
  }
}

/** Mode pengembangan: tidak mengirim apa pun, hanya menyimpan file & mencetak log. */
function consoleProvider({ dataDir, logger, targets }) {
  const outDir = path.join(dataDir, 'outbox');
  return {
    name: 'console',
    async send({ text, image, filename }) {
      fs.mkdirSync(outDir, { recursive: true });
      const base = path.join(outDir, filename.replace(/\.png$/, ''));
      fs.writeFileSync(`${base}.txt`, text);
      if (image) fs.writeFileSync(`${base}.png`, image);
      logger.log(`[whatsapp:console] Tujuan: ${targets.join(', ') || '(WA_TARGETS kosong)'}`);
      logger.log(`[whatsapp:console] Disimpan ke ${base}.txt${image ? ' dan .png' : ''}\n${text}`);
    },
  };
}

/** https://fonnte.com — gateway WhatsApp yang umum dipakai di Indonesia. */
function fonnteProvider({ fonnteToken, targets }) {
  return {
    name: 'fonnte',
    async send({ text, image, filename }) {
      const form = new FormData();
      form.append('target', targets.join(','));
      form.append('message', text);
      form.append('countryCode', '62');
      if (image) form.append('file', new Blob([image], { type: 'image/png' }), filename);

      const res = await fetch('https://api.fonnte.com/send', {
        method: 'POST',
        headers: { Authorization: fonnteToken },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      // Fonnte bisa membalas HTTP 200 dengan status=false, jadi cek keduanya.
      if (!res.ok || body.status !== true) {
        throw new Error(`Fonnte gagal (HTTP ${res.status}): ${body.reason || body.detail || JSON.stringify(body)}`);
      }
    },
  };
}

/** WhatsApp Business Cloud API (resmi dari Meta). */
function cloudApiProvider({ cloudApiToken, cloudApiPhoneNumberId, cloudApiVersion, targets }) {
  const base = `https://graph.facebook.com/${cloudApiVersion}/${cloudApiPhoneNumberId}`;
  const auth = { Authorization: `Bearer ${cloudApiToken}` };

  async function call(url, init) {
    const res = await fetch(url, { ...init, headers: { ...auth, ...init.headers } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`WhatsApp Cloud API gagal (HTTP ${res.status}): ${body.error?.message || JSON.stringify(body)}`);
    }
    return body;
  }

  const sendMessage = (to, payload) =>
    call(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
    });

  return {
    name: 'cloudapi',
    async send({ text, image, filename }) {
      let mediaId = null;
      if (image) {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'image/png');
        form.append('file', new Blob([image], { type: 'image/png' }), filename);
        mediaId = (await call(`${base}/media`, { method: 'POST', body: form })).id;
      }

      // Caption gambar maksimal 1024 karakter; teks biasa maksimal 4096.
      const captionFits = text.length <= 1024;
      for (const to of targets) {
        if (mediaId) {
          await sendMessage(to, { type: 'image', image: { id: mediaId, ...(captionFits ? { caption: text } : {}) } });
        }
        if (!mediaId || !captionFits) {
          for (const chunk of chunkText(text, 4096)) {
            await sendMessage(to, { type: 'text', text: { body: chunk, preview_url: false } });
          }
        }
      }
    },
  };
}

export function chunkText(text, size) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= size) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = line;
    while (current.length > size) {
      chunks.push(current.slice(0, size));
      current = current.slice(size);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
