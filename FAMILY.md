# Family-bot customizations

> These files are **family-bot customizations** layered on top of upstream **Hermes Agent**.
> Keep them in mind when merging upstream changes. The bot is the LINE bot **"TT^"** (homework / family assistant).
> Related: agent memory `family-bot-tools`, `family-bot-line-setup`, `classroom-homework-bot`.

Everything below is native Hermes (tools self-register into `src/tools/registry.py`; scripts run via the Hermes cron runner). Nothing here depends on the old `mybot`/`myclaw` project.

**Repo layout:** `src/` = Hermes python code only · `data/` = bundled data (skills, locales, assets, …) · `dev/` = tests/web-ui/dev scripts · `scripts/family/` = our cron-script sources. Path climbs in upstream code were patched accordingly (`parents[2]`-style; grep `parents[2]` to find them when merging upstream).

## Tools (`src/tools/*.py`)

Each self-registers via `tools.registry.registry.register(name=..., toolset=...)` and is auto-loaded by `discover_builtin_tools()` (globs `src/tools/*.py`).

| File | tool / toolset | Reads | Purpose |
|------|----------------|-------|---------|
| [src/tools/trello_tool.py](src/tools/trello_tool.py) | `trello` / `trello` | `TRELLO_API_KEY`,`TRELLO_API_TOKEN` (+ `TRELLO_PERSONAL_*`) | View/create/move/archive cards on board **PDS**. Cards with a subject **label** = real tasks; cards with no label = list headers (`header=true`, see `real_count`). |
| [src/tools/calendar_tool.py](src/tools/calendar_tool.py) | `calendar` / `calendar` | `GOOGLE_CLIENT_ID`,`GOOGLE_CLIENT_SECRET`,`GOOGLE_CALENDAR_REFRESH_TOKEN`,`GOOGLE_CALENDAR_IDS` | Read-only Google Calendar (API + OAuth). Limited to 2 calendars (ARRAY - PSP/PDS = เรียนพิเศษ, ARRAY - ฟุตบอล = บอล). Topic routing via `calendar=บอล`/`PSP`. |
| [src/tools/classroom_tool.py](src/tools/classroom_tool.py) | `classroom` / `classroom` | `CLASSROOM_DB_PATH` → `~/.hermes/data/classroom.db` | Query the local Google Classroom mirror (assignments, status, courses, teachers, announcements, materials). |
| [src/tools/fetch_page_tool.py](src/tools/fetch_page_tool.py) | `fetch_page` / `fetch_page` | — (plain HTTP) | Keyless full-page reader (replaces `web_extract`, whose backends all need paid keys). Paired with `web_search` (ddgs backend, free) for news/schedules. |

## Scripts (`scripts/*.py`)

`scripts/family/` here is the **source**. The Hermes cron runner executes the *deployed* copies in **`~/.hermes/scripts/`** (referenced by bare filename in `~/.hermes/cron/jobs.json`). After editing a cron script here, copy it to `~/.hermes/scripts/` (e.g. `cp scripts/family/classroom_sync.py ~/.hermes/scripts/`). `calendar_auth.py` is run manually from here (not cron).

| File | Cron job (schedule) | Purpose |
|------|---------------------|---------|
| [scripts/family/calendar_auth.py](scripts/family/calendar_auth.py) | — (one-time, manual) | OAuth bootstrap: mint `GOOGLE_CALENDAR_REFRESH_TOKEN` into `~/.hermes/.env` (loopback `http://localhost:8765/`). |
| [scripts/family/classroom_sync.py](scripts/family/classroom_sync.py) | `tt-classroom-sync` (`*/5 * * * *`) | Fetch Classroom via student Apps Script (`CLASSROOM_SCRIPT_URL`) → write `~/.hermes/data/classroom.db`. **Also pushes a LINE alert (stdout, no_agent) the moment a NEW coursework/announcement appears** — tracked once-only via the `seen_items` table (seeded silently on first run). |
| [scripts/family/classroom_reminder.py](scripts/family/classroom_reminder.py) | `tt-reminder-morning` (`0 7 * * *`), `tt-reminder-evening` (`0 18 * * *`) | Compact outstanding-work summary → TT^ pushes to LINE. |
| [scripts/family/classroom_trello_sync.py](scripts/family/classroom_trello_sync.py) | `tt-classroom-trello` (`0 */2 * * *`) | Turn `classroom.db` into cards on the Trello **PDS** board. |

## Wiring

- [src/toolsets.py](src/toolsets.py): `classroom` / `trello` / `calendar` toolset defs (marked `── family-bot tools ──`), and the **`hermes-line`** toolset (the LINE bot's default) lists all three + core helpers.
- [src/hermes_cli/tools_config.py](src/hermes_cli/tools_config.py): `classroom` label in the `hermes config` tools UI.

## Config & data (in `~/.hermes/`, NOT the repo)

- **`.env`** — `TRELLO_*`, `GOOGLE_CLIENT_ID/SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`, `GOOGLE_CALENDAR_IDS`, `CLASSROOM_SCRIPT_URL`, plus `LINE_*` (see [family-bot-line-setup]).
- **`data/classroom.db`** — Classroom mirror (built by `classroom_sync.py`).
- **`cron/jobs.json`** — the 4 cron jobs above.

## Runbook

- **Start the bot:** `./run-tt.sh` (auto ngrok `familybot.ngrok.app` → `:8646`, then `hermes gateway`). Restart after any `~/.hermes/.env` change (env is read at startup).
- **Calendar (Google API + OAuth):** OAuth app **must be in Production** — in "Testing" mode Google expires the refresh token after 7 days (root cause of past calendar breakage). Client = **Desktop** type, GCP project `290558054599`. Mint/refresh the token with `python scripts/family/calendar_auth.py`. Restricted to 2 calendars via `GOOGLE_CALENDAR_IDS`.
- **Classroom:** student deploys an Apps Script web app that returns their Classroom JSON; its URL goes in `CLASSROOM_SCRIPT_URL`; `classroom_sync.py` mirrors it to `classroom.db`.
- **Trello:** API key/token only (no OAuth). Board = **PDS**.
