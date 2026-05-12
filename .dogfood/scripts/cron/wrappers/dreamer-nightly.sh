#!/usr/bin/env bash
# Cron wrapper for: dreamer-nightly
# Runs the global dreamer agent across all projects, drafts lesson candidates,
# routes through Slack HITL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG_DIR="$ROOT/logs/cron"
LOG_FILE="$LOG_DIR/dreamer-nightly-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

if [ -f "$ROOT/.env" ]; then
  set -a
  source "$ROOT/.env"
  set +a
fi

# Dreamer crawls everything; cd to root.
cd "$ROOT"

PROMPT_FILE="$ROOT/scripts/cron/wrappers/dreamer-nightly-prompt.txt"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file missing at $PROMPT_FILE" >&2
  exit 1
fi

echo "[$(date -u +%FT%TZ)] Starting dreamer-nightly" >> "$LOG_FILE"

claude -p "$(cat "$PROMPT_FILE")" >> "$LOG_FILE" 2>&1

EXIT_CODE=$?

echo "[$(date -u +%FT%TZ)] Finished dreamer-nightly with exit $EXIT_CODE" >> "$LOG_FILE"

exit $EXIT_CODE
