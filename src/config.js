import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Muat .env bila ada (Node >= 21.7), tanpa dependensi tambahan.
try {
  process.loadEnvFile();
} catch {
  // .env opsional
}

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'ya'].includes(value.toLowerCase());
}

const env = process.env;

/** Dulu jam tutup diatur lewat .env; kini lewat halaman admin. */
export const legacyCutoffEnv = env.CUTOFF_TIME;

export const config = {
  port: Number(env.PORT || 3000),
  appTitle: env.APP_TITLE || 'Pesan Makan Siang',
  dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
  adminToken: env.ADMIN_TOKEN || '',
  sendWhenEmpty: parseBool(env.SEND_WHEN_EMPTY, true),
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 30_000),
  retryDelayMs: Number(env.RETRY_DELAY_MS || 5 * 60_000),
  maxSendAttempts: Number(env.MAX_SEND_ATTEMPTS || 5),
  whatsapp: {
    provider: (env.WA_PROVIDER || 'console').toLowerCase(),
    targets: (env.WA_TARGETS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    fonnteToken: env.FONNTE_TOKEN || '',
    cloudApiToken: env.WA_CLOUD_TOKEN || '',
    cloudApiPhoneNumberId: env.WA_CLOUD_PHONE_NUMBER_ID || '',
    cloudApiVersion: env.WA_CLOUD_API_VERSION || 'v21.0',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_WHATSAPP_FROM || '',
    twilioContentSid: env.TWILIO_CONTENT_SID || '',
  },
};
