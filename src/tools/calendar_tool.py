#!/usr/bin/env python3
"""Calendar tool — read the family's Google Calendars via the Calendar v3 API.

Auth: OAuth user credentials (refresh-token grant). Set in ~/.hermes/.env:
    GOOGLE_CLIENT_ID
    GOOGLE_CLIENT_SECRET
    GOOGLE_CALENDAR_REFRESH_TOKEN     (mint once via scripts/family/calendar_auth.py)

Optional:
    GOOGLE_CALENDAR_IDS   comma-separated calendar IDs to restrict to; default
                          is every non-hidden calendar in the account.

Design intent:
  - One read-only action (list). The agent never deals with calendar IDs.
  - Topic routing: pass ``calendar`` to answer subject-specific questions —
    e.g. "ตารางบอล" → calendar="บอล", "เรียนพิเศษ" → calendar="เรียน". The
    filter is a case-insensitive substring on the calendar's display name.
  - Each event carries its source calendar name so the agent can say which
    schedule it came from when no filter is given.
  - Access tokens are refreshed on demand and cached in-process until expiry.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone, timedelta
from typing import Any
from urllib.parse import quote

import httpx

BKK = timezone(timedelta(hours=7))
TOKEN_URL = "https://oauth2.googleapis.com/token"
CAL_API = "https://www.googleapis.com/calendar/v3"

# In-process access-token cache: {"token": str, "exp": epoch_seconds}
_token_cache: dict[str, Any] = {}


def _oauth_conf() -> dict[str, str] | None:
    cid = os.getenv("GOOGLE_CLIENT_ID", "")
    csec = os.getenv("GOOGLE_CLIENT_SECRET", "")
    rtok = os.getenv("GOOGLE_CALENDAR_REFRESH_TOKEN", "")
    if not (cid and csec and rtok):
        return None
    return {"client_id": cid, "client_secret": csec, "refresh_token": rtok}


def _access_token() -> str | None:
    """Return a valid access token, refreshing via the refresh-token grant."""
    now = time.time()
    if _token_cache.get("token") and _token_cache.get("exp", 0) > now + 60:
        return _token_cache["token"]
    conf = _oauth_conf()
    if not conf:
        return None
    with httpx.Client(timeout=20) as c:
        r = c.post(TOKEN_URL, data={**conf, "grant_type": "refresh_token"})
    if r.status_code != 200:
        return None
    data = r.json()
    _token_cache["token"] = data["access_token"]
    _token_cache["exp"] = now + int(data.get("expires_in", 3600))
    return _token_cache["token"]


def _calendars(headers: dict, name_filter: str | None) -> list[dict]:
    """Resolve which calendars to read: env override, else all non-hidden;
    then narrow by name substring when a topic filter is given."""
    env_ids = [c.strip() for c in (os.getenv("GOOGLE_CALENDAR_IDS") or "").split(",") if c.strip()]
    with httpx.Client(timeout=20) as c:
        r = c.get(f"{CAL_API}/users/me/calendarList", headers=headers)
        r.raise_for_status()
        items = r.json().get("items", [])
    cals = [{"id": it["id"], "name": it.get("summary", it["id"])}
            for it in items if not it.get("hidden")]
    if env_ids:
        cals = [c for c in cals if c["id"] in env_ids]
    if name_filter:
        low = name_filter.lower()
        cals = [c for c in cals if low in c["name"].lower()]
    return cals


def list_events(days: int = 7, calendar: str | None = None) -> dict[str, Any]:
    """Fetch events for the next ``days`` days, optionally one topic calendar."""
    token = _access_token()
    if not token:
        return {"error": "Google Calendar ยังไม่ได้เชื่อม (หรือ token หมดอายุ) — "
                         "รัน `python scripts/family/calendar_auth.py` เพื่อขอสิทธิ์ใหม่"}
    headers = {"Authorization": f"Bearer {token}"}

    now = datetime.now(BKK)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=days)

    try:
        cals = _calendars(headers, calendar)
        events: list[dict] = []
        with httpx.Client(timeout=20) as c:
            for cal in cals:
                r = c.get(
                    f"{CAL_API}/calendars/{quote(cal['id'], safe='')}/events",
                    headers=headers,
                    params={
                        "timeMin": start.isoformat(),
                        "timeMax": end.isoformat(),
                        "singleEvents": "true",
                        "orderBy": "startTime",
                        "maxResults": 100,
                    },
                )
                if r.status_code != 200:
                    continue
                for ev in r.json().get("items", []):
                    s = ev.get("start", {})
                    e = ev.get("end", {})
                    events.append({
                        "calendar": cal["name"],
                        "title": ev.get("summary", "(ไม่มีชื่อ)"),
                        "start": s.get("dateTime") or s.get("date"),
                        "end": e.get("dateTime") or e.get("date"),
                        "all_day": "date" in s,
                        "location": ev.get("location", ""),
                    })
    except httpx.HTTPStatusError as e:
        return {"error": f"Calendar API {e.response.status_code}: {e.response.text[:200]}"}
    except httpx.HTTPError as e:
        return {"error": f"Calendar request failed: {e}"}

    events.sort(key=lambda x: x.get("start") or "")
    return {
        "count": len(events),
        "days": days,
        "filter": calendar or "(ทุกปฏิทิน)",
        "calendars_read": [c["name"] for c in cals],
        "events": events,
        "queried_at": now.isoformat(),
    }


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

def calendar_tool(action: str = "list", **kwargs) -> dict[str, Any]:
    if action == "list":
        try:
            days = int(kwargs.get("days") or 7)
        except (TypeError, ValueError):
            days = 7
        return list_events(days=days, calendar=kwargs.get("calendar"))
    return {"error": f"action ไม่รู้จัก: {action}", "allowed": ["list"]}


CALENDAR_SCHEMA = {
    "name": "calendar",
    "description": (
        "Read the family's Google Calendar schedule (e.g. the kid's tutoring and "
        "football calendars) via the Calendar API. Use when the user asks about "
        "ตาราง, นัด, วันไหน, ตารางบอล, เรียนพิเศษ, สัปดาห์นี้มีอะไร. The user may "
        "have several calendars — if the question is about a specific topic, pass "
        "``calendar`` with a word matching that calendar's name (e.g. 'บอล'/"
        "'ฟุตบอล' for football, 'เรียน'/'PSP'/'PDS' for the study calendar). Omit "
        "``calendar`` to see all; each event is tagged with its source calendar "
        "name. Read-only."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list"],
                "description": "list: upcoming events for the next N days.",
            },
            "days": {
                "type": "integer",
                "description": "How many days ahead to include (default 7).",
            },
            "calendar": {
                "type": "string",
                "description": (
                    "Optional topic filter: substring of the calendar name. "
                    "Use for subject-specific questions — 'บอล' for football, "
                    "'เรียน'/'PSP'/'PDS' for study. Omit for all calendars."
                ),
            },
        },
        "required": ["action"],
    },
}


# Self-register on import (same pattern as classroom_tool / trello_tool).
from tools.registry import registry  # noqa: E402

registry.register(
    name="calendar",
    toolset="calendar",
    schema=CALENDAR_SCHEMA,
    handler=lambda args, **kw: calendar_tool(
        action=args.get("action", "list"),
        days=args.get("days"),
        calendar=args.get("calendar"),
    ),
    emoji="📅",
    description="Read the family's Google Calendar schedules (tutoring, football, ...) via the Calendar API.",
)
