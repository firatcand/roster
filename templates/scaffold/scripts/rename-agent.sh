#!/usr/bin/env bash
# rename-agent.sh — renames a global agent everywhere it appears
# Usage: bash scripts/rename-agent.sh <function> <old> <new>

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <function> <old> <new>"
  exit 1
fi

FN="$1"
OLD="$2"
NEW="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! [[ "$NEW" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: New slug must be lowercase, alphanumeric + hyphens, starting with a letter."
  exit 1
fi

OLD_DIR="$ROOT/$FN/$OLD"
NEW_DIR="$ROOT/$FN/$NEW"

if [ ! -d "$OLD_DIR" ]; then
  echo "ERROR: Agent '$FN/$OLD' not found at $OLD_DIR"
  exit 1
fi

if [ -d "$NEW_DIR" ]; then
  echo "ERROR: Agent '$FN/$NEW' already exists at $NEW_DIR"
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mv "$OLD_DIR" "$NEW_DIR"
echo "  Moved: $FN/$OLD/ → $FN/$NEW/"

SED_INPLACE=(-i)
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
fi

# Broad replace on prose files only — these are markdown stubs where the
# old slug appears in headings / paths and we want every reference updated.
for f in "$NEW_DIR"/agent.md "$NEW_DIR"/README.md "$NEW_DIR"/asset-references.md; do
  [ -f "$f" ] && sed "${SED_INPLACE[@]}" "s|$OLD|$NEW|g" "$f"
done

# config.yaml: only the identity field. A broad replace would corrupt env-var
# names, comments, and any value that legitimately contains $OLD.
CFG="$NEW_DIR/config.yaml"
if [ -f "$CFG" ]; then
  sed "${SED_INPLACE[@]}" "s|^agent: $FN/$OLD$|agent: $FN/$NEW|" "$CFG"
fi

while IFS= read -r f; do
  case "$f" in
    *"_archive/"*) continue ;;
    *"/logs/"*) continue ;;
    *"/log/runs/"*) continue ;;
    *"/log/feedback/"*) continue ;;
    *"/playbook/"*) continue ;;
    *) sed "${SED_INPLACE[@]}" "s|$FN/$OLD|$FN/$NEW|g" "$f" ;;
  esac
done < <(grep -rl "$FN/$OLD" --include='*.md' --include='*.yaml' --include='*.json' --include='*.sh' --include='*.txt' "$ROOT" 2>/dev/null)

OLD_CMD="$ROOT/.claude/commands/$OLD.md"
NEW_CMD="$ROOT/.claude/commands/$NEW.md"
if [ -f "$OLD_CMD" ]; then
  mv "$OLD_CMD" "$NEW_CMD"
  sed "${SED_INPLACE[@]}" "s|$OLD|$NEW|g" "$NEW_CMD"
  echo "  Renamed slash command: .claude/commands/$OLD.md → $NEW.md"
fi

LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
{
  echo ""
  echo "## $TIMESTAMP — rename-agent: $FN/$OLD → $FN/$NEW"
} >> "$LOG_FILE"

echo ""
echo "Files mentioning '$OLD' that were NOT auto-updated (review manually):"
grep -rln "$OLD" "$ROOT" 2>/dev/null | grep -v "_archive\|/logs/\|/log/runs/\|/log/feedback/\|/playbook/" | sed "s|$ROOT/|  - |" || echo "  (none found)"

echo ""
echo "✓ Rename complete."
echo "  Operation log: $LOG_FILE"
