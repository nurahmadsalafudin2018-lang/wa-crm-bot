const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "wa-crm-bot"
  });
});

app.post("/start-session", (req, res) => {
  const { session_id } = req.body;

  res.json({
    ok: true,
    message: "Session created",
    session_id
  });
});

app.get("/status", (req, res) => {
  res.json({
    status: "connected"
  });
});

app.get("/qr-code", (req, res) => {
  res.json({
    message: "QR endpoint ready"
  });
});

app.post("/send-message", (req, res) => {
  const { jid, message } = req.body;

  res.json({
    ok: true,
    jid,
    message
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
