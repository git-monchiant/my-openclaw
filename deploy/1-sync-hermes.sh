#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# 1-sync-hermes.sh — RUN ON THE MACBOOK (source of truth).
# Ships ~/.hermes (secrets + state, NOT in git) → Mac Studio, overwriting.
# Code goes separately via git push/pull; this handles only ~/.hermes.
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

STUDIO="${STUDIO:-monchiant@192.168.1.100}"

# The local gateway MUST be stopped so sqlite (classroom.db/state.db/sessions)
# is copied in a consistent state and no stale lock/pid is shipped.
if pgrep -f "hermes gateway" >/dev/null 2>&1; then
  echo "❌ local gateway still running — stop it first:  hermes gateway stop"
  exit 1
fi

echo "→ rsync ~/.hermes → ${STUDIO}:~/.hermes  (overwrite)"
rsync -a --delete \
  --exclude 'gateway.lock' --exclude 'gateway.pid' --exclude 'gateway_state.json' \
  --exclude 'auth.lock' \
  --exclude 'logs/' --exclude 'cache/' --exclude 'image_cache/' \
  --exclude 'audio_cache/' --exclude 'sandboxes/' --exclude 'cron/output/' \
  --exclude 'models_dev_cache.json' --exclude '.DS_Store' \
  "$HOME/.hermes/" "${STUDIO}:.hermes/"

echo "✓ ~/.hermes synced to ${STUDIO}"
echo "  next → on Studio:  cd ~/my-projects/family-bot && git pull && bash deploy/2-studio-setup.sh"
