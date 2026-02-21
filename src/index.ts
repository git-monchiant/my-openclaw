import "dotenv/config";
import express from "express";
import { validateSignature, handleWebhook } from "./line.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "MyClaw is running" });
});

// LINE webhook endpoint — ใช้ raw body เพื่อ validate signature เอง
app.post("/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-line-signature"] as string;
  const body = req.body as Buffer;

  console.log(`[WEBHOOK] received, signature: ${signature ? "yes" : "NO"}, body: ${body.length} bytes`);

  if (!signature || !validateSignature(body, signature)) {
    console.log("[WEBHOOK] signature validation failed — ignoring");
    res.sendStatus(200); // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry
    return;
  }

  const parsed = JSON.parse(body.toString());
  handleWebhook(parsed.events).catch(console.error);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════╗
  ║     🦞 MyClaw Mini v1.0.0       ║
  ║     LINE + Claude AI Bot         ║
  ║     Port: ${String(PORT).padEnd(23)}║
  ║     Webhook: /webhook            ║
  ╚══════════════════════════════════╝
  `);
});
