#!/usr/bin/env python3
"""fetch_page — read a web page's text content with a plain HTTP GET.

Zero-dependency fallback for ``web_extract``: every real extract backend
(firecrawl/tavily/exa/parallel) needs a paid API key, which this install
doesn't have. Search snippets are truncated, which makes the agent fabricate
details (e.g. football fixtures); fetching the full page fixes that.

Strips <script>/<style> and all tags, collapses whitespace, and caps the
result so one page can't blow up the context window.
"""

from __future__ import annotations

import html as _html
import re
from typing import Any

import httpx

_MAX_CHARS = 12000
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _strip_html(raw: str) -> str:
    s = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", raw)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = _html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def fetch_page(url: str, find: str | None = None) -> dict[str, Any]:
    """Fetch one page as plain text.

    Args:
        url: http(s) URL to fetch.
        find: optional substring — when given, the returned excerpt is
            centered on its first occurrence (so the relevant section
            survives the length cap).
    """
    if not url or not url.startswith(("http://", "https://")):
        return {"error": f"URL ไม่ถูกต้อง: {url!r}"}
    try:
        r = httpx.get(url, timeout=25, follow_redirects=True,
                      headers={"User-Agent": _UA})
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        return {"error": f"HTTP {e.response.status_code} จาก {url}"}
    except httpx.HTTPError as e:
        return {"error": f"โหลดหน้าไม่สำเร็จ: {e}"}

    text = _strip_html(r.text)
    total = len(text)
    if find:
        i = text.find(find)
        if i >= 0:
            start = max(0, i - _MAX_CHARS // 4)
            text = text[start:start + _MAX_CHARS]
        else:
            text = text[:_MAX_CHARS]
    else:
        text = text[:_MAX_CHARS]

    return {
        "url": str(r.url),
        "total_chars": total,
        "truncated": total > len(text),
        "text": text,
    }


FETCH_PAGE_SCHEMA = {
    "name": "fetch_page",
    "description": (
        "Fetch a web page and return its FULL text content (HTML stripped). "
        "Use this after web_search whenever the snippets are not enough — "
        "schedules, fixtures (โปรแกรมบอล), tables, articles, prices. Search "
        "snippets are truncated; NEVER answer detailed list questions from "
        "snippets alone — fetch the page and answer from its actual content."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "The http(s) URL to fetch (from web_search results)."},
            "find": {
                "type": "string",
                "description": "Optional keyword (e.g. '12 มิถุนายน') — the returned text will be centered on it so the relevant section isn't cut off.",
            },
        },
        "required": ["url"],
    },
}


# Self-register on import (same pattern as trello_tool / calendar_tool).
from tools.registry import registry  # noqa: E402

registry.register(
    name="fetch_page",
    toolset="fetch_page",
    schema=FETCH_PAGE_SCHEMA,
    handler=lambda args, **kw: fetch_page(args.get("url", ""), args.get("find")),
    emoji="📄",
    description="Fetch a web page's full text (no-API-key web_extract fallback).",
)
