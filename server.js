const express = require('express');
const helmet = require('helmet');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ENGINE_API_KEY;
const WEBHOOK_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN;
const WEBHOOK_URL = process.env.BASE44_WEBHOOK_URL || '';
const SESSION_DIR = process.env.SESSION_DIR || '/data/sessions';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();

if (!API_KEY || !WEBHOOK_TOKEN) {
  logger.error('Missing ENGINE_API_KEY or WHATSAPP_WEBHOOK_TOKEN environment variable');
  process.exit(1);
}

fs.mkdirSync(SESSION_DIR, { recursive: true });
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function auth(req, res, next) {
  const supplied = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, API_KEY)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

function validUserId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function sessionPath(userId) {
  return path.join(SESSION_DIR, userId);
}

async function sendWebhook(event, userId, data = {}) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-token': WEBHOOK_TOKEN
      },
      body: JSON.stringify({ source: 'king-ai-whatsapp-engine', event, userId, data, timestamp: new Date().toISOString() })
    });
  } catch (err) {
    logger.warn({ err: err.message, event, userId }, 'Webhook delivery failed');
  }
}

function publicStatus(userId) {
  const s = sessions.get(userId);
  return {
    userId,
    connected: Boolean(s?.connected),
    connecting: Boolean(s?.connecting),
    phone: s?.phone || null,
    qr: s?.qr || null
  };
}

async function startSession(userId) {
  const existing = sessions.get(userId);
  if (existing?.connecting || existing?.connected) return existing;

  const dir = sessionPath(userId);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const record = { sock: null, connected: false, connecting: true, phone: null, qr: null };
  sessions.set(userId, record);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: logger.child({ userId }),
    browser: ['KING AI', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });
  record.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      record.qr = await QRCode.toDataURL(qr);
      record.connecting = true;
      await sendWebhook('whatsapp.qr', userId, { qr: record.qr });
    }
    if (connection === 'open') {
      record.connected = true;
      record.connecting = false;
      record.qr = null;
      record.phone = sock.user?.id?.split(':')[0] || null;
      await sendWebhook('whatsapp.connected', userId, { phone: record.phone });
      logger.info({ userId }, 'WhatsApp connected');
    }
    if (connection === 'close') {
      record.connected = false;
      record.connecting = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      record.qr = null;
      await sendWebhook('whatsapp.disconnected', userId, { code: code || null });
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startSession(userId).catch(err => logger.error({ userId, err: err.message }, 'Reconnect failed')), 5000);
      } else {
        sessions.delete(userId);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages || []) {
      if (!msg.message || msg.key.fromMe) continue;
      await sendWebhook('whatsapp.message', userId, {
        messageId: msg.key.id,
        from: msg.key.remoteJid,
        pushName: msg.pushName || null,
        text: extractText(msg.message),
        timestamp: msg.messageTimestamp || null,
        type
      });
    }
  });

  return record;
}

function extractText(message) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    '';
}

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'KING AI WhatsApp Engine', status: 'online' });
});

app.use('/api', auth);

app.post('/api/whatsapp/connect', async (req, res) => {
  const { userId } = req.body || {};
  if (!validUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
  try {
    await startSession(userId);
    res.json({ success: true, ...publicStatus(userId), message: 'Session initialization started. Poll status for QR code.' });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Connect failed');
    res.status(500).json({ success: false, error: 'Could not start WhatsApp session' });
  }
});

app.get('/api/whatsapp/status/:userId', (req, res) => {
  if (!validUserId(req.params.userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
  res.json({ success: true, ...publicStatus(req.params.userId) });
});

app.post('/api/whatsapp/send', async (req, res) => {
  const { userId, to, message } = req.body || {};
  if (!validUserId(userId) || typeof to !== 'string' || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'userId, to and message are required' });
  }
  const record = sessions.get(userId);
  if (!record?.connected || !record.sock) return res.status(409).json({ success: false, error: 'WhatsApp is not connected' });
  const digits = to.replace(/[^\d]/g, '');
  if (digits.length < 7 || digits.length > 15) return res.status(400).json({ success: false, error: 'Invalid recipient number' });
  try {
    const result = await record.sock.sendMessage(`${digits}@s.whatsapp.net`, { text: message });
    res.json({ success: true, messageId: result?.key?.id || null });
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Message send failed');
    res.status(500).json({ success: false, error: 'Message could not be sent' });
  }
});

app.post('/api/whatsapp/logout', async (req, res) => {
  const { userId } = req.body || {};
  if (!validUserId(userId)) return res.status(400).json({ success: false, error: 'Invalid userId' });
  const record = sessions.get(userId);
  try {
    if (record?.sock) await record.sock.logout();
  } catch (err) {
    logger.warn({ err: err.message, userId }, 'Logout warning');
  }
  sessions.delete(userId);
  fs.rmSync(sessionPath(userId), { recursive: true, force: true });
  await sendWebhook('whatsapp.logged_out', userId);
  res.json({ success: true });
});

// Restore previously authenticated sessions after a Railway restart.
async function restoreSessions() {
  for (const entry of fs.readdirSync(SESSION_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validUserId(entry.name)) continue;
    try {
      const creds = path.join(SESSION_DIR, entry.name, 'creds.json');
      if (fs.existsSync(creds)) await startSession(entry.name);
    } catch (err) {
      logger.error({ userId: entry.name, err: err.message }, 'Session restore failed');
    }
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  logger.info({ port: PORT }, 'KING AI WhatsApp Engine started');
  await restoreSessions();
});
