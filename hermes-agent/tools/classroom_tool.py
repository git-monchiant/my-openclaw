#!/usr/bin/env python3
"""Classroom tool — query the local Google Classroom mirror.

Backed by ~/.hermes/data/classroom.db (populated by sync/classroom_sync.py).

Three actions:
  - list_tasks   List assignments matching filters; titles_only by default.
  - summary      Aggregate counts by status / subject / week.
  - task_detail  Full description + materials + status for one task.

Design intent:
  - LLM never writes SQL. Each action is a narrow, deterministic function.
  - Fuzzy subject matching is in the tool, not in the agent's head — pass any
    Thai substring and we'll search across course names and task titles.
  - Status is computed by joining coursework + submissions, never inferred.
  - Returns include a ``data_synced_at`` timestamp so the agent can disclose
    staleness when answering.
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

BKK = timezone(timedelta(hours=7))
DEFAULT_DB_PATH = Path.home() / ".hermes" / "data" / "classroom.db"

# Subject master — ONE entry per actual Classroom course this student is
# enrolled in. Rebuilt from the live ``courses`` table; do NOT add subjects
# the school doesn't actually teach (no speculative MoE catalog entries).
#
# Each entry maps one real course name (matched as a substring, lowercase)
# to:
#   - label:   short display string ("Eng", "พละ")
#   - synonyms: alternate ways the user might refer to it (Thai + English)
#
# Used in two places:
#   _abbreviate_course(name) → label   (display)
#   _expand_subject(keyword) → list of substrings to LIKE-match (search)
#
# When a new course appears in Classroom, append it here.
_SUBJECTS: list[dict[str, Any]] = [
    {  # 1/543/2568ดนตรีไทย
        "match":    "ดนตรีไทย",
        "label":    "ดนตรีไทย",
        "synonyms": ["ดนตรีไทย", "ดนตรี", "Thai Music", "Music"],
    },
    {  # คณิตฯเพิ่มเติม_68
        "match":    "คณิตฯเพิ่มเติม",
        "label":    "คณิตเพิ่ม",
        "synonyms": ["คณิตเพิ่มเติม", "คณิตฯเพิ่มเติม", "คณิตเพิ่ม",
                     "Math Advanced", "Advanced Math"],
    },
    {  # M1/543 (English 2025)
        "match":    "english",
        "label":    "Eng",
        "synonyms": ["English", "Eng", "ภาษาอังกฤษ", "อังกฤษ", "English Language"],
    },
    {  # 68วิทย์1(ผศ.ดร.คณาภรณ์)
        "match":    "วิทย์",
        "label":    "วิทย์",
        "synonyms": ["วิทย์", "วิทยาศาสตร์", "Science",
                     "ฟิสิกส์", "เคมี", "ชีวะ", "ชีววิทยา"],
    },
    {  # ประวัติศาสตร์ 1/543 - 2568
        "match":    "ประวัติศาสตร์",
        "label":    "ประวัติฯ",
        "synonyms": ["ประวัติ", "ประวัติศาสตร์", "History"],
    },
    {  # พลศึกษา ม.1 (พ21103)
        "match":    "พลศึกษา",
        "label":    "พละ",
        "synonyms": ["พละ", "พลศึกษา", "PE", "Physical Education"],
    },
    {  # ม.1 543 ทัศนศิลป์
        "match":    "ทัศนศิลป์",
        "label":    "ศิลปะ",
        "synonyms": ["ศิลปะ", "ทัศนศิลป์", "วาดเขียน", "Art", "Visual Arts"],
    },
    {  # การงานอาชีพ (งานประดิษฐ์ ) ม.1
        "match":    "งานประดิษฐ์",
        "label":    "งานประดิษฐ์",
        "synonyms": ["งานประดิษฐ์", "ประดิษฐ์", "Crafts", "Handicraft"],
    },
    {  # 543 ( 26-50) การงานอาชีพ1 — section "งานบ้าน ม.1"
        "match":    "การงานอาชีพ1",
        "label":    "การงาน",
        "synonyms": ["การงาน", "การงานอาชีพ", "งานบ้าน", "Home Economics", "Career"],
    },
    {  # ม.1ห้อง543/68 — section "ฝึกฝนการเขียนทั่วไป"
        "match":    "ม.1ห้อง543",
        "label":    "ฝึกเขียน",
        "synonyms": ["ฝึกเขียน", "ฝึกฝนการเขียน", "การเขียน", "Writing"],
    },
    {  # ภาษาไทยพื้นฐาน ม.1/543
        "match":    "ภาษาไทย",
        "label":    "ไทย",
        "synonyms": ["ไทย", "ภาษาไทย", "Thai", "Thai Language"],
    },
]


def _subject_for(name: str | None) -> dict[str, Any] | None:
    """Find which master entry a course name maps to (substring match on
    the entry's ``match`` field, case-insensitive)."""
    if not name:
        return None
    lname = name.lower()
    for sub in _SUBJECTS:
        if sub["match"].lower() in lname:
            return sub
    return None


def _abbreviate_course(name: str | None) -> str:
    """Short display label for a Classroom course name."""
    if not name:
        return ""
    sub = _subject_for(name)
    if sub:
        return sub["label"]
    return name[:12]


def _expand_subject(keyword: str) -> list[str]:
    """Resolve a user keyword to the actual course-name substrings to search.

    Synonyms are used to FIND the matching subject(s), but the SQL search uses
    only each matched subject's canonical ``match`` field — which is specific
    enough to hit only that course. Without this, broad synonyms like "ไทย"
    would pull in both "ภาษาไทย" and "ดนตรีไทย" via plain LIKE.

    Falls back to the raw keyword if no subject matches (so titles/free-text
    searches still work).
    """
    k = keyword.strip().lower()
    if not k:
        return []
    matched_patterns: list[str] = []
    for sub in _SUBJECTS:
        if any(syn.lower() in k or k in syn.lower() for syn in sub["synonyms"]):
            matched_patterns.append(sub["match"].lower())
    if matched_patterns:
        seen, deduped = set(), []
        for p in matched_patterns:
            if p not in seen:
                seen.add(p)
                deduped.append(p)
        return deduped
    return [k]


def _normalize_teacher_name(name: str | None) -> str:
    """Strip ``NISIT-`` prefix and prepend "นิสิต " in Thai so the agent
    doesn't have to know about the source convention.

    "NISIT-IRINLADA SRIARGARDKRAISANG" → "นิสิต Irinlada Sriargardkraisang"
    "Aaron Bendorf Neugeboren" → "Aaron Bendorf Neugeboren"
    """
    if not name:
        return ""
    n = name.strip()
    if n.upper().startswith("NISIT-"):
        rest = n[6:].strip()
        # Title-case the all-caps original so it reads as a name rather than a tag.
        return "นิสิต " + " ".join(p.capitalize() for p in rest.split())
    return n


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------

def _db_path() -> Path:
    return Path(os.getenv("CLASSROOM_DB_PATH") or DEFAULT_DB_PATH).expanduser()


def _open() -> sqlite3.Connection | None:
    p = _db_path()
    if not p.exists():
        return None
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    return conn


def _last_synced(conn: sqlite3.Connection) -> str | None:
    row = conn.execute(
        "SELECT synced_at FROM sync_log WHERE status='ok' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return row["synced_at"] if row else None


# ---------------------------------------------------------------------------
# Status derivation (single source of truth)
# ---------------------------------------------------------------------------

def _derive_status(sub_state: str | None, late: int | None, due_at_iso: str | None,
                   now_iso: str) -> str:
    """Map (submission_state, late, due_at) → human-friendly status."""
    if sub_state == "TURNED_IN":
        return "late_submitted" if late else "submitted"
    if sub_state == "RETURNED":
        return "returned"
    # No submission yet, or RECLAIMED_BY_STUDENT, NEW, CREATED
    if due_at_iso and due_at_iso < now_iso:
        return "overdue"
    return "pending"


def _now_iso() -> str:
    return datetime.now(BKK).isoformat()


# ---------------------------------------------------------------------------
# list_tasks
# ---------------------------------------------------------------------------

def _period_bounds(period: str | None) -> tuple[str | None, str | None]:
    """Return (start_iso, end_iso) for the named period, both in Asia/Bangkok."""
    if not period:
        return (None, None)
    now = datetime.now(BKK)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "today":
        return (today.isoformat(), (today + timedelta(days=1)).isoformat())
    if period == "tomorrow":
        return ((today + timedelta(days=1)).isoformat(),
                (today + timedelta(days=2)).isoformat())
    if period == "this_week":
        # Mon-Sun in Asia/Bangkok
        start = today - timedelta(days=today.weekday())
        return (start.isoformat(), (start + timedelta(days=7)).isoformat())
    if period == "next_week":
        start = today - timedelta(days=today.weekday()) + timedelta(days=7)
        return (start.isoformat(), (start + timedelta(days=7)).isoformat())
    if period == "this_month":
        start = today.replace(day=1)
        if start.month == 12:
            end = start.replace(year=start.year + 1, month=1)
        else:
            end = start.replace(month=start.month + 1)
        return (start.isoformat(), end.isoformat())
    return (None, None)


def list_tasks(query: str | None = None, status: str | None = None,
               period: str | None = None, titles_only: bool = True,
               limit: int = 30, offset: int = 0,
               due_from: str | None = None, due_to: str | None = None,
               include_derived: bool = True) -> dict[str, Any]:
    """Query coursework with optional fuzzy match + filters.

    Args:
        query: Free-text substring matched against course name and task title.
        status: submitted | late_submitted | pending | overdue | returned | all
        period: today | tomorrow | this_week | next_week | this_month | all
        due_from / due_to: ISO date (YYYY-MM-DD) range, inclusive of from,
            exclusive of to. Use this for specific months/quarters when
            ``period`` isn't expressive enough (e.g. January, last term).
            Both are treated as Asia/Bangkok day boundaries.
        titles_only: Drop description from rows (saves tokens). Default True.
        limit / offset: Pagination.
    """
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี — รัน classroom_sync ครั้งแรกก่อน",
                "tasks": [], "total": 0}
    try:
        params: list[Any] = []
        where: list[str] = []

        if query:
            patterns = _expand_subject(query)
            # Also keep the raw query (for non-subject keywords like task titles)
            if query.lower() not in patterns:
                patterns.insert(0, query.lower())
            clauses = []
            for p in patterns:
                clauses.append("(LOWER(cw.title) LIKE ? OR LOWER(c.name) LIKE ? OR "
                               "LOWER(IFNULL(c.section,'')) LIKE ?)")
                pl = f"%{p}%"
                params += [pl, pl, pl]
            where.append("(" + " OR ".join(clauses) + ")")

        start, end = _period_bounds(period)
        if start and end:
            where.append("cw.due_at >= ? AND cw.due_at < ?")
            params += [start, end]
        elif period and period not in ("all", None):
            return {"error": f"period ไม่รู้จัก: {period}",
                    "allowed": ["today", "tomorrow", "this_week", "next_week",
                                "this_month", "all"]}

        # Explicit date range — useful when caller wants a specific month
        # ("ม.ค. 2026") or term that ``period`` doesn't cover.
        if due_from:
            try:
                df = datetime.fromisoformat(due_from)
                if df.tzinfo is None:
                    df = df.replace(tzinfo=BKK)
                where.append("cw.due_at >= ?")
                params.append(df.isoformat())
            except ValueError:
                return {"error": f"due_from invalid: expect YYYY-MM-DD, got {due_from}"}
        if due_to:
            try:
                dt_to = datetime.fromisoformat(due_to)
                if dt_to.tzinfo is None:
                    dt_to = dt_to.replace(tzinfo=BKK)
                where.append("cw.due_at < ?")
                params.append(dt_to.isoformat())
            except ValueError:
                return {"error": f"due_to invalid: expect YYYY-MM-DD, got {due_to}"}

        where_sql = "WHERE " + " AND ".join(where) if where else ""
        select_cols = ["cw.id", "cw.title", "cw.due_at", "cw.link AS task_link",
                       "cw.max_points", "c.name AS course_name", "c.section AS course_section",
                       "sub.state AS sub_state", "sub.late", "sub.assigned_grade"]
        if not titles_only:
            select_cols.append("cw.description")

        sql = f"""
            SELECT {', '.join(select_cols)}
            FROM coursework cw
            LEFT JOIN courses c ON c.id = cw.course_id
            LEFT JOIN submissions sub ON sub.coursework_id = cw.id
            {where_sql}
            ORDER BY cw.due_at ASC NULLS LAST, cw.title
        """
        rows = conn.execute(sql, params).fetchall()

        now_iso = _now_iso()
        items_all = []
        for r in rows:
            st = _derive_status(r["sub_state"], r["late"], r["due_at"], now_iso)
            item = {
                "id": r["id"],
                "title": r["title"],
                "course": _abbreviate_course(r["course_name"]),
                "section": r["course_section"] or "",
                "due_at": r["due_at"],
                "status": st,
                "link": r["task_link"],
                "max_points": r["max_points"],
                "grade": r["assigned_grade"],
            }
            if not titles_only:
                item["description"] = r["description"]
            items_all.append(item)

        # --- include derived tasks (extracted from announcements/materials) ---
        if include_derived:
            dt_params: list[Any] = []
            dt_where: list[str] = ["d.dismissed = 0"]
            if query:
                dt_where.append("(LOWER(d.title) LIKE ? OR LOWER(c.name) LIKE ?)")
                q = f"%{query.lower()}%"
                dt_params += [q, q]
            if start and end:
                dt_where.append("d.due_at >= ? AND d.due_at < ?")
                dt_params += [start, end]
            if due_from:
                df = datetime.fromisoformat(due_from)
                if df.tzinfo is None:
                    df = df.replace(tzinfo=BKK)
                dt_where.append("d.due_at >= ?")
                dt_params.append(df.isoformat())
            if due_to:
                dt_to = datetime.fromisoformat(due_to)
                if dt_to.tzinfo is None:
                    dt_to = dt_to.replace(tzinfo=BKK)
                dt_where.append("d.due_at < ?")
                dt_params.append(dt_to.isoformat())
            dt_where_sql = "WHERE " + " AND ".join(dt_where)
            d_rows = conn.execute(f"""
                SELECT d.id, d.title, d.due_at, d.source_link AS task_link,
                       d.confidence, d.evidence, d.source_type,
                       c.name AS course_name, c.section AS course_section
                FROM derived_tasks d
                LEFT JOIN courses c ON c.id = d.course_id
                {dt_where_sql}
                ORDER BY d.due_at ASC
            """, dt_params).fetchall()
            for r in d_rows:
                # Derived tasks have no submission record — status is always
                # pending/overdue based on due_at.
                st = "overdue" if (r["due_at"] and r["due_at"] < now_iso) else "pending"
                item = {
                    "id": f"derived:{r['id']}",
                    "title": r["title"],
                    "course": r["course_name"],
                    "section": r["course_section"] or "",
                    "due_at": r["due_at"],
                    "status": st,
                    "link": r["task_link"],
                    "max_points": None,
                    "grade": None,
                    "source": r["source_type"],   # 'announcement' or 'material'
                    "confidence": r["confidence"],
                }
                if not titles_only:
                    item["evidence"] = r["evidence"]
                items_all.append(item)
            # Re-sort combined list by due_at
            items_all.sort(key=lambda x: (x.get("due_at") or "9999"))

        if status and status != "all":
            items_all = [i for i in items_all if i["status"] == status]

        total = len(items_all)
        page = items_all[offset:offset + limit]

        result = {
            "total": total,
            "showing": len(page),
            "offset": offset,
            "has_more": offset + len(page) < total,
            "tasks": page,
            "data_synced_at": _last_synced(conn),
            "queried_at": now_iso,
        }
        # 0 results + a query = surface available subjects so the agent can
        # suggest alternatives instead of just "not found".
        if total == 0 and query:
            subs = conn.execute(
                "SELECT DISTINCT name FROM courses ORDER BY name"
            ).fetchall()
            result["available_subjects"] = [_abbreviate_course(r["name"]) for r in subs]
            result["hint"] = (
                f"ไม่พบงานที่ match '{query}' — "
                "อาจเป็นเพราะโรงเรียนไม่ได้สอนวิชานี้ หรือยังไม่มีงานที่ส่ง"
            )
        return result
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

def summary(period: str | None = "all") -> dict[str, Any]:
    """Aggregate counts: by_status, by_subject, plus top overdue titles."""
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี"}
    try:
        params: list[Any] = []
        where = ""
        start, end = _period_bounds(period)
        if start and end:
            where = "WHERE cw.due_at >= ? AND cw.due_at < ?"
            params = [start, end]

        sql = f"""
            SELECT cw.id, cw.title, cw.due_at, c.name AS course_name,
                   sub.state AS sub_state, sub.late
            FROM coursework cw
            LEFT JOIN courses c ON c.id = cw.course_id
            LEFT JOIN submissions sub ON sub.coursework_id = cw.id
            {where}
        """
        rows = conn.execute(sql, params).fetchall()
        now_iso = _now_iso()

        by_status: dict[str, int] = {}
        by_subject: dict[str, int] = {}
        overdue_titles: list[dict[str, str]] = []

        for r in rows:
            st = _derive_status(r["sub_state"], r["late"], r["due_at"], now_iso)
            by_status[st] = by_status.get(st, 0) + 1
            subj = r["course_name"] or "(ไม่ทราบ)"
            by_subject[subj] = by_subject.get(subj, 0) + 1
            if st == "overdue":
                overdue_titles.append({
                    "title": r["title"], "course": subj, "due_at": r["due_at"],
                })

        overdue_titles.sort(key=lambda x: x["due_at"] or "")
        return {
            "period": period or "all",
            "total": len(rows),
            "by_status": by_status,
            "by_subject": by_subject,
            "overdue_top": overdue_titles[:10],
            "data_synced_at": _last_synced(conn),
            "queried_at": now_iso,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# task_detail
# ---------------------------------------------------------------------------

def _period_filter_clause(period: str | None, params: list[Any],
                          column: str = "created_at") -> str | None:
    """Build WHERE clause for period filter on a given timestamp column."""
    start, end = _period_bounds(period)
    if start and end:
        params += [start, end]
        return f"{column} >= ? AND {column} < ?"
    return None


def list_announcements(query: str | None = None, period: str | None = None,
                       subject: str | None = None,
                       due_from: str | None = None, due_to: str | None = None,
                       titles_only: bool = True,
                       limit: int = 20, offset: int = 0) -> dict[str, Any]:
    """List teacher announcements (often where hidden deadlines live).

    Use this when the user asks about ประกาศ, ข่าวสาร, ครูบอก, or wants to
    scan for missed instructions. Pair with ``list_materials`` for full
    coverage of teacher-posted content.
    """
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี", "items": [], "total": 0}
    try:
        params: list[Any] = []
        where: list[str] = []
        if query:
            where.append("(LOWER(a.text) LIKE ? OR LOWER(c.name) LIKE ?)")
            q = f"%{query.lower()}%"
            params += [q, q]
        if subject:
            where.append("(LOWER(c.name) LIKE ? OR LOWER(IFNULL(c.section,'')) LIKE ?)")
            s = f"%{subject.lower()}%"
            params += [s, s]
        period_clause = _period_filter_clause(period, params, "a.created_at")
        if period_clause:
            where.append(period_clause)
        if due_from:
            try:
                df = datetime.fromisoformat(due_from)
                if df.tzinfo is None:
                    df = df.replace(tzinfo=BKK)
                where.append("a.created_at >= ?")
                params.append(df.isoformat())
            except ValueError:
                return {"error": f"due_from invalid: {due_from}"}
        if due_to:
            try:
                dt_to = datetime.fromisoformat(due_to)
                if dt_to.tzinfo is None:
                    dt_to = dt_to.replace(tzinfo=BKK)
                where.append("a.created_at < ?")
                params.append(dt_to.isoformat())
            except ValueError:
                return {"error": f"due_to invalid: {due_to}"}

        where_sql = "WHERE " + " AND ".join(where) if where else ""
        rows = conn.execute(f"""
            SELECT a.id, a.text, a.created_at, a.link,
                   c.name AS course_name, c.section AS course_section
            FROM announcements a
            LEFT JOIN courses c ON c.id = a.course_id
            {where_sql}
            ORDER BY a.created_at DESC
        """, params).fetchall()

        total = len(rows)
        page = rows[offset:offset + limit]
        items = []
        for r in page:
            item = {
                "id": r["id"],
                "course": _abbreviate_course(r["course_name"]),
                "section": r["course_section"] or "",
                "posted_at": r["created_at"],
                "link": r["link"],
            }
            if titles_only:
                txt = (r["text"] or "").strip()
                item["text_preview"] = txt[:120] + ("…" if len(txt) > 120 else "")
            else:
                item["text"] = r["text"] or ""
            items.append(item)

        return {
            "total": total,
            "showing": len(page),
            "offset": offset,
            "has_more": offset + len(page) < total,
            "items": items,
            "data_synced_at": _last_synced(conn),
        }
    finally:
        conn.close()


def list_materials(query: str | None = None, period: str | None = None,
                   subject: str | None = None,
                   titles_only: bool = True,
                   limit: int = 20, offset: int = 0) -> dict[str, Any]:
    """List teacher-shared course materials (PDFs, slides, links)."""
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี", "items": [], "total": 0}
    try:
        params: list[Any] = []
        where: list[str] = []
        if query:
            where.append("(LOWER(m.title) LIKE ? OR LOWER(m.description) LIKE ? OR LOWER(c.name) LIKE ?)")
            q = f"%{query.lower()}%"
            params += [q, q, q]
        if subject:
            where.append("(LOWER(c.name) LIKE ? OR LOWER(IFNULL(c.section,'')) LIKE ?)")
            s = f"%{subject.lower()}%"
            params += [s, s]
        period_clause = _period_filter_clause(period, params, "m.created_at")
        if period_clause:
            where.append(period_clause)

        where_sql = "WHERE " + " AND ".join(where) if where else ""
        rows = conn.execute(f"""
            SELECT m.id, m.title, m.description, m.created_at, m.link, m.materials_json,
                   c.name AS course_name, c.section AS course_section
            FROM materials m
            LEFT JOIN courses c ON c.id = m.course_id
            {where_sql}
            ORDER BY m.created_at DESC
        """, params).fetchall()

        total = len(rows)
        page = rows[offset:offset + limit]
        items = []
        for r in page:
            item = {
                "id": r["id"],
                "title": r["title"],
                "course": _abbreviate_course(r["course_name"]),
                "section": r["course_section"] or "",
                "posted_at": r["created_at"],
                "link": r["link"],
            }
            if not titles_only:
                item["description"] = r["description"] or ""
                if r["materials_json"]:
                    try:
                        item["attachments"] = json.loads(r["materials_json"])
                    except json.JSONDecodeError:
                        pass
            items.append(item)

        return {
            "total": total,
            "showing": len(page),
            "offset": offset,
            "has_more": offset + len(page) < total,
            "items": items,
            "data_synced_at": _last_synced(conn),
        }
    finally:
        conn.close()


def list_courses(query: str | None = None) -> dict[str, Any]:
    """List all courses (optionally filtered by fuzzy name match)."""
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี"}
    try:
        if query:
            rows = conn.execute(
                "SELECT id, name, section, room FROM courses "
                "WHERE LOWER(name) LIKE ? OR LOWER(IFNULL(section,'')) LIKE ? "
                "ORDER BY name",
                (f"%{query.lower()}%", f"%{query.lower()}%"),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name, section, room FROM courses ORDER BY name"
            ).fetchall()
        return {
            "total": len(rows),
            "courses": [{
                "id": r["id"],
                "name": _abbreviate_course(r["name"]),
                "section": r["section"] or "",
                "room": r["room"] or "",
            } for r in rows],
            "data_synced_at": _last_synced(conn),
        }
    finally:
        conn.close()


def list_teachers(query: str | None = None, subject: str | None = None) -> dict[str, Any]:
    """List teachers, optionally filtered by subject (fuzzy course-name match)
    or by teacher name."""
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี"}
    try:
        params: list[Any] = []
        where: list[str] = []

        if subject:
            patterns = _expand_subject(subject)
            clauses = []
            for p in patterns:
                clauses.append("(LOWER(c.name) LIKE ? OR LOWER(IFNULL(c.section,'')) LIKE ?)")
                params += [f"%{p}%", f"%{p}%"]
            where.append("(" + " OR ".join(clauses) + ")")

        if query:
            where.append("LOWER(t.name) LIKE ?")
            params.append(f"%{query.lower()}%")

        where_sql = "WHERE " + " AND ".join(where) if where else ""
        # Sort: real teachers (no NISIT prefix) first, then student-interns
        # alphabetically within each tier. The CASE WHEN expression turns the
        # nisit flag into a 0/1 secondary sort key.
        rows = conn.execute(f"""
            SELECT t.user_id, t.name, t.email, t.course_id,
                   c.name AS course_name, c.section AS course_section,
                   CASE WHEN UPPER(t.name) LIKE 'NISIT%' THEN 1 ELSE 0 END AS is_intern
            FROM teachers t
            LEFT JOIN courses c ON c.id = t.course_id
            {where_sql}
            ORDER BY c.name, is_intern, t.name
        """, params).fetchall()

        result = {
            "total": len(rows),
            "teachers": [{
                "name": _normalize_teacher_name(r["name"]),
                "email": r["email"] or "",
                "course": _abbreviate_course(r["course_name"]),
                "section": r["course_section"] or "",
            } for r in rows],
            "data_synced_at": _last_synced(conn),
        }
        # Empty result — surface the list of available subjects so the agent
        # can tell the user what's actually offered instead of saying "error".
        if not rows and (subject or query):
            all_subjects = conn.execute(
                "SELECT DISTINCT name FROM courses ORDER BY name"
            ).fetchall()
            result["available_subjects"] = [_abbreviate_course(r["name"]) for r in all_subjects]
            result["hint"] = "ไม่พบครูสำหรับวิชานี้ในระบบ — โรงเรียนอาจไม่ได้สอนวิชานี้"
        return result
    finally:
        conn.close()


def task_detail(task_id: str) -> dict[str, Any]:
    """Full description + materials + status for one assignment."""
    conn = _open()
    if not conn:
        return {"error": "Classroom DB ยังไม่มี"}
    try:
        row = conn.execute("""
            SELECT cw.*, c.name AS course_name, c.section AS course_section,
                   sub.state AS sub_state, sub.late, sub.assigned_grade, sub.updated_at AS sub_updated_at
            FROM coursework cw
            LEFT JOIN courses c ON c.id = cw.course_id
            LEFT JOIN submissions sub ON sub.coursework_id = cw.id
            WHERE cw.id = ?
        """, (task_id,)).fetchone()
        if not row:
            return {"error": f"ไม่พบ task_id={task_id}",
                    "data_synced_at": _last_synced(conn)}

        materials = []
        if row["materials_json"]:
            try:
                materials = json.loads(row["materials_json"])
            except json.JSONDecodeError:
                materials = []

        now_iso = _now_iso()
        st = _derive_status(row["sub_state"], row["late"], row["due_at"], now_iso)
        return {
            "id": row["id"],
            "title": row["title"],
            "course": row["course_name"],
            "section": row["course_section"] or "",
            "description": row["description"] or "",
            "work_type": row["work_type"],
            "max_points": row["max_points"],
            "due_at": row["due_at"],
            "link": row["link"],
            "materials": materials,
            "status": st,
            "submission_updated_at": row["sub_updated_at"],
            "grade": row["assigned_grade"],
            "data_synced_at": _last_synced(conn),
            "queried_at": now_iso,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------

def classroom_tool(action: str, **kwargs) -> dict[str, Any]:
    if action == "list_tasks":
        return list_tasks(
            query=kwargs.get("query"),
            status=kwargs.get("status"),
            period=kwargs.get("period"),
            titles_only=kwargs.get("titles_only", True),
            limit=int(kwargs.get("limit", 30)),
            offset=int(kwargs.get("offset", 0)),
            due_from=kwargs.get("due_from"),
            due_to=kwargs.get("due_to"),
            include_derived=kwargs.get("include_derived", True),
        )
    if action == "summary":
        return summary(period=kwargs.get("period", "all"))
    if action == "task_detail":
        task_id = kwargs.get("task_id")
        if not task_id:
            return {"error": "task_id ต้องระบุ"}
        return task_detail(str(task_id))
    if action == "courses":
        return list_courses(query=kwargs.get("query"))
    if action == "teachers":
        return list_teachers(query=kwargs.get("query"), subject=kwargs.get("subject"))
    if action == "announcements":
        return list_announcements(
            query=kwargs.get("query"),
            period=kwargs.get("period"),
            subject=kwargs.get("subject"),
            due_from=kwargs.get("due_from"),
            due_to=kwargs.get("due_to"),
            titles_only=kwargs.get("titles_only", True),
            limit=int(kwargs.get("limit", 20)),
            offset=int(kwargs.get("offset", 0)),
        )
    if action == "materials":
        return list_materials(
            query=kwargs.get("query"),
            period=kwargs.get("period"),
            subject=kwargs.get("subject"),
            titles_only=kwargs.get("titles_only", True),
            limit=int(kwargs.get("limit", 20)),
            offset=int(kwargs.get("offset", 0)),
        )
    return {"error": f"action ไม่รู้จัก: {action}",
            "allowed": ["list_tasks", "summary", "task_detail",
                        "courses", "teachers", "announcements", "materials"]}


CLASSROOM_SCHEMA = {
    "name": "classroom",
    "description": (
        "Query Google Classroom data (courses, assignments, submissions) for the family's school. "
        "Use this whenever the user asks about การบ้าน, งานค้าง, งานส่งแล้ว, วิชา, ส่งวันไหน, "
        "หรือคำถามใดๆ เกี่ยวกับโรงเรียน. Never guess — if no data is found, say so clearly."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list_tasks", "summary", "task_detail", "courses", "teachers",
                         "announcements", "materials"],
                "description": (
                    "list_tasks: list assignments with filters. "
                    "summary: aggregate counts (by status, by subject) — use for "
                    "questions like 'งานทั้งหมดมีกี่ชิ้น', 'เดือนนี้ส่งกี่ชิ้น'. "
                    "task_detail: full description + materials for ONE assignment. "
                    "courses: list all enrolled subjects (optional query filter). "
                    "teachers: list teachers, optionally filtered by subject. "
                    "announcements: read teacher announcements (where hidden "
                    "deadlines often live) — use for 'ประกาศใหม่', 'ครูบอกอะไร'. "
                    "materials: list teacher-shared materials (PDFs, slides, links)."
                ),
            },
            "subject": {
                "type": "string",
                "description": "Fuzzy subject match for action=teachers (use Thai keywords like 'เลข', 'ดนตรี', 'eng').",
            },
            "query": {
                "type": "string",
                "description": (
                    "Free-text fuzzy match against course name + task title. "
                    "Use Thai keywords like 'คณิต', 'ไทย', 'ดนตรี'. Omit for all subjects."
                ),
            },
            "status": {
                "type": "string",
                "enum": ["submitted", "late_submitted", "pending", "overdue", "returned", "all"],
                "description": "Filter by submission status. Default 'all'.",
            },
            "period": {
                "type": "string",
                "enum": ["today", "tomorrow", "this_week", "next_week", "this_month", "all"],
                "description": "Filter by dueDate window. Default 'all'.",
            },
            "titles_only": {
                "type": "boolean",
                "description": "When true (default), drop long descriptions to save tokens. Set false only if you need full text.",
            },
            "limit": {"type": "integer", "description": "Page size for list_tasks (default 30)."},
            "offset": {"type": "integer", "description": "Pagination offset for list_tasks."},
            "task_id": {"type": "string", "description": "Required for action=task_detail. Get id from a previous list_tasks call."},
        },
        "required": ["action"],
    },
}


# Self-register on import
from tools.registry import registry  # noqa: E402

registry.register(
    name="classroom",
    toolset="classroom",
    schema=CLASSROOM_SCHEMA,
    handler=lambda args, **kw: classroom_tool(
        action=args.get("action", ""),
        query=args.get("query"),
        status=args.get("status"),
        period=args.get("period"),
        titles_only=args.get("titles_only", True),
        limit=args.get("limit", 30),
        offset=args.get("offset", 0),
        task_id=args.get("task_id"),
    ),
    emoji="🎓",
    description="Query Google Classroom (assignments, status, summary) for the family-bot.",
)
