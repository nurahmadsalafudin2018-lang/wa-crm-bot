from pathlib import Path

server_js = r'''/**
 * Baileys Multi-Session WhatsApp Server
 * Railway Ready
 */

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const express = require("express");
const axios = require("axios");
const qrcode = require("qrcode");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || "";
const DEFAULT_WEBHOOK = process.env.WEBHOOK_URL || "";

const app = express();
app.use(express.json());

const sessions = new Map();

function authMiddleware(req, res, next) {
  const secret = req.headers["x-secret"];
  if (SECRET && secret !== SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

async function postWebhook(url, payload) {
  if (!url) return;
  try {
    await axios.post(url, payload, { timeout: 10000 });
  } catch (err) {
    console.error("Webhook error:", err.message);
  }
}

async function startSession(sessionId, webhookUrl) {
  const authDir = `auth_${sessionId}`;

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ["WA CRM", "Chrome", "1.0.0"]
  });

  const session = {
    sock,
    status: "connecting",
    qr: null,
    webhookUrl
  };

  sessions.set(sessionId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, qr, lastDisconnect }) => {

    if (qr) {
      session.qr = await qrcode.toDataURL(qr);
      session.status = "qr_ready";

      await postWebhook(webhookUrl, {
        type: "qr",
        session_id: sessionId,
        qr: session.qr
      });
    }

    if (connection === "open") {
      session.status = "connected";
      session.qr = null;

      await postWebhook(webhookUrl, {
        type: "ready",
        session_id: sessionId
      });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;

      session.status = "disconnected";

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          startSession(sessionId, webhookUrl);
        }, 5000);
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

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "[media]";

      await postWebhook(webhookUrl, {
        type: "message",
        session_id: sessionId,
        from,
        from_name: msg.pushName || "",
        body,
        timestamp: msg.messageTimestamp
      });
    }
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "wa-crm-bot",
    sessions: sessions.size
  });
});

app.post("/start-session", authMiddleware, async (req, res) => {
  const { session_id, webhook_url } = req.body;

  if (!session_id) {
    return res.status(400).json({
      error: "session_id required"
    });
  }

  await startSession(
    session_id,
    webhook_url || DEFAULT_WEBHOOK
  );

  res.json({
    ok: true,
    session_id
  });
});

app.get("/qr-code", authMiddleware, (req, res) => {
  const session = sessions.get(req.query.session_id);

  if (!session?.qr) {
    return res.status(404).json({
      error: "QR not available"
    });
  }

  res.json({
    qr: session.qr
  });
});

app.get("/status", authMiddleware, (req, res) => {
  const session = sessions.get(req.query.session_id);

  res.json({
    status: session?.status || "not_started"
  });
});

app.post("/send-message", authMiddleware, async (req, res) => {
  const { session_id, jid, message } = req.body;

  const session = sessions.get(session_id);

  if (!session || session.status !== "connected") {
    return res.status(503).json({
      error: "Session not connected"
    });
  }

  try {
    await session.sock.sendMessage(jid, {
      text: message
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.delete("/session", authMiddleware, async (req, res) => {
  const sessionId = req.query.session_id;

  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({
      error: "Session not found"
    });
  }

  try {
    await session.sock.logout();
  } catch {}

  sessions.delete(sessionId);

  try {
    fs.rmSync(`auth_${sessionId}`, {
      recursive: true,
      force: true
    });
  } catch {}

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

fs.readdirSync(".")
  .filter(f => f.startsWith("auth_"))
  .forEach(dir => {
    const sessionId = dir.replace("auth_", "");
    startSession(sessionId, DEFAULT_WEBHOOK)
      .catch(console.error);
  });
'''

path = "/mnt/data/server.js"
Path(path).write_text(server_js, encoding="utf-8")
print(path)

