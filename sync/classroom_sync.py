#!/usr/bin/env python3
"""Google Classroom sync — pulls JSON from a Google Apps Script web app
and upserts into ~/.hermes/data/classroom.db (SQLite).

Designed for repeated runs (cron). Idempotent: existing rows are updated,
new rows inserted, deletions in Classroom are NOT removed (we keep history).

Env vars:
    CLASSROOM_GAS_URL   (required)   Web app URL returning the full JSON.
    CLASSROOM_DB_PATH   (optional)   Override DB path. Default: ~/.hermes/data/classroom.db
    CLASSROOM_TZ        (optional)   IANA tz for naive dueDate. Default: Asia/Bangkok
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger("classroom_sync")

DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"
BKK = timezone(timedelta(hours=7))

# Anything older than this is skipped at sync time AND purged from existing
# rows. Override via CLASSROOM_CUTOFF_DATE env (ISO YYYY-MM-DD, BKK local).
DEFAULT_CUTOFF_ISO = "2025-10-01"

SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    section TEXT,
    room TEXT,
    description TEXT,
    owner_id TEXT,
    state TEXT,
    link TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS teachers (
    user_id TEXT,
    course_id TEXT,
    name TEXT,
    email TEXT,
    photo_url TEXT,
    PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS coursework (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    state TEXT,
    work_type TEXT,
    max_points REAL,
    due_at TEXT,
    created_at TEXT,
    updated_at TEXT,
    link TEXT,
    materials_json TEXT
);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    text TEXT,
    state TEXT,
    created_at TEXT,
    updated_at TEXT,
    link TEXT,
    materials_json TEXT
);

CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    title TEXT,
    description TEXT,
    state TEXT,
    created_at TEXT,
    updated_at TEXT,
    link TEXT,
    materials_json TEXT
);

CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    coursework_id TEXT NOT NULL,
    state TEXT,
    late INTEGER,
    assigned_grade REAL,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT NOT NULL,
    courses_count INTEGER,
    coursework_count INTEGER,
    announcements_count INTEGER,
    materials_count INTEGER,
    submissions_count INTEGER,
    status TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_coursework_course   ON coursework(course_id);
CREATE INDEX IF NOT EXISTS idx_coursework_due      ON coursework(due_at);
CREATE INDEX IF NOT EXISTS idx_announce_course     ON announcements(course_id);
CREATE INDEX IF NOT EXISTS idx_material_course     ON materials(course_id);
CREATE INDEX IF NOT EXISTS idx_sub_course          ON submissions(course_id);
CREATE INDEX IF NOT EXISTS idx_sub_coursework      ON submissions(coursework_id);
"""


def open_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def fetch_gas(url: str, timeout: int = 60) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"User-Agent": "hermes-classroom-sync/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def to_bkk_iso(naive_iso: str | None) -> str | None:
    """GAS sends due_at as 'YYYY-MM-DDTHH:MM:SS' (no tz). Treat as Asia/Bangkok."""
    if not naive_iso:
        return None
    try:
        dt = datetime.fromisoformat(naive_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=BKK)
        return dt.isoformat()
    except Exception:
        return naive_iso


def materials_json(items: list | None) -> str | None:
    if not items:
        return None
    return json.dumps(items, ensure_ascii=False)


def upsert_courses(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO courses (id, name, section, room, description, owner_id, state, link, created_at, updated_at)
             VALUES (:id, :name, :section, :room, :description, :owner_id, :state, :link, :created_at, :updated_at)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, section=excluded.section, room=excluded.room,
                description=excluded.description, owner_id=excluded.owner_id,
                state=excluded.state, link=excluded.link, updated_at=excluded.updated_at"""
    payload = [{
        "id": r["id"], "name": r["name"], "section": r.get("section", ""),
        "room": r.get("room", ""), "description": r.get("description", ""),
        "owner_id": r.get("ownerId", ""), "state": r.get("courseState", ""),
        "link": r.get("alternateLink", ""),
        "created_at": r.get("creationTime"), "updated_at": r.get("updateTime"),
    } for r in rows]
    conn.executemany(sql, payload)
    return len(payload)


def upsert_teachers(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO teachers (user_id, course_id, name, email, photo_url)
             VALUES (:user_id, :course_id, :name, :email, :photo_url)
             ON CONFLICT(user_id, course_id) DO UPDATE SET
                name=excluded.name, email=excluded.email, photo_url=excluded.photo_url"""
    payload = []
    for r in rows:
        prof = r.get("profile") or {}
        payload.append({
            "user_id": r.get("userId", ""), "course_id": r.get("courseId", ""),
            "name": prof.get("name", ""), "email": prof.get("email", ""),
            "photo_url": prof.get("photoUrl", ""),
        })
    conn.executemany(sql, payload)
    return len(payload)


def upsert_coursework(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO coursework
             (id, course_id, title, description, state, work_type, max_points, due_at,
              created_at, updated_at, link, materials_json)
             VALUES (:id, :course_id, :title, :description, :state, :work_type, :max_points, :due_at,
                     :created_at, :updated_at, :link, :materials_json)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, description=excluded.description, state=excluded.state,
                work_type=excluded.work_type, max_points=excluded.max_points, due_at=excluded.due_at,
                updated_at=excluded.updated_at, link=excluded.link, materials_json=excluded.materials_json"""
    payload = [{
        "id": r["id"], "course_id": r["courseId"], "title": r["title"],
        "description": r.get("description", ""), "state": r.get("state", ""),
        "work_type": r.get("workType", ""), "max_points": r.get("maxPoints") or 0,
        "due_at": to_bkk_iso(r.get("dueDate")),
        "created_at": r.get("creationTime"), "updated_at": r.get("updateTime"),
        "link": r.get("alternateLink", ""),
        "materials_json": materials_json(r.get("materials")),
    } for r in rows]
    conn.executemany(sql, payload)
    return len(payload)


def upsert_announcements(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO announcements
             (id, course_id, text, state, created_at, updated_at, link, materials_json)
             VALUES (:id, :course_id, :text, :state, :created_at, :updated_at, :link, :materials_json)
             ON CONFLICT(id) DO UPDATE SET
                text=excluded.text, state=excluded.state, updated_at=excluded.updated_at,
                link=excluded.link, materials_json=excluded.materials_json"""
    payload = [{
        "id": r["id"], "course_id": r["courseId"], "text": r.get("text", ""),
        "state": r.get("state", ""), "created_at": r.get("creationTime"),
        "updated_at": r.get("updateTime"), "link": r.get("alternateLink", ""),
        "materials_json": materials_json(r.get("materials")),
    } for r in rows]
    conn.executemany(sql, payload)
    return len(payload)


def upsert_materials(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO materials
             (id, course_id, title, description, state, created_at, updated_at, link, materials_json)
             VALUES (:id, :course_id, :title, :description, :state, :created_at, :updated_at, :link, :materials_json)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, description=excluded.description, state=excluded.state,
                updated_at=excluded.updated_at, link=excluded.link, materials_json=excluded.materials_json"""
    payload = [{
        "id": r["id"], "course_id": r["courseId"], "title": r.get("title", ""),
        "description": r.get("description", ""), "state": r.get("state", ""),
        "created_at": r.get("creationTime"), "updated_at": r.get("updateTime"),
        "link": r.get("alternateLink", ""),
        "materials_json": materials_json(r.get("materials")),
    } for r in rows]
    conn.executemany(sql, payload)
    return len(payload)


def upsert_submissions(conn, rows: list[dict]) -> int:
    sql = """INSERT INTO submissions
             (id, course_id, coursework_id, state, late, assigned_grade, created_at, updated_at)
             VALUES (:id, :course_id, :coursework_id, :state, :late, :assigned_grade, :created_at, :updated_at)
             ON CONFLICT(id) DO UPDATE SET
                state=excluded.state, late=excluded.late, assigned_grade=excluded.assigned_grade,
                updated_at=excluded.updated_at"""
    payload = [{
        "id": r["id"], "course_id": r["courseId"], "coursework_id": r["courseworkId"],
        "state": r.get("state", ""), "late": 1 if r.get("late") else 0,
        "assigned_grade": r.get("assignedGrade"),
        "created_at": r.get("creationTime"), "updated_at": r.get("updateTime"),
    } for r in rows]
    conn.executemany(sql, payload)
    return len(payload)


def write_sync_log(conn, **kwargs) -> None:
    conn.execute("""INSERT INTO sync_log
        (synced_at, courses_count, coursework_count, announcements_count,
         materials_count, submissions_count, status, error)
        VALUES (:synced_at, :courses, :coursework, :announcements, :materials,
                :submissions, :status, :error)""", kwargs)


def _resolve_cutoff() -> str:
    """ISO datetime string (BKK) — items older than this are dropped."""
    cutoff_date = os.getenv("CLASSROOM_CUTOFF_DATE") or DEFAULT_CUTOFF_ISO
    try:
        d = datetime.fromisoformat(cutoff_date)
        if d.tzinfo is None:
            d = d.replace(tzinfo=BKK)
        return d.isoformat()
    except ValueError:
        logger.warning("CLASSROOM_CUTOFF_DATE invalid (%r); falling back to %s",
                       cutoff_date, DEFAULT_CUTOFF_ISO)
        d = datetime.fromisoformat(DEFAULT_CUTOFF_ISO).replace(tzinfo=BKK)
        return d.isoformat()


def _filter_recent(rows: list[dict], cutoff_iso: str, date_keys: tuple[str, ...]) -> list[dict]:
    """Drop rows whose every probed date field is older than cutoff.

    Keeps rows where ANY of ``date_keys`` is >= cutoff, or where every key is
    missing (cautious — better to keep an undated row than silently lose it).
    """
    keep = []
    for r in rows:
        dates = [r.get(k) for k in date_keys if r.get(k)]
        if not dates:
            keep.append(r)
            continue
        # GAS sends naive ISO ("YYYY-MM-DDTHH:MM:SS") or full ISO w/ Z.
        # Compare by lex prefix on the date portion — works for both.
        if any(d >= cutoff_iso[:len(d)] or d[:10] >= cutoff_iso[:10] for d in dates):
            keep.append(r)
    return keep


def _purge_old_rows(conn: sqlite3.Connection, cutoff_iso: str) -> dict[str, int]:
    """Delete pre-cutoff rows already in the DB. One-time cleanup per sync."""
    cur = conn.cursor()
    deleted = {}
    cur.execute("DELETE FROM coursework WHERE due_at IS NOT NULL AND due_at < ?", (cutoff_iso,))
    deleted["coursework"] = cur.rowcount
    cur.execute("DELETE FROM announcements WHERE created_at IS NOT NULL AND created_at < ?", (cutoff_iso,))
    deleted["announcements"] = cur.rowcount
    cur.execute("DELETE FROM materials WHERE created_at IS NOT NULL AND created_at < ?", (cutoff_iso,))
    deleted["materials"] = cur.rowcount
    # Orphan submissions whose coursework no longer exists.
    cur.execute("DELETE FROM submissions WHERE coursework_id NOT IN (SELECT id FROM coursework)")
    deleted["submissions"] = cur.rowcount
    return deleted


def run_sync(gas_url: str, db_path: Path) -> dict[str, Any]:
    conn = open_db(db_path)
    started = time.time()
    counts = {"courses": 0, "coursework": 0, "announcements": 0, "materials": 0, "submissions": 0}
    error_msg = None
    cutoff_iso = _resolve_cutoff()
    try:
        data = fetch_gas(gas_url)
        coursework_rows    = _filter_recent(data.get("coursework", []), cutoff_iso, ("dueDate",))
        announcement_rows  = _filter_recent(data.get("announcements", []), cutoff_iso, ("creationTime", "updateTime"))
        material_rows      = _filter_recent(data.get("materials", []), cutoff_iso, ("creationTime", "updateTime"))
        kept_coursework_ids = {r["id"] for r in coursework_rows}
        submission_rows    = [s for s in data.get("submissions", []) if s.get("courseworkId") in kept_coursework_ids]
        with conn:
            counts["courses"]       = upsert_courses(conn, data.get("courses", []))
            upsert_teachers(conn, data.get("teachers", []))
            counts["coursework"]    = upsert_coursework(conn, coursework_rows)
            counts["announcements"] = upsert_announcements(conn, announcement_rows)
            counts["materials"]     = upsert_materials(conn, material_rows)
            counts["submissions"]   = upsert_submissions(conn, submission_rows)
            purged = _purge_old_rows(conn, cutoff_iso)
            write_sync_log(conn,
                synced_at=datetime.now(BKK).isoformat(),
                status="ok", error=None, **counts)
        counts["purged"] = purged
        counts["cutoff"] = cutoff_iso
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, sqlite3.Error) as exc:
        error_msg = f"{type(exc).__name__}: {exc}"
        logger.error("sync failed: %s", error_msg)
        with conn:
            write_sync_log(conn,
                synced_at=datetime.now(BKK).isoformat(),
                status="error", error=error_msg, **counts)
    finally:
        conn.close()
    elapsed = time.time() - started
    return {"elapsed_sec": round(elapsed, 2), "error": error_msg, **counts}


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    gas_url = os.getenv("CLASSROOM_GAS_URL")
    if not gas_url:
        print("ERROR: set CLASSROOM_GAS_URL env var to the Google Apps Script /exec URL", file=sys.stderr)
        return 2
    db_path = Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()
    result = run_sync(gas_url, db_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not result["error"] else 1


if __name__ == "__main__":
    sys.exit(main())
