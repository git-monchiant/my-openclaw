#!/usr/bin/env python3
"""worldcup — authoritative FIFA World Cup 2026 fixtures for the family bot.

Why this exists: the LLM repeatedly answered World Cup questions from its
TRAINING MEMORY (2022 fixtures — "เนเธอร์แลนด์-อาร์เจนตินา เมสซี่จุดโทษ") even
under hard prompt rules. Correctness is therefore moved into code: this tool
fetches the live Thai schedule page, parses every fixture, and computes
played/LIVE/upcoming status deterministically from the configured timezone
clock. The model's only job is wording the result.

Source: trueid's "โปรแกรมบอลโลก 2026 ครบทุกคู่" page — full schedule, Thai
kickoff times, results filled in as matches finish.
"""

from __future__ import annotations

import html as _html
import re
from datetime import date, datetime, timedelta
from typing import Any

import httpx

from hermes_time import now as _now

SCHEDULE_URL = "https://sport.trueid.net/detail/7WNNEqOYMRGW"
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
# a football match (incl. halftime + stoppage) ~ 2h15m
_MATCH_DURATION = timedelta(hours=2, minutes=15)

_THAI_MONTHS = {
    "มกราคม": 1, "กุมภาพันธ์": 2, "มีนาคม": 3, "เมษายน": 4,
    "พฤษภาคม": 5, "มิถุนายน": 6, "กรกฎาคม": 7, "สิงหาคม": 8,
    "กันยายน": 9, "ตุลาคม": 10, "พฤศจิกายน": 11, "ธันวาคม": 12,
}

# "ฟุตบอลโลก 2026 : คืนวันพฤหัสบดีที่ 11 มิถุนายน 2569" → date header
_DAY_RE = re.compile(r"ฟุตบอลโลก 2026\s*:\s*(?:คืน)?วัน\S+ที่\s*(\d{1,2})\s+(\S+)\s+(\d{4})")
# "02.00 น. | กลุ่ม A | เม็กซิโก 2-0 แอฟริกาใต้"  /  "... | แคนาดา - บอสเนีย"
_MATCH_RE = re.compile(
    r"(\d{1,2})\.(\d{2})\s*น\.\s*\|\s*([^|]+?)\s*\|\s*(.+?)(?=\s*\d{1,2}\.\d{2}\s*น\.\s*\||\s*ฟุตบอลโลก 2026|\Z)"
)
_SCORE_RE = re.compile(r"^(.*?)\s+(\d+)\s*-\s*(\d+)\s+(.*)$")
_VS_RE = re.compile(r"^(.*?)\s+-\s+(.*)$")


def _fetch_schedule_text() -> str:
    r = httpx.get(SCHEDULE_URL, timeout=25, follow_redirects=True,
                  headers={"User-Agent": _UA})
    r.raise_for_status()
    s = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", r.text)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", _html.unescape(s))


def _parse(text: str) -> list[dict]:
    """Return every fixture as {date, time, stage, home, away, score}."""
    fixtures: list[dict] = []
    day_iter = list(_DAY_RE.finditer(text))
    for i, dm in enumerate(day_iter):
        day, mon_name, yr_be = int(dm.group(1)), dm.group(2), int(dm.group(3))
        mon = _THAI_MONTHS.get(mon_name)
        if not mon:
            continue
        d = date(yr_be - 543 if yr_be > 2400 else yr_be, mon, day)
        seg_end = day_iter[i + 1].start() if i + 1 < len(day_iter) else len(text)
        seg = text[dm.end():seg_end]
        for mm in _MATCH_RE.finditer(seg):
            hh, mins, stage, rest = int(mm.group(1)), int(mm.group(2)), mm.group(3).strip(), mm.group(4).strip()
            sc = _SCORE_RE.match(rest)
            if sc:
                home, hs, as_, away = sc.group(1).strip(), int(sc.group(2)), int(sc.group(3)), sc.group(4).strip()
                score = f"{hs}-{as_}"
            else:
                vs = _VS_RE.match(rest)
                if not vs:
                    continue
                home, away, score = vs.group(1).strip(), vs.group(2).strip(), None
            fixtures.append({"date": d, "hh": hh, "mm": mins, "stage": stage,
                             "home": home, "away": away, "score": score})
    return fixtures


def _status(fx: dict, now: datetime) -> tuple[str, str]:
    """Return (status, note) computed from the clock — never from the LLM."""
    ko = datetime(fx["date"].year, fx["date"].month, fx["date"].day,
                  fx["hh"], fx["mm"], tzinfo=now.tzinfo)
    if now < ko:
        delta = ko - now
        hrs = int(delta.total_seconds() // 3600)
        note = f"อีก {hrs} ชม. {int(delta.total_seconds() % 3600 // 60)} นาที"
        return "upcoming", note
    if now < ko + _MATCH_DURATION:
        minute = int((now - ko).total_seconds() // 60)
        return "LIVE", f"น่าจะราวนาทีที่ {min(minute, 90)}+ (เริ่ม {fx['hh']:02d}:{fx['mm']:02d})"
    return "finished", ""


def worldcup_tool(action: str = "today", **kwargs) -> dict[str, Any]:
    try:
        fixtures = _parse(_fetch_schedule_text())
    except httpx.HTTPError as e:
        return {"error": f"โหลดตารางไม่สำเร็จ: {e}",
                "hint": "ลอง web_search 'โปรแกรมบอลโลก 2026' แล้ว fetch_page หน้าอื่นแทน"}
    if not fixtures:
        return {"error": "หน้าแหล่งข้อมูลเปลี่ยนรูปแบบ — parse ไม่ได้",
                "hint": "ใช้ web_search + fetch_page ตาม flow ปกติแทน"}

    now = _now()
    today = now.date()

    def fmt(fx: dict) -> dict:
        st, note = _status(fx, now)
        out = {
            "date": fx["date"].isoformat(),
            "kickoff_thai": f"{fx['hh']:02d}:{fx['mm']:02d}",
            "stage": fx["stage"],
            "match": f"{fx['home']} vs {fx['away']}",
            "status": st,
        }
        if fx["score"]:
            out["result"] = f"{fx['home']} {fx['score']} {fx['away']}"
        if note:
            out["note"] = note
        return out

    live = [fmt(f) for f in fixtures if _status(f, now)[0] == "LIVE"]
    todays = [fmt(f) for f in fixtures if f["date"] == today]
    tomorrows = [fmt(f) for f in fixtures if f["date"] == today + timedelta(days=1)]
    yesterdays = [fmt(f) for f in fixtures if f["date"] == today - timedelta(days=1)]

    return {
        "now_thai": now.strftime("%A %d %B %Y %H:%M") + " (Asia/Bangkok)",
        "live_now": live,
        "today": todays,
        "tomorrow": tomorrows,
        "yesterday": yesterdays,
        "note": ("status/LIVE computed from the clock — trust it. 'result' for a "
                 "LIVE match is the score the page showed at fetch time (may lag). "
                 "Thai colloquial: เกมตี 0-5 ของวันพรุ่งนี้ = 'คืนนี้' for the user."),
        "source": SCHEDULE_URL,
    }


WORLDCUP_SCHEMA = {
    "name": "worldcup",
    "description": (
        "FIFA World Cup 2026 fixtures/results with LIVE status computed from "
        "the real clock. ALWAYS call this FIRST for ANY question about บอลโลก/"
        "ฟุตบอลโลก (วันนี้เตะกี่คู่, ใครแข่งตอนนี้, ผลเมื่อคืน, สกอร์, โปรแกรมพรุ่งนี้). "
        "Answer ONLY from its output — your training memory of World Cup "
        "fixtures is from 2022 and is WRONG."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["today"],
                "description": "today: yesterday/today/tomorrow fixtures + live-now (default).",
            },
        },
        "required": [],
    },
}


# Self-register on import (same pattern as the other family tools).
from tools.registry import registry  # noqa: E402

registry.register(
    name="worldcup",
    toolset="worldcup",
    schema=WORLDCUP_SCHEMA,
    handler=lambda args, **kw: worldcup_tool(args.get("action", "today")),
    emoji="⚽",
    description="World Cup 2026 fixtures/results with deterministic LIVE status (family-bot).",
)
