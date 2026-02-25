import "dotenv/config";
import express from "express";
import path from "node:path";
import { validateSignature, handleWebhook } from "./line.js";
import { adminRouter } from "./admin/index.js";
import { googleRouter } from "./google/routes.js";

// Process-level error handlers — ป้องกัน crash จาก unhandled errors (เช่น socket close ระหว่าง download)
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception (process kept alive):", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection (process kept alive):", reason);
});

const app = express();
const PORT = process.env.PORT || 9000;

// Serve audio files for TTS (LINE ต้องการ public URL สำหรับ audio message)
app.use("/audio", express.static(path.resolve("./data/audio")));

// Serve generated web apps/games (webapp tool)
app.use("/app", express.static(path.resolve("./data/apps")));

// Log request (skip admin API polling — รก console)
app.use((req, _res, next) => {
  if (!req.path.startsWith("/admin/api/")) {
    console.log(`[HTTP] ${req.method} ${req.path} from ${req.ip}`);
  }
  next();
});

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "MyClaw is running" });
});

// Admin dashboard
app.use("/admin", adminRouter);

// Google OAuth wizard (public, no auth)
app.use("/google", googleRouter);

// LINE webhook endpoint — เก็บ raw body ไว้ validate signature
const rawBodyMap = new WeakMap<express.Request, Buffer>();

app.post(
  "/webhook",
  (req, res, next) => {
    express.json({
      verify: (r, _res, buf) => {
        rawBodyMap.set(r as express.Request, buf);
      },
    })(req, res, (err) => {
      if (err) {
        console.log(`[WEBHOOK] JSON parse error: ${err.message}`);
        res.sendStatus(200);
        return;
      }
      next();
    });
  },
  (req, res) => {
    const signature = req.headers["x-line-signature"] as string;
    const body = rawBodyMap.get(req) ?? Buffer.from(JSON.stringify(req.body));

    console.log(`[WEBHOOK] received, signature: ${signature ? "yes" : "NO"}, body: ${body.length} bytes`);

  // Auto-detect BASE_URL จาก webhook request (ทำงานกับ ngrok/reverse proxy อัตโนมัติ)
  if (!process.env.BASE_URL) {
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
    if (host) {
      const proto = (req.headers["x-forwarded-proto"] as string) || "https";
      process.env.BASE_URL = `${proto}://${host}`;
      console.log(`[SERVER] Auto-detected BASE_URL: ${process.env.BASE_URL}`);
    }
  }

  if (!signature || !validateSignature(body, signature)) {
    console.log("[WEBHOOK] signature validation failed — ignoring");
    res.sendStatus(200); // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry
    return;
  }

  handleWebhook(req.body.events).catch(console.error);
  res.sendStatus(200);
  },
);

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
