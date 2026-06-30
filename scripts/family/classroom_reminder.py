#!/usr/bin/env python3
"""Classroom reminder feed — prints the student's outstanding work as a compact
summary. Used as a cron ``--script``: its stdout is handed to TT^, which turns
it into a warm Thai reminder and delivers it to LINE.

Self-contained (reads ~/.hermes/data/classroom.db directly) so it runs fine from
~/.hermes/scripts/ without the repo on sys.path. Status logic mirrors
tools/classroom_tool.py::_derive_status.

Empty/▢ no outstanding work → prints an "all clear" line (never silent, so the
reminder still fires as a cheerful "nothing due" ping).
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path

BKK = timezone(timedelta(hours=7))
DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"
DUE_SOON_DAYS = 7


def _db_path() -> Path:
    return Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()


def main() -> int:
    db = _db_path()
    if not db.exists():
        print("ยังไม่มีข้อมูล Classroom (ยังไม่ได้ sync)")
        return 0

    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    now = datetime.now(BKK)
    now_iso = now.isoformat()
    soon_iso = (now + timedelta(days=DUE_SOON_DAYS)).isoformat()

    synced = conn.execute(
        "SELECT synced_at FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    synced_at = synced["synced_at"] if synced else "ไม่ทราบ"

    rows = conn.execute("""
        SELECT cw.title, cw.due_at, c.name AS course,
               sub.state AS sub_state, sub.late
        FROM coursework cw
        LEFT JOIN courses c ON c.id = cw.course_id
        LEFT JOIN submissions sub ON sub.coursework_id = cw.id
        ORDER BY cw.due_at ASC NULLS LAST
    """).fetchall()
    conn.close()

    overdue, due_soon, other = [], [], []
    for r in rows:
        st = r["sub_state"]
        if st in ("TURNED_IN", "RETURNED"):
            continue  # already done
        due = r["due_at"]
        label = f"{r['course'] or '-'}: {r['title']}"
        if due and due < now_iso:
            overdue.append((label, due))
        elif due and due <= soon_iso:
            due_soon.append((label, due))
        else:
            other.append((label, due))

    if not (overdue or due_soon or other):
        print(f"ไม่มีงานค้างเลย ✅ (ข้อมูล ณ {synced_at})")
        return 0

    def _fmt(items):
        return "\n".join(
            f"- {lbl}" + (f" (กำหนดส่ง {due[:16].replace('T',' ')})" if due else " (ไม่มีกำหนดส่ง)")
            for lbl, due in items
        )

    out = [f"[งานค้างของนักเรียน — ข้อมูล ณ {synced_at}]"]
    if overdue:
        out.append(f"\n⏰ เลยกำหนดแล้ว ({len(overdue)}):\n" + _fmt(overdue))
    if due_soon:
        out.append(f"\n📌 ใกล้ครบกำหนด (ภายใน {DUE_SOON_DAYS} วัน) ({len(due_soon)}):\n" + _fmt(due_soon))
    if other:
        out.append(f"\n📝 ยังไม่ส่ง (อื่นๆ) ({len(other)}):\n" + _fmt(other))
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
