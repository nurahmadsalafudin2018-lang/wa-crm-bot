/**
 * Baileys Multi-Session WhatsApp Server
 * Satu server bisa menangani BANYAK nomor sekaligus.
 * Tiap nomor punya session_id tersendiri — tidak perlu deploy ulang untuk nomor baru!
 *
 * Endpoint:
 *   POST /send-message        { session_id, jid, message }  — kirim pesan
 *   POST /start-session       { session_id, webhook_url }   — mulai sesi baru / reconnect
 *   GET  /qr-code?session_id= — ambil QR code sesi
 *   GET  /status?session_id=  — status sesi
 *   DELETE /session?session_id= — hapus sesi (logout)
 */

const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const axios = require("axios");
const qrcode = require("qrcode");
const express = require("express");
const fs = require("fs");

const SECRET = process.env.SECRET || "";
const PORT = process.env.PORT || 3000;
// Default webhook jika tidak di-override per sesi
const DEFAULT_WEBHOOK = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

// sessions: Map<session_id, { sock, status, qr, webhookUrl }>
const sessions = new Map();

function authMiddleware(req, res, next) {
  const secret = req.headers["x-secret"];
  if (SECRET && secret !== SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function postWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, payload, { timeout: 10000 });
  } catch (e) {
    console.error(`[webhook] ${e.message}`);
  }
}

async function startSession(sessionId, webhookUrl) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.status === "connected") return; // already connected
    existing.sock?.end?.(); // close old socket
  }

  const authDir = `auth_${sessionId}`;
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ["CRM-Multi", "Chrome", "1.0.0"],
  });

  const session = { sock, status: "connecting", qr: null, webhookUrl };
  sessions.set(sessionId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      session.qr = await qrcode.toDataURL(qr, { width: 300 });
      session.status = "connecting";
      console.log(`[session:${sessionId}] QR ready`);
      await postWebhook(session.webhookUrl, { type: "qr", session_id: sessionId, qr: session.qr });
    }
    if (connection === "open") {
      session.status = "connected";
      session.qr = null;
      console.log(`[session:${sessionId}] Connected!`);
      await postWebhook(session.webhookUrl, { type: "ready", session_id: sessionId });
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      session.status = "disconnected";
      console.log(`[session:${sessionId}] Disconnected, code:`, code);
      await postWebhook(session.webhookUrl, { type: "disconnected", session_id: sessionId, code });
      if (code !== DisconnectReason.loggedOut) {
        console.log(`[session:${sessionId}] Reconnecting in 5s...`);
        setTimeout(() => startSession(sessionId, session.webhookUrl), 5000);
      } else {
        sessions.delete(sessionId);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      if (!from || from.endsWith("@g.us")) continue;
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "[media]";
      await postWebhook(session.webhookUrl, {
        type: "message",
        session_id: sessionId,
        from,
        from_name: msg.pushName || from.split("@")[0],
        body,
        timestamp: msg.messageTimestamp,
      });
    }
  });
}

// POST /start-session — tambah / reconnect nomor tanpa deploy ulang
app.post("/start-session", authMiddleware, async (req, res) => {
  const { session_id, webhook_url } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });
  await startSession(session_id, webhook_url || DEFAULT_WEBHOOK);
  res.json({ ok: true, session_id });
});

// POST /send-message
app.post("/send-message", authMiddleware, async (req, res) => {
  const { session_id, jid, message } = req.body;
  if (!session_id || !jid || !message) return res.status(400).json({ error: "session_id, jid, message required" });
  const session = sessions.get(session_id);
  if (!session || session.status !== "connected") return res.status(503).json({ error: "Session not connected" });
  try {
    await session.sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /qr-code?session_id=
app.get("/qr-code", authMiddleware, (req, res) => {
  const { session_id } = req.query;
  const session = session_id ? sessions.get(session_id) : null;
  if (!session?.qr) return res.status(404).json({ error: "No QR available" });
  res.json({ qr: session.qr });
});

// GET /status?session_id=
app.get("/status", authMiddleware, (req, res) => {
  const { session_id } = req.query;
  if (session_id) {
    const session = sessions.get(session_id);
    return res.json({ status: session?.status || "not_started" });
  }
  // Return all sessions status
  const all = {};
  sessions.forEach((s, id) => { all[id] = s.status; });
  res.json(all);
});

// GET /connection-status — legacy compat (status sesi pertama)
app.get("/connection-status", authMiddleware, (req, res) => {
  const first = sessions.values().next().value;
  res.json({ status: first?.status || "disconnected" });
});

// DELETE /session?session_id= — logout & hapus sesi
app.delete("/session", authMiddleware, async (req, res) => {
  const { session_id } = req.query;
  const session = session_id ? sessions.get(session_id) : null;
  if (!session) return res.status(404).json({ error: "Session not found" });
  try { await session.sock.logout(); } catch (_) {}
  sessions.delete(session_id);
  try { fs.rmSync(`auth_${session_id}`, { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`[server] Running on port ${PORT} — multi-session mode`));

// Auto-restore sessions dari folder auth yang sudah ada
fs.readdirSync(".").filter(d => d.startsWith("auth_") && fs.statSync(d).isDirectory()).forEach(dir => {
  const sessionId = dir.replace("auth_", "");
  console.log(`[server] Restoring session: ${sessionId}`);
  startSession(sessionId, DEFAULT_WEBHOOK).catch(console.error);
});
