#!/usr/bin/env bash
# archive-project.sh — moves a project and all its agent instances to _archive/
# Usage: bash scripts/archive-project.sh <project> [reason]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <project> [reason]"
  exit 1
fi

PROJECT="$1"
REASON="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT/projects/$PROJECT"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "ERROR: Project '$PROJECT' not found at $PROJECT_DIR"
  exit 1
fi

DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Find all agent instances for this project
INSTANCES=()
while IFS= read -r path; do
  INSTANCES+=("$path")
done < <(find "$ROOT" -type d -path "*/projects/$PROJECT" -not -path "*/_template/*" -not -path "*/_archive/*" 2>/dev/null | grep -v "^$ROOT/projects/$PROJECT$" || true)

# Determine archive suffix (handle same-day re-archiving)
SUFFIX="$DATE"
COUNTER=2
while [ -d "$ROOT/_archive/projects/$PROJECT-$SUFFIX" ]; do
  SUFFIX="$DATE-$COUNTER"
  COUNTER=$((COUNTER + 1))
done

echo "Archiving project: $PROJECT (suffix: $SUFFIX)"

# Create archive root
mkdir -p "$ROOT/_archive/projects"

# Move project root
mv "$PROJECT_DIR" "$ROOT/_archive/projects/$PROJECT-$SUFFIX"
echo "  Moved: projects/$PROJECT/  →  _archive/projects/$PROJECT-$SUFFIX/"

# Move each instance
for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"
  PARENT_DIR=$(dirname "$REL")
  ARCHIVE_PARENT="$ROOT/_archive/$PARENT_DIR"
  mkdir -p "$ARCHIVE_PARENT"
  mv "$inst" "$ARCHIVE_PARENT/$PROJECT-$SUFFIX"
  echo "  Moved: $REL/  →  _archive/$PARENT_DIR/$PROJECT-$SUFFIX/"
done

# Write ARCHIVED.md
cat > "$ROOT/_archive/projects/$PROJECT-$SUFFIX/ARCHIVED.md" << EOF
---
archived_at: $TIMESTAMP
project: $PROJECT
archive_suffix: $SUFFIX
reason: ${REASON:-(not specified)}
---

# Archived: $PROJECT

## Paths archived
- _archive/projects/$PROJECT-$SUFFIX/  (project root)
$(for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"
  PARENT_DIR=$(dirname "$REL")
  echo "- _archive/$PARENT_DIR/$PROJECT-$SUFFIX/  (instance)"
done)

## To restore
\`\`\`bash
bash scripts/unarchive-project.sh $PROJECT $SUFFIX
\`\`\`
EOF

# Operation log
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
{
  echo ""
  echo "## $TIMESTAMP — archive-project: $PROJECT"
  echo "Suffix: $SUFFIX"
  echo "Instances archived: ${#INSTANCES[@]}"
  [ -n "$REASON" ] && echo "Reason: $REASON"
} >> "$LOG_FILE"

echo ""
echo "✓ Archive complete."
echo "  ARCHIVED.md: $ROOT/_archive/projects/$PROJECT-$SUFFIX/ARCHIVED.md"
echo "  Operation log: $LOG_FILE"
