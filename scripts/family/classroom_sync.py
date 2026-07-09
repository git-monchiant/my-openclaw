#!/usr/bin/env python3
"""Classroom sync — fetch one student's Google Classroom data via their
Apps Script web app and write the local mirror that ``tools/classroom_tool.py``
reads (``~/.hermes/data/classroom.db``).

Source: the student deploys an Apps Script web app under their OWN Google
account (so it can read their own Classroom) and returns JSON with keys
``courses, teachers, coursework, announcements, materials, submissions`` —
the raw Google Classroom API shapes, except ``coursework[].dueDate`` is
already a merged ISO string (e.g. "2026-02-17T16:59:00").

Config (read from env, else ~/.hermes/.env):
    CLASSROOM_SCRIPT_URL     Apps Script web-app URL (required)
    CLASSROOM_STUDENT_EMAIL  student email (for logging only)
    CLASSROOM_DB_PATH        mirror path (default ~/.hermes/data/classroom.db)

Run:  python scripts/family/classroom_sync.py
Exit: 0 on success, 1 on failure (a sync_log row is written either way).
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx

BKK = timezone(timedelta(hours=7))
DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"


def _now_iso() -> str:
    return datetime.now(BKK).isoformat()


def _load_env() -> None:
    """Bring ~/.hermes/.env into os.environ (cron runs without it)."""
    try:
        from dotenv import load_dotenv
        load_dotenv(str(Path.home() / ".hermes" / ".env"))
    except Exception:
        # Manual fallback parse if python-dotenv is unavailable.
        env_path = Path.home() / ".hermes" / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def _broadcast(text: str) -> bool:
    """Send `text` to ALL followers of the LINE OA (no recipient = broadcast).

    Bypasses the cron ``deliver`` target entirely so the alert reaches every
    family member who added the OA, not just LINE_HOME_CHANNEL.
    """
    token = (os.getenv("LINE_CHANNEL_ACCESS_TOKEN") or "").strip()
    if not token:
        print("[classroom_sync] no LINE_CHANNEL_ACCESS_TOKEN — cannot broadcast", file=sys.stderr)
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
        print(f"[classroom_sync] broadcast error: {e}", file=sys.stderr)
        return False
    if r.status_code == 200:
        print("[classroom_sync] broadcast ok", file=sys.stderr)
        return True
    print(f"[classroom_sync] broadcast failed {r.status_code}: {r.text[:200]}", file=sys.stderr)
    return False


def _db_path() -> Path:
    return Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()


SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY, name TEXT, section TEXT, room TEXT
);
CREATE TABLE IF NOT EXISTS coursework (
    id TEXT PRIMARY KEY, course_id TEXT, title TEXT, description TEXT,
    due_at TEXT, link TEXT, max_points REAL, work_type TEXT, materials_json TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
    coursework_id TEXT PRIMARY KEY, state TEXT, late INTEGER,
    assigned_grade REAL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS teachers (
    user_id TEXT, name TEXT, email TEXT, course_id TEXT, is_intern INTEGER,
    PRIMARY KEY (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY, course_id TEXT, text TEXT, created_at TEXT, link TEXT
);
CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY, course_id TEXT, title TEXT, description TEXT,
    created_at TEXT, link TEXT, materials_json TEXT
);
CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, synced_at TEXT, status TEXT, note TEXT
);
-- Optional AI-derived deadlines (from announcements). Left empty by this sync;
-- created so classroom_tool's list_tasks query never hits a missing table.
CREATE TABLE IF NOT EXISTS derived_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, due_at TEXT,
    source_link TEXT, confidence REAL, evidence TEXT, source_type TEXT,
    course_id TEXT, dismissed INTEGER DEFAULT 0
);
-- "Have we already alerted the family about this coursework/announcement?"
-- Persists across the full-refresh DELETE so new-item push notifications fire
-- exactly once. NOT wiped by write_mirror's clear-then-reload.
CREATE TABLE IF NOT EXISTS seen_items (
    source_type TEXT, source_id TEXT, first_seen TEXT,
    PRIMARY KEY (source_type, source_id)
);
"""


def fetch(script_url: str) -> dict:
    with httpx.Client(timeout=httpx.Timeout(90, connect=10), follow_redirects=True) as c:
        r = c.get(script_url)
        r.raise_for_status()
        data = r.json()
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(f"Apps Script error: {data['error']}")
    return data


def _is_intern(name: str | None) -> int:
    return 1 if (name or "").strip().upper().startswith("NISIT") else 0


def _keep_since(item: dict, since: str, *date_fields: str) -> bool:
    """Keep ``item`` if any of ``date_fields`` (ISO strings) is on/after
    ``since`` (YYYY-MM-DD). Items with no usable date are kept (we don't
    silently drop undated rows)."""
    dates = [(item.get(f) or "")[:10] for f in date_fields]
    dates = [d for d in dates if d]
    if not dates:
        return True
    return any(d >= since for d in dates)


def write_mirror(conn: sqlite3.Connection, data: dict, since: str) -> dict[str, int]:
    cur = conn.cursor()
    cur.executescript(SCHEMA)

    courses = data.get("courses") or []
    coursework = data.get("coursework") or []
    submissions = data.get("submissions") or []
    teachers = data.get("teachers") or []
    announcements = data.get("announcements") or []
    materials = data.get("materials") or []

    # Date cutoff — drop previous-term/year items. Coursework kept if it was
    # assigned OR due on/after the cutoff; submissions follow their coursework.
    coursework = [w for w in coursework if _keep_since(w, since, "dueDate", "creationTime")]
    kept_ids = {w.get("id") for w in coursework}
    submissions = [s for s in submissions if s.get("courseworkId") in kept_ids]
    announcements = [a for a in announcements if _keep_since(a, since, "creationTime")]
    materials = [m for m in materials if _keep_since(m, since, "creationTime")]

    # Drop previous-year courses/teachers too: keep only courses that have any
    # current-term activity (coursework / announcement / material), and the
    # teachers attached to those courses.
    active = coursework + announcements + materials
    kept_course_ids = {x.get("courseId") for x in active if x.get("courseId")}
    courses = [c for c in courses if c.get("id") in kept_course_ids]
    teachers = [t for t in teachers if t.get("courseId") in kept_course_ids]

    # Full refresh (single student) — clear then reload.
    for t in ("courses", "coursework", "submissions", "teachers",
              "announcements", "materials"):
        cur.execute(f"DELETE FROM {t}")

    cur.executemany(
        "INSERT OR REPLACE INTO courses (id,name,section,room) VALUES (?,?,?,?)",
        [(c.get("id"), c.get("name"), c.get("section"), c.get("room")) for c in courses],
    )
    cur.executemany(
        "INSERT OR REPLACE INTO coursework "
        "(id,course_id,title,description,due_at,link,max_points,work_type,materials_json) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        [(
            w.get("id"), w.get("courseId"), w.get("title"), w.get("description"),
            w.get("dueDate"), w.get("alternateLink"), w.get("maxPoints"),
            w.get("workType"),
            json.dumps(w.get("materials"), ensure_ascii=False) if w.get("materials") else None,
        ) for w in coursework],
    )
    cur.executemany(
        "INSERT OR REPLACE INTO submissions "
        "(coursework_id,state,late,assigned_grade,updated_at) VALUES (?,?,?,?,?)",
        [(
            s.get("courseworkId"), s.get("state"),
            1 if s.get("late") else 0,
            s.get("assignedGrade"), s.get("updateTime"),
        ) for s in submissions],
    )
    cur.executemany(
        "INSERT OR REPLACE INTO teachers "
        "(user_id,name,email,course_id,is_intern) VALUES (?,?,?,?,?)",
        [(
            (t.get("profile") or {}).get("id") or t.get("userId"),
            (t.get("profile") or {}).get("name"),
            (t.get("profile") or {}).get("email"),
            t.get("courseId"),
            _is_intern((t.get("profile") or {}).get("name")),
        ) for t in teachers],
    )
    cur.executemany(
        "INSERT OR REPLACE INTO announcements "
        "(id,course_id,text,created_at,link) VALUES (?,?,?,?,?)",
        [(
            a.get("id"), a.get("courseId"), a.get("text"),
            a.get("creationTime"), a.get("alternateLink"),
        ) for a in announcements],
    )
    cur.executemany(
        "INSERT OR REPLACE INTO materials "
        "(id,course_id,title,description,created_at,link,materials_json) "
        "VALUES (?,?,?,?,?,?,?)",
        [(
            m.get("id"), m.get("courseId"), m.get("title"), m.get("description"),
            m.get("creationTime"), m.get("alternateLink"),
            json.dumps(m.get("materials"), ensure_ascii=False) if m.get("materials") else None,
        ) for m in materials],
    )
    return {
        "courses": len(courses), "coursework": len(coursework),
        "submissions": len(submissions), "teachers": len(teachers),
        "announcements": len(announcements), "materials": len(materials),
    }


def _fmt_due(due: str | None) -> str:
    due = (due or "").strip()
    if not due:
        return "-"
    return due.replace("T", " ")[:16]


def _clip(s: str | None, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def detect_and_notify(conn: sqlite3.Connection, data: dict, since: str) -> None:
    """Push a LINE alert (via STDOUT — this is a no_agent cron job) the moment a
    NEW coursement/announcement appears. Each id is alerted exactly once.

    First run (empty seen_items) seeds silently so we don't dump the whole term.
    Prints nothing when there's nothing new → cron delivers nothing.
    """
    courses = {c.get("id"): (c.get("name") or "") for c in (data.get("courses") or [])}

    # Teacher lookup: prefer the item's creator, else fall back to the course's
    # teacher(s). Teachers come as {courseId, userId, profile:{id,name,email}}.
    teachers = data.get("teachers") or []
    def _tname(t: dict) -> str:
        return ((t.get("profile") or {}).get("name") or "").strip()
    def _tid(t: dict):
        return (t.get("profile") or {}).get("id") or t.get("userId")
    teacher_by_uid = {_tid(t): _tname(t) for t in teachers if _tid(t) and _tname(t)}
    teacher_by_course: dict = {}
    for t in teachers:
        nm = _tname(t)
        if nm:
            teacher_by_course.setdefault(t.get("courseId"), [])
            if nm not in teacher_by_course[t.get("courseId")]:
                teacher_by_course[t.get("courseId")].append(nm)

    def _teacher(item: dict) -> str:
        nm = teacher_by_uid.get(item.get("creatorUserId"))
        if nm:
            return nm
        names = teacher_by_course.get(item.get("courseId")) or []
        return ", ".join(names) if names else "-"

    cw = [w for w in (data.get("coursework") or []) if _keep_since(w, since, "dueDate", "creationTime")]
    ann = [a for a in (data.get("announcements") or []) if _keep_since(a, since, "creationTime")]

    items = []  # (type, id, raw)
    items += [("coursework", w.get("id"), w) for w in cw if w.get("id")]
    items += [("announcement", a.get("id"), a) for a in ann if a.get("id")]

    seen = {(r[0], r[1]) for r in conn.execute("SELECT source_type, source_id FROM seen_items")}
    first_run = not seen
    new = [it for it in items if (it[0], it[1]) not in seen]

    # Record everything as seen now (so the same id never re-alerts).
    conn.executemany(
        "INSERT OR IGNORE INTO seen_items (source_type, source_id, first_seen) VALUES (?,?,?)",
        [(it[0], it[1], _now_iso()) for it in items])
    conn.commit()

    if first_run or not new:
        return  # silent — no stdout, cron delivers nothing

    blocks = []
    for typ, _id, raw in new[:12]:
        course = courses.get(raw.get("courseId")) or "-"
        teacher = _teacher(raw)
        link = (raw.get("alternateLink") or "").strip() or "-"
        if typ == "coursework":
            blocks.append(
                "📌 แจ้งงานใหม่\n"
                f"📚 วิชา : {course}\n"
                f"📝 หัวข้อ : {_clip(raw.get('title') or '(ไม่มีชื่อ)', 200)}\n"
                f"📄 รายละเอียด : {_clip(raw.get('description'), 600) or '-'}\n"
                f"⏰ กำหนดส่ง : {_fmt_due(raw.get('dueDate'))}\n"
                f"👩‍🏫 อาจารย์ : {teacher}\n"
                f"🔗 เปิดใบงาน : {link}"
            )
        else:
            text = (raw.get("text") or "").strip()
            blocks.append(
                "📢 ประกาศใหม่\n"
                f"📚 วิชา : {course}\n"
                f"📝 หัวข้อ : {_clip(text.split(chr(10))[0], 120) or '(ประกาศ)'}\n"
                f"📄 รายละเอียด : {_clip(text, 600) or '-'}\n"
                f"👩‍🏫 อาจารย์ : {teacher}\n"
                f"🔗 เปิดดู : {link}"
            )
    out = "\n\n────────\n\n".join(blocks)
    if len(new) > 12:
        out += f"\n\n…และอีก {len(new) - 12} รายการ"
    _broadcast(out)  # → LINE Broadcast API (all followers). stdout stays empty.


def main() -> int:
    _load_env()
    script_url = (os.getenv("CLASSROOM_SCRIPT_URL") or "").strip()
    email = (os.getenv("CLASSROOM_STUDENT_EMAIL") or "").strip()
    since = (os.getenv("CLASSROOM_SINCE") or "2026-05-01").strip()
    db_path = _db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.executescript(SCHEMA)  # all tables (incl. sync_log) exist up front
    try:
        if not script_url:
            raise RuntimeError("CLASSROOM_SCRIPT_URL not set (in env or ~/.hermes/.env)")

        data = fetch(script_url)
        counts = write_mirror(conn, data, since)
        note = f"since={since}, " + ", ".join(f"{k}={v}" for k, v in counts.items())
        conn.execute(
            "INSERT INTO sync_log (synced_at,status,note) VALUES (?,?,?)",
            (_now_iso(), "ok", note),
        )
        conn.commit()
        print(f"[classroom_sync] OK {email or ''} → {db_path}", file=sys.stderr)
        print(f"[classroom_sync] {note}", file=sys.stderr)
        # New-item push: prints to STDOUT only when something new appeared.
        try:
            detect_and_notify(conn, data, since)
        except Exception as e:  # never let the alert break the sync
            print(f"[classroom_sync] notify failed: {e}", file=sys.stderr)
        return 0
    except Exception as e:  # noqa: BLE001
        try:
            conn.execute(
                "INSERT INTO sync_log (synced_at,status,note) VALUES (?,?,?)",
                (_now_iso(), "error", str(e)[:500]),
            )
            conn.commit()
        except Exception:
            pass
        print(f"[classroom_sync] FAILED: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
