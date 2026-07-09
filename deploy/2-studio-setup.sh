#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# 2-studio-setup.sh — RUN ON THE MAC STUDIO (prod).
# Builds the venv, installs the editable package, smoke-tests imports,
# then installs + loads a launchd agent that keeps the bot running 24/7
# (auto-start at login, auto-restart on crash). Idempotent — safe to re-run.
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$HOME/my-projects/family-bot"
LABEL="com.familybot.tt"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
cd "$REPO"

echo "=== 1) venv (python3.13) + editable install ==="
PY="$(command -v python3.13 || command -v python3)"
echo "using: $($PY --version)"
rm -rf .venv
"$PY" -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -e .

echo "=== 2) smoke test (imports + tool discovery + hermes) ==="
./.venv/bin/python -c "import model_tools, toolsets, cli; from tools.registry import discover_builtin_tools; discover_builtin_tools(); print('  imports OK')"
./.venv/bin/hermes --version

echo "=== 3) launchd agent (KeepAlive + RunAtLoad) ==="
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.hermes/logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${REPO}/run-tt.sh</string>
    </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/.hermes/logs/launchd-tt.out.log</string>
  <key>StandardErrorPath</key><string>${HOME}/.hermes/logs/launchd-tt.err.log</string>
</dict>
</plist>
PLISTEOF

echo "=== 4) (re)load agent — starts gateway + ngrok ==="
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo
echo "✓ deployed. logs: ~/.hermes/logs/launchd-tt.{out,err}.log"
echo "  health:  curl -s https://familybot.ngrok.app/line/webhook/health"
echo
echo "MANUAL (once, needs sudo/UI) so it truly runs 24/7:"
echo "  sudo pmset -a sleep 0 disksleep 0 autorestart 1"
echo "  System Settings → Users & Groups → enable Automatic login"
