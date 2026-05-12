#!/usr/bin/env bash
# remove-agent-from-project.sh — archives a single agent instance from a project
# Usage: bash scripts/remove-agent-from-project.sh <project> <function> <agent>

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <project> <function> <agent>"
  exit 1
fi

PROJECT="$1"
FN="$2"
AGENT="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTANCE_DIR="$ROOT/$FN/$AGENT/projects/$PROJECT"

if [ ! -d "$INSTANCE_DIR" ]; then
  echo "ERROR: Instance not found at $INSTANCE_DIR"
  exit 1
fi

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Determine archive suffix
SUFFIX="$DATE"
COUNTER=2
while [ -d "$ROOT/_archive/$FN/$AGENT/projects/$PROJECT-$SUFFIX" ]; do
  SUFFIX="$DATE-$COUNTER"
  COUNTER=$((COUNTER + 1))
done

echo "Removing instance: $FN/$AGENT/projects/$PROJECT (archiving with suffix $SUFFIX)"

mkdir -p "$ROOT/_archive/$FN/$AGENT/projects"
mv "$INSTANCE_DIR" "$ROOT/_archive/$FN/$AGENT/projects/$PROJECT-$SUFFIX"
echo "  Moved: $FN/$AGENT/projects/$PROJECT/  →  _archive/$FN/$AGENT/projects/$PROJECT-$SUFFIX/"

# Update project CLAUDE.md — remove the line referencing this instance
PROJECT_CLAUDE="$ROOT/projects/$PROJECT/CLAUDE.md"
if [ -f "$PROJECT_CLAUDE" ]; then
  # Remove lines that reference the removed instance under "Active agent instances"
  # Match patterns like "- `gtm/sdr/projects/<project>/` — ..."
  SED_INPLACE=(-i)
  if [[ "$(uname)" == "Darwin" ]]; then
    SED_INPLACE=(-i '')
  fi
  sed "${SED_INPLACE[@]}" "/^- \`$FN\/$AGENT\/projects\/$PROJECT\//d" "$PROJECT_CLAUDE"
  echo "  Updated: projects/$PROJECT/CLAUDE.md (removed instance line)"
fi

# Operation log
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
{
  echo ""
  echo "## $TIMESTAMP — remove-agent-from-project"
  echo "Project: $PROJECT, Agent: $FN/$AGENT"
  echo "Archive suffix: $SUFFIX"
} >> "$LOG_FILE"

echo ""
echo "✓ Instance removed (archived)."
echo "  To restore: move _archive/$FN/$AGENT/projects/$PROJECT-$SUFFIX back to $FN/$AGENT/projects/$PROJECT"
echo "  Operation log: $LOG_FILE"
