#!/usr/bin/env bash
# unarchive-project.sh — restores a project and its instances from _archive/
# Usage: bash scripts/unarchive-project.sh <project> [archive-suffix]
#
# If archive-suffix not provided, lists matching archives and asks user to specify.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <project> [archive-suffix]"
  exit 1
fi

PROJECT="$1"
SUFFIX="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE_PROJECTS="$ROOT/_archive/projects"

if [ ! -d "$ARCHIVE_PROJECTS" ]; then
  echo "ERROR: No archive directory exists. Nothing to restore."
  exit 1
fi

# Find matching archive(s)
MATCHES=()
while IFS= read -r path; do
  MATCHES+=("$path")
done < <(find "$ARCHIVE_PROJECTS" -maxdepth 1 -type d -name "$PROJECT-*" 2>/dev/null | sort)

if [ ${#MATCHES[@]} -eq 0 ]; then
  echo "ERROR: No archived project matches '$PROJECT-*' in $ARCHIVE_PROJECTS"
  exit 1
fi

# Determine which archive to restore
if [ -n "$SUFFIX" ]; then
  ARCHIVE_DIR="$ARCHIVE_PROJECTS/$PROJECT-$SUFFIX"
  if [ ! -d "$ARCHIVE_DIR" ]; then
    echo "ERROR: No archive at $ARCHIVE_DIR"
    echo "Available archives matching $PROJECT-*:"
    for m in "${MATCHES[@]}"; do
      echo "  - $(basename "$m")"
    done
    exit 1
  fi
else
  if [ ${#MATCHES[@]} -gt 1 ]; then
    echo "Multiple archives match. Specify which to restore:"
    for m in "${MATCHES[@]}"; do
      SUFFIX_FROM_NAME="${m##*/$PROJECT-}"
      echo "  bash $0 $PROJECT $SUFFIX_FROM_NAME"
    done
    exit 1
  fi
  ARCHIVE_DIR="${MATCHES[0]}"
  SUFFIX="${ARCHIVE_DIR##*/$PROJECT-}"
fi

# Check live collision
if [ -d "$ROOT/projects/$PROJECT" ]; then
  echo "ERROR: A live project already exists at projects/$PROJECT/. Cannot restore over it."
  echo "Either rename or archive the existing one first."
  exit 1
fi

# Find archived instances
INSTANCES=()
while IFS= read -r path; do
  INSTANCES+=("$path")
done < <(find "$ROOT/_archive" -type d -path "*/projects/$PROJECT-$SUFFIX" -not -path "*/projects/$PROJECT-$SUFFIX/projects/*" 2>/dev/null | grep -v "^$ARCHIVE_DIR$" || true)

# Check for collisions on each instance's live destination
for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/_archive/}"
  PARENT="${REL%/projects/$PROJECT-$SUFFIX}"
  LIVE_INSTANCE="$ROOT/$PARENT/projects/$PROJECT"
  if [ -d "$LIVE_INSTANCE" ]; then
    echo "ERROR: Live instance already exists at $PARENT/projects/$PROJECT/. Cannot restore over it."
    exit 1
  fi
done

echo "Restoring: $PROJECT (from suffix: $SUFFIX)"

# Restore project root
mv "$ARCHIVE_DIR" "$ROOT/projects/$PROJECT"
# Remove ARCHIVED.md (no longer applicable in live state)
rm -f "$ROOT/projects/$PROJECT/ARCHIVED.md"
echo "  Restored: _archive/projects/$PROJECT-$SUFFIX/  →  projects/$PROJECT/"

# Restore instances
for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/_archive/}"
  PARENT="${REL%/projects/$PROJECT-$SUFFIX}"
  LIVE_INSTANCE="$ROOT/$PARENT/projects/$PROJECT"
  mkdir -p "$ROOT/$PARENT/projects"
  mv "$inst" "$LIVE_INSTANCE"
  echo "  Restored: _archive/$REL/  →  $PARENT/projects/$PROJECT/"
done

# Operation log
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
{
  echo ""
  echo "## $TIMESTAMP — unarchive-project: $PROJECT"
  echo "From suffix: $SUFFIX"
  echo "Instances restored: ${#INSTANCES[@]}"
} >> "$LOG_FILE"

echo ""
echo "✓ Restore complete."
echo "  Operation log: $LOG_FILE"
