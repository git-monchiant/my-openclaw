/**
 * Google OAuth Wizard — HTML Templates
 * หน้า wizard สำหรับผูก/ยกเลิก Google Account (ภาษาไทย, mobile-friendly)
 */

const baseStyle = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#1a1a2e;border-radius:16px;padding:40px 32px;max-width:420px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.5)}
.icon{font-size:48px;margin-bottom:16px}
h1{font-size:20px;margin-bottom:8px;color:#fff;font-weight:700}
.sub{color:#888;font-size:13px;margin-bottom:24px;line-height:1.6}
.btn{display:inline-block;width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;text-decoration:none;margin-bottom:10px}
.btn:hover{opacity:.9}
.btn-primary{background:linear-gradient(135deg,#4285f4,#34a853);color:#fff}
.btn-danger{background:linear-gradient(135deg,#ef5350,#ff7043);color:#fff}
.btn-secondary{background:#2a2a3e;color:#aaa}
.scopes{text-align:left;background:#12121f;border-radius:10px;padding:16px 20px;margin:20px 0}
.scopes .item{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:13px;color:#ccc}
.scopes .item span{font-size:18px}
.email{color:#4fc3f7;font-weight:600;font-size:15px}
.note{color:#666;font-size:12px;margin-top:16px;line-height:1.5}
`;

/** Wizard setup page — อธิบายสิทธิ์ + ปุ่ม Connect */
export function getSetupHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>เชื่อมต่อ Google — MyClaw</title>
<style>${baseStyle}</style>
</head>
<body>
<div class="card">
  <div class="icon">🔗</div>
  <h1>เชื่อมต่อ Google Account</h1>
  <p class="sub">เพื่อให้ MyClaw จัดการอีเมล ปฏิทิน ไดรฟ์ และ Sheets ให้คุณได้</p>

  <div class="scopes">
    <div class="item"><span>📧</span> อ่านและส่ง Gmail</div>
    <div class="item"><span>📅</span> จัดการ Google Calendar</div>
    <div class="item"><span>📁</span> อ่าน/เขียน Google Drive</div>
    <div class="item"><span>📊</span> อ่าน/เขียน Google Sheets</div>
  </div>

  <a href="/google/connect?token=${encodeURIComponent(token)}" class="btn btn-primary">เชื่อมต่อ Google Account</a>

  <p class="note">
    ข้อมูลของคุณถูกเข้ารหัสและเก็บอย่างปลอดภัย<br>
    คุณสามารถยกเลิกการเชื่อมต่อได้ทุกเมื่อ
  </p>
</div>
</body></html>`;
}

/** Success page — เชื่อมต่อสำเร็จ */
export function getSuccessHtml(email: string | null): string {
  const emailDisplay = email ? `<p class="email">${email}</p>` : "";
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>สำเร็จ — MyClaw</title>
<style>${baseStyle}</style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>เชื่อมต่อสำเร็จ!</h1>
  ${emailDisplay}
  <p class="sub">Google Account ถูกเชื่อมต่อกับ MyClaw แล้ว<br>กลับไปที่ LINE แล้วลองสั่งได้เลย</p>

  <a href="https://line.me/R/" class="btn btn-primary">กลับไปที่ LINE</a>

  <p class="note">
    ลองพิมพ์ "วันนี้มีนัดอะไร" หรือ "ดู inbox" ใน LINE ได้เลย
  </p>
</div>
</body></html>`;
}

/** Error page */
export function getErrorHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ผิดพลาด — MyClaw</title>
<style>${baseStyle}</style>
</head>
<body>
<div class="card">
  <div class="icon">❌</div>
  <h1>${title}</h1>
  <p class="sub">${detail}</p>

  <a href="https://line.me/R/" class="btn btn-secondary">กลับไปที่ LINE</a>

  <p class="note">กรุณาลองใหม่อีกครั้ง หรือพิมพ์ "เชื่อมต่อ google" ใน LINE</p>
</div>
</body></html>`;
}

/** Status page — แสดงสถานะ + ปุ่ม unlink */
export function getStatusHtml(email: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>สถานะ Google — MyClaw</title>
<style>${baseStyle}</style>
</head>
<body>
<div class="card">
  <div class="icon">🔗</div>
  <h1>Google Account เชื่อมต่อแล้ว</h1>
  <p class="email">${email}</p>
  <p class="sub">MyClaw สามารถจัดการอีเมล ปฏิทิน ไดรฟ์ และ Sheets ให้คุณได้</p>

  <a href="https://line.me/R/" class="btn btn-primary">กลับไปที่ LINE</a>
  <a href="/google/calendars?token=${encodeURIComponent(token)}" class="btn btn-secondary">เปลี่ยนปฏิทิน</a>
  <a href="/google/unlink?token=${encodeURIComponent(token)}" class="btn btn-danger"
     onclick="return confirm('ยกเลิกการเชื่อมต่อ Google Account?')">
    ยกเลิกการเชื่อมต่อ
  </a>
</div>
</body></html>`;
}

/** Unlinked confirmation page */
export function getUnlinkedHtml(): string {
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ยกเลิกแล้ว — MyClaw</title>
<style>${baseStyle}</style>
</head>
<body>
<div class="card">
  <div class="icon">👋</div>
  <h1>ยกเลิกการเชื่อมต่อแล้ว</h1>
  <p class="sub">Google Account ถูกยกเลิกจาก MyClaw แล้ว<br>คุณสามารถเชื่อมต่อใหม่ได้ทุกเมื่อ</p>

  <a href="https://line.me/R/" class="btn btn-primary">กลับไปที่ LINE</a>

  <p class="note">พิมพ์ "เชื่อมต่อ google" ใน LINE เพื่อเชื่อมต่อใหม่</p>
</div>
</body></html>`;
}

/** Calendar picker — เลือก calendar หลังจาก OAuth สำเร็จ */
export function getCalendarPickerHtml(
  calendars: Array<{ id: string; name: string; primary: boolean; color: string }>,
  email: string | null,
  token: string,
): string {
  const calItems = calendars
    .map((c) => {
      const badge = c.primary ? ' <span style="font-size:10px;background:#34a853;color:#fff;padding:2px 6px;border-radius:4px;margin-left:6px">หลัก</span>' : "";
      return `<a href="/google/select-calendar?token=${encodeURIComponent(token)}&calendar_id=${encodeURIComponent(c.id)}"
        class="cal-item" style="border-left:4px solid ${c.color}">
        <span class="cal-name">${c.name}${badge}</span>
        <span class="cal-id">${c.id === c.name ? "" : c.id}</span>
      </a>`;
    })
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>เลือกปฏิทิน — MyClaw</title>
<style>
${baseStyle}
.cal-list{text-align:left;margin:20px 0}
.cal-item{display:block;background:#12121f;border-radius:8px;padding:14px 16px;margin-bottom:8px;text-decoration:none;color:#e0e0e0;transition:background .2s}
.cal-item:hover{background:#252540}
.cal-name{display:block;font-size:14px;font-weight:600}
.cal-id{display:block;font-size:11px;color:#666;margin-top:2px;word-break:break-all}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📅</div>
  <h1>เลือกปฏิทินหลัก</h1>
  ${email ? `<p class="email">${email}</p>` : ""}
  <p class="sub">เลือกปฏิทินที่ต้องการให้ MyClaw ใช้เป็นค่าเริ่มต้น</p>

  <div class="cal-list">
    ${calItems}
  </div>

  <p class="note">คุณยังสามารถระบุปฏิทินอื่นได้ตอนใช้งานจริง</p>
</div>
</body></html>`;
}
