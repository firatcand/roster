#!/usr/bin/env bash
# save-state.sh — manual helper for updating a project's state.md
# Normally Claude writes state.md directly when you ask. This script exists
# for external invocation or scripted updates.
#
# Usage: bash scripts/save-state.sh <project> "<state notes (multiline OK)>"

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <project> \"<state notes>\""
  exit 1
fi

PROJECT="$1"
shift
NOTES="$*"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/projects/$PROJECT/state.md"

if [ ! -d "$ROOT/projects/$PROJECT" ]; then
  echo "ERROR: Project '$PROJECT' not found"
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$STATE_FILE" << EOF
---
updated: $TIMESTAMP
---

$NOTES
EOF

echo "✓ Saved state for $PROJECT"
echo "  $STATE_FILE"
