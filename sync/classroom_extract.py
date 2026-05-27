#!/usr/bin/env python3
"""Extract hidden deadlines from announcements + materials using Gemini.

Teachers often write submission deadlines inside free-text announcements
("ส่งศุกร์นี้นะ") or in a material's description ("ทำใบงานหน้า 15-20 ส่ง
วันจันทร์") rather than as a formal Classroom Assignment. Without this pass,
the agent will miss those work items entirely.

Idempotent + cheap:
  - Hashes raw text → skips re-extraction when content unchanged.
  - Stores extraction result + confidence + verbatim evidence so the agent
    can cite the source and the user can audit.
  - Confidence threshold = 0.6; lower-confidence hits go to a separate
    ``pending_review`` slot (not stamped as a task yet).

Run after classroom_sync.py:
    python sync/classroom_extract.py

Env:
    CLASSROOM_DB_PATH   (optional) Override default DB path.
    GEMINI_API_KEY      (required) Google AI Studio key.
    CLASSROOM_EXTRACT_MODEL  (optional) default gemini-2.5-flash
"""

from __future__ import annotations

import hashlib
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

logger = logging.getLogger("classroom_extract")

BKK = timezone(timedelta(hours=7))
DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"
DEFAULT_MODEL = "gemini-2.5-flash"
CONFIDENCE_THRESHOLD = 0.6
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

EXTRA_SCHEMA = """
CREATE TABLE IF NOT EXISTS derived_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    course_id TEXT,
    title TEXT NOT NULL,
    due_at TEXT,
    confidence REAL NOT NULL,
    evidence TEXT,
    extracted_at TEXT NOT NULL,
    source_link TEXT,
    dismissed INTEGER DEFAULT 0,
    UNIQUE(source_type, source_id, title)
);

CREATE TABLE IF NOT EXISTS extraction_cache (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    extracted_at TEXT NOT NULL,
    has_deadline INTEGER NOT NULL,
    items_count INTEGER NOT NULL,
    PRIMARY KEY (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS pending_review (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    course_id TEXT,
    suggested_title TEXT,
    suggested_due_at TEXT,
    confidence REAL,
    evidence TEXT,
    raw_text TEXT,
    extracted_at TEXT NOT NULL,
    UNIQUE(source_type, source_id, suggested_title)
);

CREATE INDEX IF NOT EXISTS idx_derived_course ON derived_tasks(course_id);
CREATE INDEX IF NOT EXISTS idx_derived_due ON derived_tasks(due_at);
"""


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

EXTRACT_PROMPT = """คุณคือผู้ช่วยสกัดกำหนดส่งงานจากประกาศหรือเอกสารของครู (ภาษาไทย/อังกฤษ)

ข้อมูล:
- วันที่โพสต์: {posted_at}
- วันที่ปัจจุบัน: {today}
- วิชา: {course_name}
- ประเภท: {source_type}

ข้อความ:
\"\"\"
{text}
\"\"\"

หน้าที่: ระบุว่ามีกำหนดส่งงานใดบ้างในข้อความนี้

กฎ:
1. แปลงคำสัมพัทธ์ ("พรุ่งนี้", "ศุกร์นี้", "ภายในสัปดาห์นี้") โดยอ้างอิงจาก **วันที่โพสต์** ไม่ใช่วันนี้
2. ไม่นับ: แจ้งครูมาสาย, ขอเลื่อนสอน, แจ้งวันหยุด, ประกาศคะแนน, ขอบคุณ
3. นับ: ส่งงาน/ทำใบงาน/อัปโหลด/ส่งคลิป/ส่งภาพถ่าย/ส่งภายในวันที่...
4. ถ้ามีงานหลายชิ้นในประกาศเดียว แยกเป็นหลาย items
5. confidence:
   - 1.0 = ระบุวันที่ชัด + เวลา (เช่น "ส่งศุกร์ 30 พ.ค. 23:59")
   - 0.8 = ระบุวันที่ชัด ไม่มีเวลา
   - 0.6 = วันที่สัมพัทธ์ที่แปลงได้แน่ใจ ("ศุกร์นี้")
   - 0.4 = กำกวม ("เร็วๆ นี้", "ภายในเทอม")
   - 0.2 = อาจไม่ใช่ deadline

คืน JSON เท่านั้น (ไม่มี markdown fence, ไม่มีคำอธิบายเพิ่ม):
{{
  "has_deadline": true | false,
  "items": [
    {{
      "title": "ชื่องานสั้นๆ ภาษาไทย",
      "due_at": "YYYY-MM-DDTHH:MM:SS+07:00" หรือ null,
      "confidence": 0.0-1.0,
      "evidence": "ข้อความต้นฉบับที่ใช้ตัดสิน"
    }}
  ]
}}"""


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def open_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.executescript(EXTRA_SCHEMA)
    return conn


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def already_extracted(conn, source_type: str, source_id: str, hash_: str) -> bool:
    row = conn.execute(
        "SELECT content_hash FROM extraction_cache WHERE source_type=? AND source_id=?",
        (source_type, source_id),
    ).fetchone()
    return bool(row and row["content_hash"] == hash_)


def write_cache(conn, source_type: str, source_id: str, hash_: str,
                has_deadline: bool, items_count: int) -> None:
    conn.execute("""
        INSERT INTO extraction_cache
            (source_type, source_id, content_hash, extracted_at, has_deadline, items_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id) DO UPDATE SET
            content_hash=excluded.content_hash,
            extracted_at=excluded.extracted_at,
            has_deadline=excluded.has_deadline,
            items_count=excluded.items_count
    """, (source_type, source_id, hash_, datetime.now(BKK).isoformat(),
          1 if has_deadline else 0, items_count))


def insert_derived(conn, *, source_type: str, source_id: str, course_id: str,
                   title: str, due_at: str | None, confidence: float,
                   evidence: str | None, source_link: str | None) -> None:
    conn.execute("""
        INSERT INTO derived_tasks
            (source_type, source_id, course_id, title, due_at, confidence,
             evidence, extracted_at, source_link)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, title) DO UPDATE SET
            due_at=excluded.due_at,
            confidence=excluded.confidence,
            evidence=excluded.evidence,
            extracted_at=excluded.extracted_at,
            source_link=excluded.source_link
    """, (source_type, source_id, course_id, title, due_at, confidence,
          evidence, datetime.now(BKK).isoformat(), source_link))


def insert_pending(conn, *, source_type: str, source_id: str, course_id: str,
                   title: str, due_at: str | None, confidence: float,
                   evidence: str | None, raw_text: str) -> None:
    conn.execute("""
        INSERT INTO pending_review
            (source_type, source_id, course_id, suggested_title, suggested_due_at,
             confidence, evidence, raw_text, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_type, source_id, suggested_title) DO UPDATE SET
            suggested_due_at=excluded.suggested_due_at,
            confidence=excluded.confidence,
            evidence=excluded.evidence,
            raw_text=excluded.raw_text,
            extracted_at=excluded.extracted_at
    """, (source_type, source_id, course_id, title, due_at, confidence,
          evidence, raw_text, datetime.now(BKK).isoformat()))


def purge_stale_derived(conn, source_type: str, source_id: str) -> None:
    """Wipe old derived rows for this source before re-inserting (handles edits)."""
    conn.execute("DELETE FROM derived_tasks WHERE source_type=? AND source_id=?",
                 (source_type, source_id))
    conn.execute("DELETE FROM pending_review WHERE source_type=? AND source_id=?",
                 (source_type, source_id))


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------

def call_gemini(prompt: str, model: str, api_key: str, timeout: int = 30) -> str:
    url = GEMINI_URL.format(model=model, key=api_key)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.0,
            "maxOutputTokens": 1024,
            "responseMimeType": "application/json",
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini empty candidates: {payload}")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"Gemini empty text: {payload}")
    return text


def parse_extraction(raw: str) -> dict[str, Any]:
    """Tolerate stray ```json fences if the model adds them."""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        if s.startswith("json"):
            s = s[4:].strip()
        if s.endswith("```"):
            s = s[:-3]
        s = s.strip()
    return json.loads(s)


# ---------------------------------------------------------------------------
# Source extraction
# ---------------------------------------------------------------------------

def extract_one(conn, *, source_type: str, source_id: str, course_id: str,
                course_name: str, posted_at: str, text: str, link: str | None,
                model: str, api_key: str) -> dict[str, Any]:
    """Run extraction on a single announcement/material. Returns summary dict."""
    if not text or not text.strip():
        return {"skipped": "empty"}

    hash_ = content_hash(text)
    if already_extracted(conn, source_type, source_id, hash_):
        return {"skipped": "cached"}

    today = datetime.now(BKK).strftime("%Y-%m-%d")
    prompt = EXTRACT_PROMPT.format(
        posted_at=(posted_at or "")[:10] or "unknown",
        today=today,
        course_name=course_name or "ไม่ทราบ",
        source_type=source_type,
        text=text[:4000],   # safety cap
    )

    try:
        raw = call_gemini(prompt, model, api_key)
        result = parse_extraction(raw)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError,
            json.JSONDecodeError) as exc:
        logger.warning("extract failed %s/%s: %s", source_type, source_id, exc)
        return {"error": str(exc)[:200]}

    has_deadline = bool(result.get("has_deadline"))
    items = result.get("items") or [] if has_deadline else []

    purge_stale_derived(conn, source_type, source_id)

    derived_n = 0
    pending_n = 0
    for item in items:
        title = (item.get("title") or "").strip()
        due_at = item.get("due_at")
        conf = float(item.get("confidence") or 0.0)
        evidence = item.get("evidence")
        if not title:
            continue
        if conf >= CONFIDENCE_THRESHOLD:
            insert_derived(
                conn, source_type=source_type, source_id=source_id,
                course_id=course_id, title=title, due_at=due_at,
                confidence=conf, evidence=evidence, source_link=link,
            )
            derived_n += 1
        else:
            insert_pending(
                conn, source_type=source_type, source_id=source_id,
                course_id=course_id, title=title, due_at=due_at,
                confidence=conf, evidence=evidence, raw_text=text[:1000],
            )
            pending_n += 1

    write_cache(conn, source_type, source_id, hash_, has_deadline, derived_n + pending_n)
    return {"derived": derived_n, "pending": pending_n,
            "has_deadline": has_deadline}


def run_extraction(db_path: Path, model: str, api_key: str,
                   max_calls: int | None = None) -> dict[str, Any]:
    conn = open_db(db_path)
    started = time.time()
    stats = {"scanned": 0, "extracted": 0, "cached": 0, "errors": 0,
             "derived_total": 0, "pending_total": 0}
    try:
        sources: list[tuple[str, str, str, str, str, str, str | None]] = []

        # Announcements
        for r in conn.execute("""
            SELECT a.id, a.course_id, a.text, a.created_at, a.link, c.name AS course_name
            FROM announcements a
            LEFT JOIN courses c ON c.id = a.course_id
            WHERE a.text IS NOT NULL AND TRIM(a.text) != ''
        """).fetchall():
            sources.append(("announcement", r["id"], r["course_id"] or "",
                           r["course_name"] or "", r["created_at"] or "",
                           r["text"], r["link"]))

        # Materials (description is the freeform field)
        for r in conn.execute("""
            SELECT m.id, m.course_id, m.title, m.description, m.created_at, m.link, c.name AS course_name
            FROM materials m
            LEFT JOIN courses c ON c.id = m.course_id
            WHERE m.description IS NOT NULL AND TRIM(m.description) != ''
        """).fetchall():
            combined = f"[หัวข้อ: {r['title'] or ''}]\n{r['description']}"
            sources.append(("material", r["id"], r["course_id"] or "",
                           r["course_name"] or "", r["created_at"] or "",
                           combined, r["link"]))

        for source_type, sid, cid, cname, posted, text, link in sources:
            if max_calls is not None and stats["extracted"] >= max_calls:
                break
            stats["scanned"] += 1
            with conn:
                result = extract_one(
                    conn, source_type=source_type, source_id=sid,
                    course_id=cid, course_name=cname, posted_at=posted,
                    text=text, link=link, model=model, api_key=api_key,
                )
            if "skipped" in result:
                stats["cached"] += 1
            elif "error" in result:
                stats["errors"] += 1
            else:
                stats["extracted"] += 1
                stats["derived_total"] += result["derived"]
                stats["pending_total"] += result["pending"]
    finally:
        conn.close()

    stats["elapsed_sec"] = round(time.time() - started, 2)
    return stats


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("ERROR: GEMINI_API_KEY required", file=sys.stderr)
        return 2
    model = os.getenv("CLASSROOM_EXTRACT_MODEL") or DEFAULT_MODEL
    db_path = Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()
    max_calls = os.getenv("CLASSROOM_EXTRACT_MAX")
    stats = run_extraction(db_path, model, api_key,
                           max_calls=int(max_calls) if max_calls else None)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0 if stats["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
