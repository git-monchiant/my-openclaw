#!/usr/bin/env python3
"""Classroom → Trello sync. Turns the local Classroom mirror
(~/.hermes/data/classroom.db) into Trello cards on the "PDS" board.

Rules (confirmed with the family):
  - coursework (assignment):
      submitted/returned in Classroom → mark card complete + move to "Wait for submit"
      contains exam keyword           → list "Exam"
      due within 2 days or overdue    → list "Urgent"
      otherwise                       → list "To Do"
  - announcement / material:
      if its text mentions a due date (extracted by the LLM) → treated as a task
        (Exam / Urgent / To Do by the same rules)
      else announcement → "แจ้งเพื่อทราบ", material → "เอกสารประกอบการสอน"
  - every card is labelled with its course name (label created if missing).
  - dedup + respect manual moves: a card is only RE-positioned by the sync when
    Classroom drives a transition (became submitted, or due date changed). Manual
    moves (e.g. into "Doing") are left alone otherwise.

Auth from ~/.hermes/.env: TRELLO_API_KEY/TRELLO_API_TOKEN, GOOGLE_API_KEY.
Run:  python scripts/classroom_trello_sync.py [--dry-run]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx

BKK = timezone(timedelta(hours=7))
DB_PATH = Path(os.getenv("CLASSROOM_DB_PATH") or (Path.home() / ".hermes" / "data" / "classroom.db"))
TRELLO = "https://api.trello.com/1"
GEMINI = "https://generativelanguage.googleapis.com/v1beta"
BOARD_NAME = os.getenv("TRELLO_BOARD", "PDS")
URGENT_DAYS = 2

L_TODO, L_URGENT, L_EXAM = "To Do", "Urgent", "Exam"
L_ANNOUNCE, L_MATERIAL, L_DONE = "แจ้งเพื่อทราบ", "เอกสารประกอบการสอน", "Wait for submit"
DONE_STATES = ("TURNED_IN", "RETURNED")
EXAM_KW = ["สอบ", "ทดสอบ", "quiz", "exam", "test", "สอบซ่อม", "เตรียมสอบ",
           "ปลายภาค", "กลางภาค", "มิดเทอม", "ไฟนอล"]
# Subject-group colors: every course is classified into a subject group by
# keyword / Thai subject-code, and ALL courses in the same group share ONE
# color (e.g. every English course → blue, every Math course → red). First
# match wins; Thai uses specific keywords so "ดนตรีไทย" (art) isn't mis-grouped
# as Thai. No "black" — it renders gray, which the user dislikes.
_SUBJECT_GROUPS = [
    ("red",    ["คณิต", "เลข", "ค22", "ค21", "m22201", "math"]),                 # คณิตศาสตร์
    ("green",  ["วิทย", "เทคโนโลย", "ว22", "ว21", "science", "โครงงานวิท"]),       # วิทย์/เทคโนโลยี
    ("blue",   ["อังกฤษ", "english", "อ22", "อ21", "อ 22", "อ 21"]),             # ภาษาอังกฤษ
    ("sky",    ["เยอรมัน", "german", "ย22", "ย21", "g21", "g22"]),               # ภาษาเยอรมัน
    ("yellow", ["ภาษาไทย", "ไทยพื้นฐาน", "ท22", "ท21"]),                          # ภาษาไทย
    ("orange", ["สังคม", "ประวัติศาสตร", "พระพุทธ", "ศาสนา", "ส21", "ส22"]),       # สังคมศาสตร์ (รวมประวัติ/พุทธ)
    ("lime",   ["พลศึกษา", "สุขศึกษา", "health", "พ21", "พ22"]),                   # สุข/พลศึกษา
    ("purple", ["ศิลป", "ทัศนศิลป", "ดนตรี", "นาฏศิลป", "ศ21", "ศ22"]),            # ศิลปะ
    ("pink",   ["แนะแนว", "ห้องสมุด", "กิจกรรม"]),                                 # แนะแนว/ห้องสมุด
    ("lime",   ["การงาน", "ประดิษฐ", "ง21", "ง22"]),                              # การงานอาชีพ
]
_DEFAULT_COLOR = "purple"


def subject_color(name: str) -> str:
    """Return the shared color for the subject group a course name belongs to."""
    low = (name or "").lower()
    for color, kws in _SUBJECT_GROUPS:
        if any(k in low for k in kws):
            return color
    return _DEFAULT_COLOR


def now() -> datetime:
    return datetime.now(BKK)


def _load_env() -> None:
    try:
        from dotenv import load_dotenv
        load_dotenv(str(Path.home() / ".hermes" / ".env"))
    except Exception:
        p = Path.home() / ".hermes" / ".env"
        if p.exists():
            for ln in p.read_text(encoding="utf-8").splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#") and "=" in ln:
                    k, _, v = ln.partition("=")
                    os.environ.setdefault(k.strip(), v.strip())


def is_exam(text: str) -> bool:
    low = (text or "").lower()
    return any(k.lower() in low for k in EXAM_KW)


# --------------------------------------------------------------------------- LLM
def classify(items: list[dict]) -> dict[int, dict]:
    """items: [{idx, type, title, text, has_due}].
    Returns {idx: {"due": iso|None, "exam": bool}} for EVERY item.
    Uses gemini-2.5-pro (flash returns empty with bigger prompts) to:
      - extract a due date from free-text announcements/materials, and
      - classify whether the item is an academic exam/quiz/test to study for
        (NOT a fitness 'ทดสอบสมรรถภาพ' activity, NOT a routine assignment)."""
    if not items:
        return {}
    key = os.getenv("GOOGLE_API_KEY", "")
    if not key:
        return {}
    today = now().strftime("%Y-%m-%d (%A)")
    rows = [{"i": it["idx"], "type": it["type"], "has_due": it["has_due"],
             "title": it["title"][:200], "text": (it["text"] or "")[:600]}
            for it in items]
    prompt = (
        f"วันนี้คือ {today} (เขตเวลา Asia/Bangkok).\n"
        "ด้านล่างเป็นรายการจาก Google Classroom (coursement=งาน, announcement=ประกาศ, "
        "material=เอกสาร). สำหรับแต่ละรายการให้ตอบ 2 ค่า:\n"
        "1) due: ถ้าในเนื้อหา/ชื่อมีการระบุ 'กำหนดส่ง/วันครบกำหนด/วันสอบ' ให้แปลงเป็น "
        "ISO datetime เขตเวลา +07:00 (เช่น 2026-06-15T16:00:00+07:00). "
        "ถ้า has_due=true อยู่แล้วหรือไม่มีกำหนดชัดเจน ให้ใส่ null.\n"
        "2) exam: true เฉพาะเมื่อเป็นการสอบ/quiz/test/สอบเก็บคะแนน/กลางภาค/ปลายภาค "
        "ที่ต้องอ่านหนังสือไปสอบจริงๆ. งานทั่วไป ใบงาน การบ้าน หรือ 'ทดสอบสมรรถภาพ"
        "ทางกาย' (พละ) ให้ exam=false.\n"
        "ตอบเป็น JSON array เท่านั้น: "
        '[{"i":<index>,"due":<"iso"|null>,"exam":<true|false>}]\n\n'
        + json.dumps(rows, ensure_ascii=False)
    )
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 16384,
                                 "thinkingConfig": {"thinkingBudget": 0}}}
    try:
        with httpx.Client(timeout=120) as c:
            r = c.post(f"{GEMINI}/models/gemini-2.5-flash:generateContent",
                       params={"key": key}, json=body)
            r.raise_for_status()
            cand = r.json()["candidates"][0]
            parts = cand.get("content", {}).get("parts", [])
            txt = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
        if not txt:
            raise RuntimeError(f"empty model output (finishReason={cand.get('finishReason')})")
        arr = json.loads(txt[txt.find("["): txt.rfind("]") + 1])
        out = {}
        for o in arr:
            due = o.get("due")
            out[int(o["i"])] = {"due": due if isinstance(due, str) and due else None,
                                "exam": bool(o.get("exam"))}
        return out
    except Exception as e:  # noqa: BLE001
        print(f"[trello_sync] classify failed (fallback: keyword exam, no extracted dates): {e}",
              file=sys.stderr)
        return {}


# ------------------------------------------------------------------------ Trello
def _norm_title(s: str) -> str:
    """Normalize a card title for duplicate detection (strip prefixes/punct)."""
    s = re.sub(r"\((?:Homework|AI)\)", "", s or "")
    return re.sub(r"[\s()\[\].,\-:/]+", "", s).lower()


class Trello:
    def __init__(self, key: str, token: str, dry: bool):
        self.auth = {"key": key, "token": token}
        self.dry = dry
        self.c = httpx.Client(timeout=30)
        self.board_id = None
        self.lists: dict[str, str] = {}
        self.labels: dict[str, str] = {}
        # (normalized title, first label id) -> existing open card id.
        # Used to adopt a card that's already on the board instead of creating
        # a duplicate when the trello_sync dedup row is missing/lost.
        self.cards_by_key: dict[tuple, str] = {}
        self.open_card_ids: set[str] = set()  # so stale dedup rows (archived/deleted cards) are detected

    def _req(self, method, path, **params):
        url = f"{TRELLO}{path}"
        if method.upper() in ("POST", "PUT"):
            # Auth stays in the query; payload goes in the body so long fields
            # (e.g. a big Thai ``desc``) don't blow the URL length limit (HTTP 414).
            r = self.c.request(method, url, params=self.auth, data=params)
        else:
            r = self.c.request(method, url, params={**self.auth, **params})
        r.raise_for_status()
        return r.json() if r.text else {}

    def setup(self):
        boards = self._req("GET", "/members/me/boards", fields="name")
        match = [b for b in boards if b["name"].strip().lower() == BOARD_NAME.lower()]
        if not match:
            raise RuntimeError(f"board {BOARD_NAME!r} not found")
        self.board_id = match[0]["id"]
        for l in self._req("GET", f"/boards/{self.board_id}/lists", filter="open", fields="name"):
            self.lists[l["name"]] = l["id"]
        for l in self._req("GET", f"/boards/{self.board_id}/labels", fields="name,color"):
            if l.get("name"):
                self.labels[l["name"]] = l["id"]
        for c in self._req("GET", f"/boards/{self.board_id}/cards",
                           filter="open", fields="name,idLabels"):
            self.open_card_ids.add(c["id"])
            nt = _norm_title(c.get("name", ""))
            # index under every label the card carries (and "" for none), so a
            # match succeeds no matter which label slot holds the course tag.
            for lid in (c.get("idLabels") or [""]) or [""]:
                self.cards_by_key.setdefault((nt, lid or ""), c["id"])

    def list_id(self, name: str) -> str | None:
        return self.lists.get(name)

    def ensure_label(self, name: str) -> str | None:
        if not name:
            return None
        if name in self.labels:
            return self.labels[name]
        color = subject_color(name)
        if self.dry:
            self.labels[name] = f"DRY:{name}"
            return self.labels[name]
        lab = self._req("POST", "/labels", name=name, color=color, idBoard=self.board_id)
        self.labels[name] = lab["id"]
        return lab["id"]

    def create_card(self, list_name, name, desc, due, label_id):
        lid = self.list_id(list_name)
        if self.dry:
            return f"DRY:{name[:20]}"
        params = {"idList": lid, "name": name, "desc": desc, "pos": "bottom"}
        if due:
            params["due"] = due
        if label_id and not str(label_id).startswith("DRY:"):
            params["idLabels"] = label_id
        return self._req("POST", "/cards", **params)["id"]

    def update_card(self, card_id, *, list_name=None, due=None, due_complete=None, desc=None):
        if self.dry or str(card_id).startswith("DRY:"):
            return
        params = {}
        if list_name:
            params["idList"] = self.list_id(list_name)
        if due is not None:
            params["due"] = due
        if due_complete is not None:
            params["dueComplete"] = "true" if due_complete else "false"
        if desc is not None:
            params["desc"] = desc
        if params:
            try:
                self._req("PUT", f"/cards/{card_id}", **params)
            except httpx.HTTPStatusError as e:
                # Card archived/deleted between setup and now — ignore instead
                # of crashing the whole sync.
                if e.response.status_code == 404:
                    return
                raise


# --------------------------------------------------------------------------- main
SYNC_SCHEMA = """
CREATE TABLE IF NOT EXISTS trello_sync (
    source_type TEXT, source_id TEXT, card_id TEXT,
    last_state TEXT, last_due TEXT, list_name TEXT, synced_at TEXT,
    content_hash TEXT,
    PRIMARY KEY (source_type, source_id)
);
"""


def main() -> int:
    _load_env()
    dry = "--dry-run" in sys.argv
    if not DB_PATH.exists():
        print("[trello_sync] no classroom.db — run classroom_sync first", file=sys.stderr)
        return 1
    tkey, ttok = os.getenv("TRELLO_API_KEY", ""), os.getenv("TRELLO_API_TOKEN", "")
    if not (tkey and ttok):
        print("[trello_sync] TRELLO_API_KEY/TOKEN not set", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.executescript(SYNC_SCHEMA)
    try:  # migrate older dedup tables (adds the description-change tracker)
        conn.execute("ALTER TABLE trello_sync ADD COLUMN content_hash TEXT")
    except sqlite3.OperationalError:
        pass
    courses = {r["id"]: (r["name"] or "") for r in conn.execute("SELECT id,name FROM courses")}

    # Gather items.
    items: list[dict] = []
    for r in conn.execute("""SELECT cw.id,cw.course_id,cw.title,cw.description,cw.due_at,cw.link,
                                    sub.state AS state, sub.late
                             FROM coursework cw
                             LEFT JOIN submissions sub ON sub.coursework_id=cw.id"""):
        items.append({"st": "coursework", "id": r["id"], "course": courses.get(r["course_id"], ""),
                      "title": r["title"] or "(ไม่มีชื่อ)", "due": r["due_at"], "link": r["link"],
                      "state": r["state"], "body": r["description"] or "",
                      "text": (r["title"] or "") + " " + (r["description"] or "")})
    for r in conn.execute("SELECT id,course_id,text,link FROM announcements"):
        items.append({"st": "announcement", "id": r["id"], "course": courses.get(r["course_id"], ""),
                      "title": (r["text"] or "(ประกาศ)").strip().split("\n")[0][:80],
                      "due": None, "link": r["link"], "state": None,
                      "body": r["text"] or "", "text": r["text"] or ""})
    for r in conn.execute("SELECT id,course_id,title,description,link FROM materials"):
        items.append({"st": "material", "id": r["id"], "course": courses.get(r["course_id"], ""),
                      "title": r["title"] or "(เอกสาร)", "due": None, "link": r["link"],
                      "state": None, "body": r["description"] or "",
                      "text": (r["title"] or "") + " " + (r["description"] or "")})

    # LLM: classify exam + extract due dates from free text (ALL items).
    to_classify = [{"idx": i, "type": it["st"], "title": it["title"], "text": it["text"],
                    "has_due": bool(it["due"])} for i, it in enumerate(items)]
    info = classify(to_classify)
    for i, it in enumerate(items):
        r = info.get(i)
        if r:
            if it["st"] in ("announcement", "material") and not it["due"]:
                it["due"] = r.get("due")
            it["exam_llm"] = r.get("exam")
        else:
            it["exam_llm"] = None  # classify failed for this item → fall back to keyword

    now_iso = now().isoformat()
    urgent_cut = (now() + timedelta(days=URGENT_DAYS)).isoformat()

    def target_list(it) -> tuple[str, bool]:
        """Returns (list_name, mark_complete)."""
        if it["st"] == "coursework" and it["state"] in DONE_STATES:
            return L_DONE, True
        has_due = bool(it["due"])
        if it["st"] in ("announcement", "material") and not has_due:
            return (L_ANNOUNCE if it["st"] == "announcement" else L_MATERIAL), False
        exam = it.get("exam_llm")
        if exam is None:               # classify unavailable → keyword fallback
            exam = is_exam(it["text"])
        if exam:
            return L_EXAM, False
        if has_due and it["due"] <= urgent_cut:   # due soon or overdue
            return L_URGENT, False
        return L_TODO, False

    def build_desc(it) -> str:
        """Card description: course + due + the actual Classroom content + link."""
        lines = []
        if it["course"]:
            lines.append(f"📚 วิชา: {it['course']}")
        if it["due"]:
            lines.append(f"🗓️ กำหนดส่ง: {it['due'][:16].replace('T', ' ')} น.")
        body = (it.get("body") or "").strip()
        if body:
            lines.append("")
            lines.append(body[:4000])
        if it["link"]:
            lines.append("")
            lines.append(f"🔗 เปิดใน Classroom: {it['link']}")
        return "\n".join(lines)

    plan = {"create": [], "complete": [], "due_update": [], "desc_update": [], "skip": 0}
    tr = Trello(tkey, ttok, dry)
    tr.setup()

    # Pre-create a Trello label for every current course — including new
    # subjects that have no coursework yet — so cards can be tagged the
    # moment they appear. ensure_label is idempotent (skips existing ones).
    new_labels = [c.strip() for c in sorted(set(courses.values()))
                  if c.strip() and c.strip() not in tr.labels]
    for cname in new_labels:
        tr.ensure_label(cname)
    if new_labels:
        print(f"[trello_sync] created {len(new_labels)} new course label(s): "
              + ", ".join(new_labels), file=sys.stderr)

    for it in items:
        list_name, complete = target_list(it)
        label_id = tr.ensure_label(it["course"]) if it["course"] else None
        desc = build_desc(it)
        chash = hashlib.md5(desc.encode("utf-8")).hexdigest()
        prev = conn.execute(
            "SELECT * FROM trello_sync WHERE source_type=? AND source_id=?",
            (it["st"], it["id"])).fetchone()

        # Stale dedup row: the card it points to was archived/deleted (e.g. by a
        # duplicate cleanup). Drop the row and treat as new so we adopt the
        # surviving card or recreate — otherwise update_card 404s and crashes.
        if prev and prev["card_id"] not in tr.open_card_ids:
            conn.execute("DELETE FROM trello_sync WHERE source_type=? AND source_id=?",
                         (it["st"], it["id"]))
            prev = None

        if not prev:
            # Defense against lost dedup rows: if a card with the same title +
            # course-label already sits on the board, ADOPT it (record the row)
            # instead of creating a duplicate. This is why the board collected
            # 20+ copies of the same coursework before.
            adopted = tr.cards_by_key.get((_norm_title(it["title"]), label_id or ""))
            if adopted:
                conn.execute(
                    "INSERT OR REPLACE INTO trello_sync "
                    "(source_type,source_id,card_id,last_state,last_due,list_name,synced_at,content_hash) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (it["st"], it["id"], adopted, it["state"], it["due"], list_name, now_iso, chash))
                plan["skip"] += 1
                continue
            cid = tr.create_card(list_name, it["title"], desc, it["due"], label_id)
            if complete:
                tr.update_card(cid, due_complete=True)
            # remember it so a second item with the same title this run also adopts
            tr.cards_by_key.setdefault((_norm_title(it["title"]), label_id or ""), cid)
            conn.execute(
                "INSERT OR REPLACE INTO trello_sync "
                "(source_type,source_id,card_id,last_state,last_due,list_name,synced_at,content_hash) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (it["st"], it["id"], cid, it["state"], it["due"], list_name, now_iso, chash))
            plan["create"].append((list_name, it["course"], it["title"], it["due"], complete))
        else:
            became_done = (it["state"] in DONE_STATES and (prev["last_state"] not in DONE_STATES))
            due_changed = bool(it["due"] and it["due"] != prev["last_due"])
            desc_changed = (chash != prev["content_hash"])
            if became_done:
                # Transition to done → complete + move to Wait for submit.
                tr.update_card(prev["card_id"], list_name=L_DONE, due_complete=True,
                               desc=desc if desc_changed else None)
                plan["complete"].append((it["course"], it["title"]))
            elif due_changed or desc_changed:
                tr.update_card(prev["card_id"],
                               due=it["due"] if due_changed else None,
                               desc=desc if desc_changed else None)
                if due_changed:
                    plan["due_update"].append((it["course"], it["title"], it["due"]))
                if desc_changed:
                    plan["desc_update"].append((it["course"], it["title"]))
            else:
                plan["skip"] += 1
            conn.execute(
                "UPDATE trello_sync SET last_state=?, last_due=?, synced_at=?, content_hash=? "
                "WHERE source_type=? AND source_id=?",
                (it["state"], it["due"], now_iso, chash, it["st"], it["id"]))

    if not dry:
        conn.commit()
    conn.close()

    # Report → stderr so cron (--no-agent) stays silent (empty stdout); still
    # visible on the terminal for manual/dry runs.
    def p(*a):
        print(*a, file=sys.stderr)
    tag = "DRY-RUN — จะทำ:" if dry else "ทำแล้ว:"
    p(f"[trello_sync] {tag}")
    by_list: dict[str, int] = {}
    for list_name, *_ in plan["create"]:
        by_list[list_name] = by_list.get(list_name, 0) + 1
    p(f"  สร้างใหม่ {len(plan['create'])} card: " +
      ", ".join(f"{k}={v}" for k, v in by_list.items()))
    for ln, course, title, due, comp in plan["create"][:60]:
        d = f" [due {due[:16]}]" if due else ""
        c = " ✓done" if comp else ""
        p(f"    + [{ln}] {course[:18]} | {title[:48]}{d}{c}")
    if plan["complete"]:
        p(f"  → mark complete + ย้าย Wait for submit ({len(plan['complete'])}):")
        for course, title in plan["complete"]:
            p(f"    ✓ {course[:18]} | {title[:48]}")
    if plan["due_update"]:
        p(f"  → อัปเดต due ({len(plan['due_update'])})")
    if plan["desc_update"]:
        p(f"  → อัปเดต description ({len(plan['desc_update'])})")
    p(f"  ไม่เปลี่ยน (เคารพการย้ายเอง): {plan['skip']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
