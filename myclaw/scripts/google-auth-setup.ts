/**
 * Google OAuth2 Setup Script
 *
 * ใช้สำหรับขอ Refresh Token เพื่อเอาไปใส่ใน .env
 *
 * วิธีใช้:
 * 1. ใส่ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET ใน .env
 * 2. รัน: npx tsx scripts/google-auth-setup.ts
 * 3. เปิด URL ที่แสดง → login Google → authorize
 * 4. Copy refresh_token ไปใส่ .env
 */

import "dotenv/config";
import { google } from "googleapis";
import { createServer } from "http";
import { URL } from "url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim();
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim();
const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

// Scopes ที่ต้องการ (Gmail, Calendar, Drive, Sheets)
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\n❌ ยังไม่ได้ตั้งค่า Google OAuth2 credentials!\n");
  console.error("ขั้นตอน:");
  console.error("1. ไปที่ https://console.cloud.google.com/apis/credentials");
  console.error("2. สร้าง OAuth 2.0 Client ID (Type: Desktop app)");
  console.error("3. ใส่ใน .env:");
  console.error("   GOOGLE_CLIENT_ID=your_client_id");
  console.error("   GOOGLE_CLIENT_SECRET=your_client_secret");
  console.error("\n4. รัน script นี้อีกครั้ง\n");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Generate auth URL
const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

console.log("\n🔐 Google OAuth2 Setup\n");
console.log("════════════════════════════════════════");
console.log("\n📋 เปิด URL นี้ในเบราว์เซอร์:\n");
console.log(authUrl);
console.log("\n════════════════════════════════════════");
console.log(`\n⏳ รอรับ callback ที่ port ${REDIRECT_PORT}...\n`);

// Start local server to receive callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${REDIRECT_PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>❌ Error: ${error}</h1><p>ลองอีกครั้ง</p>`);
    console.error(`\n❌ Auth error: ${error}\n`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h1>❌ No code received</h1>");
    return;
  }

  try {
    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h1>✅ สำเร็จ!</h1>
        <p>ได้ refresh token แล้ว กลับไปดูที่ terminal</p>
        <p style="color: #888;">ปิดหน้านี้ได้เลย</p>
      </body></html>
    `);

    console.log("\n✅ ได้ token แล้ว!\n");
    console.log("════════════════════════════════════════");
    console.log("\n📋 เพิ่มใน .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\n════════════════════════════════════════");

    if (tokens.access_token) {
      console.log(`\n📌 Access Token (ไม่ต้อง save, จะ auto-refresh):`);
      console.log(`   ${tokens.access_token.substring(0, 30)}...`);
    }

    console.log(`\n📌 Scopes: ${tokens.scope}`);
    console.log(`\n✅ Setup เสร็จ! เปิด .env แล้วใส่ GOOGLE_REFRESH_TOKEN ได้เลย\n`);

    server.close();
    process.exit(0);
  } catch (err: any) {
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h1>❌ Error</h1><pre>${err.message}</pre>`);
    console.error(`\n❌ Token exchange error: ${err.message}\n`);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  // Server started, waiting for callback
});

// Timeout after 5 minutes
setTimeout(() => {
  console.error("\n⏰ Timeout — ไม่ได้รับ callback ภายใน 5 นาที\n");
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
