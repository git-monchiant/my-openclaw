#!/usr/bin/env python3
"""One-time OAuth bootstrap for the Calendar tool.

Mints a Google Calendar refresh token and saves it to ~/.hermes/.env as
GOOGLE_CALENDAR_REFRESH_TOKEN, which tools/calendar_tool.py then uses.

Prereqs in ~/.hermes/.env:
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET

The OAuth client must allow the redirect URI  http://localhost:8765/
(add it under the client's "Authorized redirect URIs" in Google Cloud Console).

Run:
    python scripts/family/calendar_auth.py
A browser opens → authorize → the token is saved automatically.
"""
from __future__ import annotations

import http.server
import secrets
import sys
import urllib.parse
import webbrowser
from pathlib import Path

import httpx

ENV_PATH = Path.home() / ".hermes" / ".env"
REDIRECT_URI = "http://localhost:8765/"
PORT = 8765
SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def _load_env() -> dict[str, str]:
    d: dict[str, str] = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def _save_refresh_token(token: str) -> None:
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    lines = [l for l in lines if not l.startswith("GOOGLE_CALENDAR_REFRESH_TOKEN=")]
    lines.append(f"GOOGLE_CALENDAR_REFRESH_TOKEN={token}")
    ENV_PATH.write_text("\n".join(lines) + "\n")


def main() -> int:
    env = _load_env()
    cid, csec = env.get("GOOGLE_CLIENT_ID"), env.get("GOOGLE_CLIENT_SECRET")
    if not cid or not csec:
        print("ERROR: ตั้ง GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET ใน ~/.hermes/.env ก่อน")
        return 1

    state = secrets.token_urlsafe(16)
    holder: dict[str, str | None] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            holder["code"] = (qs.get("code") or [None])[0]
            holder["state"] = (qs.get("state") or [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("✓ Authorized — กลับไปที่ terminal ได้เลย".encode("utf-8"))

        def log_message(self, *a):  # silence
            pass

    params = urllib.parse.urlencode({
        "client_id": cid,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",   # force a refresh_token even if already granted
        "state": state,
    })
    url = f"{AUTH_URL}?{params}"
    # Also persist the URL so it can be retrieved even when stdout is buffered.
    try:
        (Path.home() / ".hermes" / "calendar_auth_url.txt").write_text(url + "\n")
    except Exception:
        pass
    print("เปิด browser เพื่ออนุญาต Calendar… ถ้าไม่เปิดเอง คัดลอกลิงก์นี้ไปเปิด:\n", flush=True)
    print(url + "\n", flush=True)

    server = http.server.HTTPServer(("localhost", PORT), Handler)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    server.handle_request()  # serve exactly the OAuth redirect

    code = holder.get("code")
    if not code or holder.get("state") != state:
        print("ERROR: ไม่ได้ authorization code หรือ state ไม่ตรง")
        return 1

    r = httpx.post(TOKEN_URL, data={
        "client_id": cid, "client_secret": csec, "code": code,
        "grant_type": "authorization_code", "redirect_uri": REDIRECT_URI,
    }, timeout=30)
    if r.status_code != 200:
        print(f"ERROR token exchange {r.status_code}: {r.text[:300]}")
        return 1

    rt = r.json().get("refresh_token")
    if not rt:
        print("ERROR: ไม่ได้ refresh_token — ถอนสิทธิ์เดิมที่ "
              "https://myaccount.google.com/permissions แล้วรันสคริปต์ใหม่")
        return 1

    _save_refresh_token(rt)
    print("✓ บันทึก GOOGLE_CALENDAR_REFRESH_TOKEN ลง ~/.hermes/.env แล้ว")
    print("  restart gateway → calendar tool พร้อมใช้งาน")
    return 0


if __name__ == "__main__":
    sys.exit(main())
