#!/usr/bin/env python3
"""Classroom reminder — a compact "outstanding work" summary, broadcast to LINE.

Runs as a no_agent cron ``--script`` at 07:00 and 18:00. It builds a plain Thai
summary of the student's unfinished coursework and sends it to **all followers**
of the LINE OA via the Broadcast API (no recipient = everyone who added the OA),
so the whole family sees it — not one DM. stdout stays empty (diagnostics go to
stderr) so the cron ``deliver`` target sends nothing extra.

This is the outstanding-work summary only; brand-new coursework/announcements are
alerted separately (once each) by classroom_sync.py. Status logic mirrors
tools/classroom_tool.py::_derive_status.
"""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx

BKK = timezone(timedelta(hours=7))
DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"
DUE_SOON_DAYS = 7


def _load_env() -> None:
    """Bring ~/.hermes/.env into os.environ (cron runs without it)."""
    try:
        from dotenv import load_dotenv
        load_dotenv(str(Path.home() / ".hermes" / ".env"))
    except Exception:
        env_path = Path.home() / ".hermes" / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def _broadcast(text: str) -> bool:
    """Send `text` to ALL followers of the LINE OA (no recipient = broadcast)."""
    token = (os.getenv("LINE_CHANNEL_ACCESS_TOKEN") or "").strip()
    if not token:
        print("[classroom_reminder] no LINE_CHANNEL_ACCESS_TOKEN — cannot broadcast", file=sys.stderr)
        return False
    msg = text if len(text) <= 4900 else text[:4897] + "…"  # LINE text cap 5000
    try:
        r = httpx.post(
            "https://api.line.me/v2/bot/message/broadcast",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"messages": [{"type": "text", "text": msg}]},
            timeout=15,
        )
    except Exception as e:  # noqa: BLE001
        print(f"[classroom_reminder] broadcast error: {e}", file=sys.stderr)
        return False
    if r.status_code == 200:
        print("[classroom_reminder] broadcast ok", file=sys.stderr)
        return True
    print(f"[classroom_reminder] broadcast failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    return False


def _db_path() -> Path:
    return Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()


_TH_MONTHS = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
              "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."]


def _th_date(due: str | None) -> str:
    """ISO due → short Thai date, e.g. '2026-07-10T16:59:00' → '10 ก.ค.'."""
    if not due:
        return "ไม่มีกำหนดส่ง"
    try:
        d = datetime.fromisoformat(due)
        return f"{d.day} {_TH_MONTHS[d.month]}"
    except Exception:  # noqa: BLE001
        return due[:10]


def build_summary() -> str | None:
    """Return the reminder text, or None if there's nothing to send.

    Grouped BY SUBJECT (course): each วิชา is a header, its outstanding work
    listed underneath. Subjects are ordered by their most-urgent task; a task
    is tagged ⏰ if overdue and 📌 if due within DUE_SOON_DAYS.
    """
    db = _db_path()
    if not db.exists():
        print("[classroom_reminder] no classroom.db yet — skip", file=sys.stderr)
        return None

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    now = datetime.now(BKK)
    now_iso = now.isoformat()
    soon_iso = (now + timedelta(days=DUE_SOON_DAYS)).isoformat()
    greet = "☀️ สรุปงานค้างเช้านี้" if now.hour < 12 else "🌙 สรุปงานค้างเย็นนี้"

    synced = conn.execute(
        "SELECT synced_at FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    synced_at = (synced["synced_at"] if synced else "ไม่ทราบ")[:16].replace("T", " ")

    rows = conn.execute("""
        SELECT cw.title, cw.due_at, c.name AS course,
               sub.state AS sub_state, sub.late
        FROM coursework cw
        LEFT JOIN courses c ON c.id = cw.course_id
        LEFT JOIN submissions sub ON sub.coursework_id = cw.id
        ORDER BY cw.due_at ASC NULLS LAST
    """).fetchall()
    conn.close()

    # Group outstanding coursework by subject (course name).
    # Undated tasks sort last within a subject (sentinel high key).
    NO_DUE = "9999"
    by_course: dict[str, list[dict]] = {}
    total = 0
    for r in rows:
        if r["sub_state"] in ("TURNED_IN", "RETURNED"):
            continue  # already done
        due = r["due_at"]
        overdue = bool(due and due < now_iso)
        course = r["course"] or "ไม่ระบุวิชา"
        by_course.setdefault(course, []).append(
            {"title": r["title"], "due": due, "overdue": overdue, "sort": due or NO_DUE}
        )
        total += 1

    if total == 0:
        return f"{greet}\nไม่มีงานค้างเลย ✅\n(ข้อมูล ณ {synced_at})"

    # Order subjects by their earliest due date (most urgent first).
    ordered = sorted(
        by_course.items(),
        key=lambda kv: min(t["sort"] for t in kv[1]),
    )

    out = [f"{greet} ({total} งาน / {len(by_course)} วิชา)",
           f"ข้อมูล ณ {synced_at}"]
    for course, tasks in ordered:
        tasks.sort(key=lambda t: t["sort"])
        out.append(f"\n📚 {course}")
        for t in tasks:
            due = _th_date(t["due"])
            bullet = "⏰" if t["overdue"] else "•"
            if t["overdue"]:
                due += " (เกินกำหนด)"
            out.append(f"{bullet} {t['title']} · {due}")
    return "\n".join(out)


def main() -> int:
    _load_env()
    msg = build_summary()
    if msg:
        _broadcast(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
