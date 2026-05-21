#!/usr/bin/env bash
# save-state.sh — write workspace state.md
#
# In v1, workspace = project. state.md lives at workspace root.
# Format: see conventions.md § "State file format". Normally Claude writes
# state.md directly when asked. This script exists for external invocation
# or scripted updates.
#
# Usage: bash scripts/save-state.sh "<state notes (multiline OK)>"

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"<state notes>\""
  exit 1
fi

NOTES="$*"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$ROOT/state.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$STATE_FILE" << EOF
---
updated: $TIMESTAMP
---

$NOTES
EOF

echo "✓ Saved workspace state"
echo "  $STATE_FILE"
