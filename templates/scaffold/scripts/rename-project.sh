#!/usr/bin/env bash
# rename-project.sh — renames a project everywhere it appears
# Usage: bash scripts/rename-project.sh <old> <new>

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <old> <new>"
  exit 1
fi

OLD="$1"
NEW="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Validate new slug
if ! [[ "$NEW" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: New slug must be lowercase, alphanumeric + hyphens, starting with a letter."
  exit 1
fi

# Validate old exists
if [ ! -d "$ROOT/projects/$OLD" ]; then
  echo "ERROR: Project '$OLD' not found at $ROOT/projects/$OLD"
  exit 1
fi

# Validate new doesn't exist (live or archived)
if [ -d "$ROOT/projects/$NEW" ]; then
  echo "ERROR: A project named '$NEW' already exists at $ROOT/projects/$NEW"
  exit 1
fi
if find "$ROOT/_archive" -maxdepth 3 -type d -name "$NEW-*" 2>/dev/null | grep -q .; then
  echo "ERROR: An archived project named '$NEW-*' exists. Cannot reuse the slug."
  echo "  Resolve by unarchiving and re-renaming the archived one, or pick another slug."
  exit 1
fi

# Find all instances
INSTANCES=()
while IFS= read -r path; do
  INSTANCES+=("$path")
done < <(find "$ROOT" -type d -path "*/projects/$OLD" -not -path "*/_template/*" -not -path "*/_archive/*" 2>/dev/null | grep -v "^$ROOT/projects/$OLD$" || true)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "Renaming project: $OLD → $NEW"

# Move project root
mv "$ROOT/projects/$OLD" "$ROOT/projects/$NEW"
echo "  Moved: projects/$OLD/  →  projects/$NEW/"

# Move each instance
for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"
  PARENT_DIR=$(dirname "$REL")
  mv "$inst" "$ROOT/$PARENT_DIR/$NEW"
  echo "  Moved: $REL/  →  $PARENT_DIR/$NEW/"
done

# Portable sed
SED_INPLACE=(-i)
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
fi

# Update content in project CLAUDE.md (replace project name where safe)
PROJECT_CLAUDE="$ROOT/projects/$NEW/CLAUDE.md"
if [ -f "$PROJECT_CLAUDE" ]; then
  # Capitalize-aware replace: match the slug as a whole word
  sed "${SED_INPLACE[@]}" "s/\\b$OLD\\b/$NEW/g" "$PROJECT_CLAUDE"
  echo "  Updated: projects/$NEW/CLAUDE.md"
fi

PROJECT_GUIDANCE="$ROOT/projects/$NEW/GUIDANCE.md"
if [ -f "$PROJECT_GUIDANCE" ]; then
  sed "${SED_INPLACE[@]}" "s/\\b$OLD\\b/$NEW/g" "$PROJECT_GUIDANCE"
  echo "  Updated: projects/$NEW/GUIDANCE.md"
fi

# Update each instance's config and asset-references
for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"
  PARENT_DIR=$(dirname "$REL")
  NEW_INSTANCE_DIR="$ROOT/$PARENT_DIR/$NEW"

  CONFIG="$NEW_INSTANCE_DIR/config/default.yaml"
  if [ -f "$CONFIG" ]; then
    sed "${SED_INPLACE[@]}" "s/^project: $OLD$/project: $NEW/" "$CONFIG"
    sed "${SED_INPLACE[@]}" "s/\\b$OLD\\b/$NEW/g" "$CONFIG"
    echo "  Updated: $PARENT_DIR/$NEW/config/default.yaml"
  fi

  ASSET_REFS="$NEW_INSTANCE_DIR/asset-references.md"
  if [ -f "$ASSET_REFS" ]; then
    sed "${SED_INPLACE[@]}" "s/\\b$OLD\\b/$NEW/g" "$ASSET_REFS"
    echo "  Updated: $PARENT_DIR/$NEW/asset-references.md"
  fi
done

# Surface other files that mention OLD but were NOT auto-updated (lessons, runs, feedback)
echo ""
echo "Files mentioning '$OLD' that were NOT auto-updated (review manually):"
grep -rln "\\b$OLD\\b" "$ROOT/projects/$NEW" "$ROOT"/*/*/projects/"$NEW" 2>/dev/null | grep -vE "(CLAUDE\.md|GUIDANCE\.md|config/default\.yaml|asset-references\.md)$" | sed "s|$ROOT/|  - |" || echo "  (none found)"

# Operation log
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
{
  echo ""
  echo "## $TIMESTAMP — rename-project: $OLD → $NEW"
  echo "Folders moved: 1 project + ${#INSTANCES[@]} instances"
} >> "$LOG_FILE"

echo ""
echo "✓ Rename complete."
echo "  Operation log: $LOG_FILE"
