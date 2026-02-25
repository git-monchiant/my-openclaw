/**
 * Google OAuth Routes — Wizard flow for per-user Google account linking
 *
 * Routes:
 *   GET /google/setup?token=xxx     — Wizard landing page
 *   GET /google/connect?token=xxx   — Redirect to Google OAuth consent
 *   GET /google/callback            — Google OAuth callback
 *   GET /google/unlink?token=xxx    — Unlink Google account
 */

import { Router } from "express";
import crypto from "node:crypto";
import { google } from "googleapis";
import {
  createOAuthState,
  consumeOAuthState,
  saveUserTokens,
  getUserTokens,
  deleteUserTokens,
  isUserLinked,
  setDefaultCalendar,
} from "./store.js";
import { clearUserGoogleAuth } from "../tools/google-auth.js";
import {
  getSetupHtml,
  getSuccessHtml,
  getErrorHtml,
  getStatusHtml,
  getUnlinkedHtml,
  getCalendarPickerHtml,
} from "./html.js";

export const googleRouter = Router();

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
];

function getDataDir(): string {
  return process.env.DATA_DIR || "./data";
}

function getBaseUrl(): string {
  return process.env.BASE_URL || "";
}

// ===== Setup Token — signed userId reference for URLs =====

export function signSetupToken(userId: string): string {
  const secret = process.env.LINE_CHANNEL_SECRET!;
  const ts = Date.now().toString();
  const payload = `${userId}:${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

function verifySetupToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length !== 3) return null;
    const [userId, ts, sig] = parts;

    // Verify signature
    const secret = process.env.LINE_CHANNEL_SECRET;
    if (!secret) return null;
    const expected = crypto.createHmac("sha256", secret).update(`${userId}:${ts}`).digest("hex");
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8"))) return null;

    // Check expiry (1 hour)
    if (Date.now() - parseInt(ts) > 60 * 60 * 1000) return null;

    return userId;
  } catch {
    return null;
  }
}

// ===== GET /google/setup =====
googleRouter.get("/setup", (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send(getErrorHtml("ลิงก์ไม่ถูกต้อง", "ไม่มี token"));
    return;
  }

  const userId = verifySetupToken(token);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุหรือไม่ถูกต้อง", "กรุณาขอลิงก์ใหม่จาก MyClaw ใน LINE"));
    return;
  }

  // If already linked, show status page
  const linked = isUserLinked(getDataDir(), userId);
  if (linked) {
    const tokens = getUserTokens(getDataDir(), userId);
    res.send(getStatusHtml(tokens?.googleEmail || "Connected", token));
    return;
  }

  res.send(getSetupHtml(token));
});

// ===== GET /google/connect =====
googleRouter.get("/connect", (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send(getErrorHtml("ลิงก์ไม่ถูกต้อง", ""));
    return;
  }

  const userId = verifySetupToken(token);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุ", "กรุณาขอลิงก์ใหม่จาก MyClaw ใน LINE"));
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    res.status(500).send(
      getErrorHtml("ระบบยังไม่ได้ตั้งค่า", "แจ้ง Admin ให้ตั้งค่า GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"),
    );
    return;
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    res.status(500).send(getErrorHtml("ระบบยังไม่พร้อม", "BASE_URL ยังไม่ได้ตั้งค่า"));
    return;
  }

  // Create nonce state
  const nonce = createOAuthState(getDataDir(), userId);

  // Redirect to Google consent
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, `${baseUrl}/google/callback`);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state: nonce,
  });

  res.redirect(authUrl);
});

// ===== GET /google/callback =====
googleRouter.get("/callback", async (req, res) => {
  const code = req.query.code as string;
  const state = req.query.state as string;
  const error = req.query.error as string;

  if (error) {
    res.send(
      getErrorHtml(
        "การเชื่อมต่อถูกยกเลิก",
        error === "access_denied" ? "คุณยกเลิกการอนุญาต" : error,
      ),
    );
    return;
  }

  if (!code || !state) {
    res.status(400).send(getErrorHtml("ข้อมูลไม่ครบ", "Missing code or state"));
    return;
  }

  // Validate nonce
  const userId = consumeOAuthState(getDataDir(), state);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุ", "State expired หรือถูกใช้แล้ว กรุณาลองใหม่"));
    return;
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID!.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!.trim();
    const baseUrl = getBaseUrl();

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, `${baseUrl}/google/callback`);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.send(
        getErrorHtml(
          "ไม่ได้รับ refresh token",
          "ลอง revoke access ที่ myaccount.google.com/permissions แล้วลองใหม่",
        ),
      );
      return;
    }

    // Get user email from Google
    oauth2Client.setCredentials(tokens);
    let email: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      email = userInfo.data.email || null;
    } catch {
      // non-critical
    }

    // Store encrypted tokens
    saveUserTokens(getDataDir(), {
      userId,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || undefined,
      expiry: tokens.expiry_date || undefined,
      scopes: GOOGLE_SCOPES.join(" "),
      googleEmail: email || undefined,
    });

    // Clear any cached client so next request uses new tokens
    clearUserGoogleAuth(userId);

    console.log(`[google-oauth] User ${userId.substring(0, 8)}... linked Google: ${email || "unknown"}`);

    // Redirect to calendar picker
    const setupToken = signSetupToken(userId);
    res.redirect(`/google/calendars?token=${setupToken}`);
  } catch (err: any) {
    console.error("[google-oauth] Token exchange failed:", err);
    res.send(getErrorHtml("เชื่อมต่อไม่สำเร็จ", err?.message || "Unknown error"));
  }
});

// ===== GET /google/calendars — Calendar picker after OAuth =====
googleRouter.get("/calendars", async (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send(getErrorHtml("ลิงก์ไม่ถูกต้อง", ""));
    return;
  }

  const userId = verifySetupToken(token);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุ", "กรุณาขอลิงก์ใหม่"));
    return;
  }

  const tokens = getUserTokens(getDataDir(), userId);
  if (!tokens) {
    res.send(getErrorHtml("ยังไม่ได้เชื่อมต่อ Google", "กรุณาเชื่อมต่อก่อน"));
    return;
  }

  try {
    const clientId = process.env.GOOGLE_CLIENT_ID!.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET!.trim();
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: tokens.refreshToken });

    const cal = google.calendar({ version: "v3", auth: oauth2Client });
    const calList = await cal.calendarList.list();
    const calendars = (calList.data.items || []).map((c) => ({
      id: c.id || "",
      name: c.summary || "",
      primary: c.primary || false,
      color: c.backgroundColor || "#4285f4",
    }));

    res.send(getCalendarPickerHtml(calendars, tokens.googleEmail, token));
  } catch (err: any) {
    console.error("[google-oauth] Failed to list calendars:", err);
    // Fall back to success page if calendar listing fails
    res.send(getSuccessHtml(tokens.googleEmail));
  }
});

// ===== GET /google/select-calendar — Save calendar selection =====
googleRouter.get("/select-calendar", (req, res) => {
  const token = req.query.token as string;
  const calendarId = req.query.calendar_id as string;
  if (!token || !calendarId) {
    res.status(400).send(getErrorHtml("ข้อมูลไม่ครบ", ""));
    return;
  }

  const userId = verifySetupToken(token);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุ", "กรุณาขอลิงก์ใหม่"));
    return;
  }

  setDefaultCalendar(getDataDir(), userId, calendarId);
  clearUserGoogleAuth(userId);

  const tokens = getUserTokens(getDataDir(), userId);
  console.log(`[google-oauth] User ${userId.substring(0, 8)}... selected calendar: ${calendarId}`);
  res.send(getSuccessHtml(tokens?.googleEmail || null));
});

// ===== GET /google/unlink =====
googleRouter.get("/unlink", (req, res) => {
  const token = req.query.token as string;
  if (!token) {
    res.status(400).send(getErrorHtml("ลิงก์ไม่ถูกต้อง", ""));
    return;
  }

  const userId = verifySetupToken(token);
  if (!userId) {
    res.send(getErrorHtml("ลิงก์หมดอายุ", "กรุณาขอลิงก์ใหม่"));
    return;
  }

  deleteUserTokens(getDataDir(), userId);
  clearUserGoogleAuth(userId);

  console.log(`[google-oauth] User ${userId.substring(0, 8)}... unlinked Google`);
  res.send(getUnlinkedHtml());
});
