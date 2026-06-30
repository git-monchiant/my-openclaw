#!/usr/bin/env python3
"""Trello tool — manage the family's Trello board(s) via the live REST API.

Credentials live in ~/.hermes/.env:
  TRELLO_API_KEY / TRELLO_API_TOKEN              → account "default"
  TRELLO_PERSONAL_API_KEY / TRELLO_PERSONAL_API_TOKEN → account "personal"

Design intent:
  - The LLM never deals with Trello IDs directly. Pass board/list/card by NAME
    (case-insensitive substring) and we resolve it to an ID; a 24-hex string is
    accepted as an explicit ID too.
  - Each action is a narrow, deterministic function returning plain dicts so the
    agent gets structured data, never raw HTML.
  - "delete" a card == archive it (closed=true), which is Trello's reversible
    remove-from-board. Permanent deletion is intentionally not exposed.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

TRELLO_API = "https://api.trello.com/1"
_ID_RE = re.compile(r"^[0-9a-fA-F]{24}$")

# Board convention: each list has ONE "header" card — a placeholder describing
# the list (e.g. "งานที่ต้องทำ", "กำหนดสอบ"), NOT an actual task. Real task cards
# are synced from Google Classroom and always carry a subject label; the
# placeholder headers have none. So: a card with no labels is a header.
def _is_header(card: dict) -> bool:
    return not card.get("labels")

# account name → (key env var, token env var)
_ACCOUNTS = {
    "default": ("TRELLO_API_KEY", "TRELLO_API_TOKEN"),
    "personal": ("TRELLO_PERSONAL_API_KEY", "TRELLO_PERSONAL_API_TOKEN"),
}


# ---------------------------------------------------------------------------
# Auth + HTTP
# ---------------------------------------------------------------------------

def _auth(account: str = "default") -> dict | None:
    key_env, token_env = _ACCOUNTS.get(account, _ACCOUNTS["default"])
    key, token = os.getenv(key_env, ""), os.getenv(token_env, "")
    if not key or not token:
        return None
    return {"key": key, "token": token}


def _request(method: str, path: str, account: str,
             params: dict | None = None, json_body: dict | None = None) -> Any:
    auth = _auth(account)
    if not auth:
        raise PermissionError(
            f"Trello credentials for account '{account}' not set in ~/.hermes/.env"
        )
    with httpx.Client(timeout=20) as client:
        r = client.request(
            method, f"{TRELLO_API}{path}",
            params={**auth, **(params or {})},
            json=json_body,
        )
        r.raise_for_status()
        return r.json() if r.text else {}


# ---------------------------------------------------------------------------
# Resolvers: name → id
# ---------------------------------------------------------------------------

def _resolve_board(board: str, account: str) -> str | None:
    if not board:
        return None
    if _ID_RE.match(board):
        return board
    boards = _request("GET", "/members/me/boards", account,
                      {"fields": "name", "filter": "open"})
    low = board.lower()
    for b in boards:
        if low in b["name"].lower():
            return b["id"]
    return None


def _resolve_list(list_name: str, board_id: str, account: str) -> str | None:
    if not list_name:
        return None
    if _ID_RE.match(list_name):
        return list_name
    lists = _request("GET", f"/boards/{board_id}/lists", account, {"filter": "open"})

    def _norm(s: str) -> str:  # case- and space-insensitive ("Todo" == "To Do")
        return "".join((s or "").lower().split())

    low = list_name.lower()
    target = _norm(list_name)
    # 1) exact (normalised) match, 2) substring fallback
    for l in lists:
        if _norm(l["name"]) == target:
            return l["id"]
    for l in lists:
        if low in l["name"].lower() or target in _norm(l["name"]):
            return l["id"]
    return None


def _resolve_card(card: str, board_id: str, account: str) -> str | None:
    if not card:
        return None
    if _ID_RE.match(card):
        return card
    cards = _request("GET", f"/boards/{board_id}/cards", account,
                     {"fields": "name", "filter": "open"})
    low = card.lower()
    for c in cards:
        if low in c["name"].lower():
            return c["id"]
    return None


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def list_boards(account: str = "default") -> dict[str, Any]:
    boards = _request("GET", "/members/me/boards", account,
                      {"fields": "name,url", "filter": "open"})
    return {"boards": [{"id": b["id"], "name": b["name"], "url": b.get("url", "")}
                       for b in boards]}


def list_lists(board: str, account: str = "default") -> dict[str, Any]:
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    lists = _request("GET", f"/boards/{board_id}/lists", account, {"filter": "open"})
    return {"board_id": board_id,
            "lists": [{"id": l["id"], "name": l["name"]} for l in lists]}


def list_cards(board: str, list_name: str | None = None,
               account: str = "default") -> dict[str, Any]:
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    if list_name:
        list_id = _resolve_list(list_name, board_id, account)
        if not list_id:
            return {"error": f"list ไม่พบ: '{list_name}'"}
        cards = _request("GET", f"/lists/{list_id}/cards", account,
                         {"fields": "name,due,idList,labels"})
    else:
        cards = _request("GET", f"/boards/{board_id}/cards", account,
                         {"fields": "name,due,idList,labels", "filter": "open"})
    items = [{"id": c["id"], "name": c["name"],
              "due": (c.get("due") or "")[:10], "list_id": c["idList"],
              "subject": ", ".join(l.get("name", "") for l in c.get("labels", []) if l.get("name")),
              "header": _is_header(c)} for c in cards]
    real = [c for c in items if not c["header"]]
    return {
        "board_id": board_id,
        "count": len(items),
        "real_count": len(real),
        "header_count": len(items) - len(real),
        "note": "header=true คือการ์ดหัวข้อประจำลิสต์ (placeholder) ไม่ใช่งานจริง — "
                "ปกติอย่านับเป็นงาน",
        "cards": items,
    }


def card_detail(card: str, board: str, account: str = "default") -> dict[str, Any]:
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    card_id = _resolve_card(card, board_id, account)
    if not card_id:
        return {"error": f"card ไม่พบ: '{card}'"}
    c = _request("GET", f"/cards/{card_id}", account,
                 {"fields": "name,desc,due,url,idList,closed"})
    atts = _request("GET", f"/cards/{card_id}/attachments", account)
    return {
        "id": c["id"], "name": c["name"], "desc": c.get("desc", ""),
        "due": (c.get("due") or "")[:10], "url": c.get("url", ""),
        "closed": c.get("closed", False),
        "attachments": [{"name": a.get("name"), "url": a.get("url")} for a in atts],
    }


_LABEL_COLORS = ["green", "yellow", "orange", "red", "purple", "blue",
                 "sky", "lime", "pink", "black"]


def _current_course_names() -> set:
    """Normalized names of the CURRENT term's Classroom courses (from the local
    mirror; the sync prunes old terms). Used to break ties when several board
    labels match a subject — last-year course labels lose. Empty set if the
    mirror is missing (fail open)."""
    try:
        import sqlite3
        db = Path(os.getenv("CLASSROOM_DB_PATH") or
                  (Path.home() / ".hermes" / "data" / "classroom.db"))
        if not db.exists():
            return set()
        conn = sqlite3.connect(str(db))
        names = {"".join((r[0] or "").split()).lower()
                 for r in conn.execute("SELECT name FROM courses")}
        conn.close()
        return names
    except Exception:
        return set()


def _ensure_label(board_id: str, label_name: str, account: str) -> str | None:
    """Return the id of the board label for ``label_name``.

    Prefers an EXISTING label: exact match first, then fuzzy containment
    (normalized, spaces stripped) — so a subject like "ประวัติศาสตร์" reuses the
    full course label "ประวัติศาสตร์ ม.2/523" already on the board instead of
    spawning a duplicate short label. Creates a new label only when nothing
    matches at all.
    """
    name = (label_name or "").strip()
    if not name:
        return None
    labels = _request("GET", f"/boards/{board_id}/labels", account,
                      {"fields": "name", "limit": "1000"})

    def _norm(s: str) -> str:
        return "".join((s or "").split()).lower()

    target = _norm(name)
    # 1) exact (normalized)
    for lab in labels:
        if _norm(lab.get("name")) == target:
            return lab["id"]
    # 2) containment matches (either direction). The board still carries
    #    last-year course labels, so prefer candidates whose name is a CURRENT
    #    Classroom course (classroom.db only holds the current term); among
    #    those (or as fallback), prefer the longest/most specific name.
    current = _current_course_names()
    candidates = []
    for lab in labels:
        ln = _norm(lab.get("name"))
        if ln and (target in ln or ln in target):
            candidates.append(lab)
    if candidates:
        cur = [l for l in candidates if _norm(l.get("name")) in current]
        pool = cur or candidates
        best = max(pool, key=lambda l: len(_norm(l.get("name"))))
        return best["id"]
    color = _LABEL_COLORS[sum(map(ord, name)) % len(_LABEL_COLORS)]
    created = _request("POST", "/labels", account,
                       json_body={"name": name, "color": color, "idBoard": board_id})
    return created.get("id")


def list_labels(board: str, account: str = "default") -> dict[str, Any]:
    """List the board's labels — lets the agent pick the right existing
    subject/course label before creating cards."""
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    labels = _request("GET", f"/boards/{board_id}/labels", account,
                      {"fields": "name,color", "limit": "1000"})
    return {"labels": [l.get("name") for l in labels if l.get("name")]}


def create_card(board: str, list_name: str, name: str,
                desc: str | None = None, due: str | None = None,
                label: str | None = None,
                account: str = "default") -> dict[str, Any]:
    if not name:
        return {"error": "ต้องระบุชื่อ card (name)"}
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    list_id = _resolve_list(list_name, board_id, account)
    if not list_id:
        return {"error": f"list ไม่พบ: '{list_name}'"}
    body: dict[str, Any] = {"idList": list_id, "name": name}
    if desc:
        body["desc"] = desc
    if due:
        body["due"] = due
    # Models often forget the optional ``label`` arg; recover the subject from a
    # "วิชา: <name>" / "subject: <name>" line in the description so homework cards
    # still get subject-coloured.
    _subject = None
    if desc:
        m = re.search(r'(?:วิชา|subject)\s*[:：]\s*([^\n]+)', desc, re.IGNORECASE)
        if m:
            _subject = m.group(1).strip()
    if not label and _subject:
        label = _subject
    # Cards captured from a homework PHOTO (the flow stamps "จากกระดาน" in the
    # desc) get a "(Homework) " title prefix so they're recognizable on the
    # board. Other cards (Classroom sync, manual) are left untouched.
    if desc and "จากกระดาน" in desc and not name.lower().startswith("(homework"):
        name = f"(Homework) {name}"
        body["name"] = name
    c = _request("POST", "/cards", account, json_body=body)
    attached = None
    if label:
        lid = _ensure_label(board_id, label, account)
        if lid:
            # idLabels in the create body is unreliable; attach via the
            # dedicated endpoint after the card exists (value goes in the query).
            _request("POST", f"/cards/{c['id']}/idLabels", account, {"value": lid})
            attached = label
    return {"created": True, "id": c["id"], "name": c["name"],
            "url": c.get("url", ""), "label": attached}


def create_cards(board: str, items: list, account: str = "default") -> dict[str, Any]:
    """Batch-create several cards in ONE call. ``items`` is a list of dicts:
    {list, name, desc?, due?, label?}. Lets the agent add many homework cards
    with a single tool call (avoids emitting many separate tool calls)."""
    if isinstance(items, str):  # some models pass the array as a JSON string
        try:
            items = json.loads(items)
        except Exception:
            return {"error": "items must be a JSON list of {list,name,desc,due,label}"}
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list) or not items:
        return {"error": f"items must be a non-empty list of {{list,name,desc,due,label}} — got {type(items).__name__}: {str(items)[:300]}"}
    results = []
    for it in items:
        if not isinstance(it, dict):
            results.append({"error": f"bad item: {it!r}"})
            continue
        results.append(create_card(
            board, it.get("list", ""), it.get("name", ""),
            it.get("desc"), it.get("due"), it.get("label"), account,
        ))
    return {"created_count": sum(1 for r in results if r.get("created")),
            "total": len(items), "results": results}


def move_card(card: str, list_name: str, board: str,
              account: str = "default") -> dict[str, Any]:
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    card_id = _resolve_card(card, board_id, account)
    if not card_id:
        return {"error": f"card ไม่พบ: '{card}'"}
    list_id = _resolve_list(list_name, board_id, account)
    if not list_id:
        return {"error": f"list ปลายทางไม่พบ: '{list_name}'"}
    c = _request("PUT", f"/cards/{card_id}", account, json_body={"idList": list_id})
    return {"moved": True, "id": c["id"], "name": c["name"], "to_list": list_name}


def archive_card(card: str, board: str, account: str = "default") -> dict[str, Any]:
    board_id = _resolve_board(board, account)
    if not board_id:
        return {"error": f"board ไม่พบ: '{board}'"}
    card_id = _resolve_card(card, board_id, account)
    if not card_id:
        return {"error": f"card ไม่พบ: '{card}'"}
    c = _request("PUT", f"/cards/{card_id}", account, json_body={"closed": True})
    return {"archived": True, "id": c["id"], "name": c["name"]}


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def trello_tool(action: str, **kwargs) -> dict[str, Any]:
    account = (kwargs.get("account") or "default").strip().lower()
    if account not in _ACCOUNTS:
        account = "default"
    try:
        if action == "boards":
            return list_boards(account)
        if action == "lists":
            return list_lists(kwargs.get("board", ""), account)
        if action == "cards":
            return list_cards(kwargs.get("board", ""), kwargs.get("list"), account)
        if action == "labels":
            return list_labels(kwargs.get("board", ""), account)
        if action == "card_detail":
            return card_detail(kwargs.get("card", ""), kwargs.get("board", ""), account)
        if action == "create_card":
            return create_card(kwargs.get("board", ""), kwargs.get("list", ""),
                               kwargs.get("name", ""), kwargs.get("desc"),
                               kwargs.get("due"), kwargs.get("label"), account)
        if action == "create_cards":
            return create_cards(kwargs.get("board", ""), kwargs.get("items") or [], account)
        if action == "move_card":
            return move_card(kwargs.get("card", ""), kwargs.get("list", ""),
                             kwargs.get("board", ""), account)
        if action == "archive_card":
            return archive_card(kwargs.get("card", ""), kwargs.get("board", ""), account)
        return {"error": f"action ไม่รู้จัก: {action}",
                "allowed": ["boards", "lists", "cards", "card_detail",
                            "create_card", "move_card", "archive_card"]}
    except PermissionError as e:
        return {"error": str(e)}
    except httpx.HTTPStatusError as e:
        return {"error": f"Trello API {e.response.status_code}: {e.response.text[:200]}"}
    except httpx.HTTPError as e:
        return {"error": f"Trello request failed: {e}"}


TRELLO_SCHEMA = {
    "name": "trello",
    "description": (
        "Manage the family's Trello board (view/create/move/archive cards). "
        "Use when the user asks about Trello, การ์ด, บอร์ด, list งาน, "
        "ย้าย/เพิ่ม/ลบการ์ด. Pass board/list/card by name — IDs are resolved "
        "automatically. 'archive_card' removes a card from the board (recoverable)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["boards", "lists", "cards", "labels", "card_detail",
                         "create_card", "move_card", "archive_card"],
                "description": (
                    "boards: list all boards. "
                    "lists: list the columns of a board. "
                    "cards: list cards on a board (optionally one list). Each card "
                    "has header=true/false — header cards are per-list placeholders "
                    "(not real tasks); use real_count for the actual task count. "
                    "card_detail: full desc + attachments for one card. "
                    "create_card: add a card to a list. "
                    "move_card: move a card to another list. "
                    "archive_card: remove a card from the board (reversible)."
                ),
            },
            "board": {"type": "string", "description": "Board name or ID (e.g. 'PDS')."},
            "list": {"type": "string", "description": "List/column name or ID."},
            "card": {"type": "string", "description": "Card name or ID (for detail/move/archive)."},
            "name": {"type": "string", "description": "Card title (for create_card)."},
            "desc": {"type": "string", "description": "Card description (optional, create_card)."},
            "due": {"type": "string", "description": "Due date YYYY-MM-DD or ISO (optional, create_card)."},
            "label": {"type": "string", "description": "Label to tag the card with — ALWAYS set this to the subject/course name (ชื่อวิชา) when creating a homework/assignment card, so the board stays color-coded by subject. The label is auto-created if it doesn't exist yet. Example: label='ประวัติศาสตร์'."},
            "account": {
                "type": "string",
                "enum": ["default", "personal"],
                "description": "Which Trello credentials to use. Default 'default'.",
            },
        },
        "required": ["action"],
    },
}


# Self-register on import (same pattern as classroom_tool).
from tools.registry import registry  # noqa: E402

registry.register(
    name="trello",
    toolset="trello",
    schema=TRELLO_SCHEMA,
    handler=lambda args, **kw: trello_tool(
        args.get("action", ""),
        board=args.get("board"),
        list=args.get("list"),
        card=args.get("card"),
        name=args.get("name"),
        desc=args.get("desc"),
        due=args.get("due"),
        account=args.get("account"),
    ),
    emoji="📋",
    description="Manage the family's Trello board (view/create/move/archive cards).",
)
