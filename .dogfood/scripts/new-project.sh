#!/usr/bin/env bash
# new-project.sh — scaffolds a new project from the template
# Usage: bash scripts/new-project.sh <project-slug>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <project-slug>"
  echo "Example: $0 myproject"
  exit 1
fi

SLUG="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/projects/$SLUG"
TEMPLATE="$ROOT/projects/_template"

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: Slug must be lowercase, alphanumeric + hyphens, starting with a letter."
  exit 1
fi

if [ -d "$TARGET" ]; then
  echo "ERROR: Project '$SLUG' already exists at $TARGET"
  exit 1
fi

if [ ! -d "$TEMPLATE" ]; then
  echo "ERROR: Template not found at $TEMPLATE"
  exit 1
fi

echo "Creating project: $SLUG"
echo "  Path: $TARGET"

cp -R "$TEMPLATE" "$TARGET"

# Portable sed (BSD vs GNU)
SED_INPLACE=(-i)
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
fi

sed "${SED_INPLACE[@]}" "s/<Project Name>/$SLUG/g" "$TARGET/CLAUDE.md"
sed "${SED_INPLACE[@]}" "s/<Project Name>/$SLUG/g" "$TARGET/GUIDANCE.md"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
sed "${SED_INPLACE[@]}" "s/<ISO-8601 timestamp>/$TIMESTAMP/" "$TARGET/state.md"

# Remove .gitkeep files
find "$TARGET" -name '.gitkeep' -delete

echo ""
echo "✓ Project '$SLUG' created"
echo ""
echo "Next steps:"
echo "  1. Edit $TARGET/CLAUDE.md — fill in identity, audience, agents"
echo "  2. Fill required guidelines:"
echo "     - $TARGET/guidelines/voice.md"
echo "     - $TARGET/guidelines/icps/<persona>.md (rename _persona-template.md)"
echo "     - $TARGET/guidelines/design.md, design-tokens.md, brand-book.md, messaging.md"
echo "     - $TARGET/guidelines/asset-links.md"
echo "  3. Optional guidelines (fill when needed):"
echo "     - do-and-dont.md, compliance.md, competitors.md"
echo "  4. Add agent instances:"
echo "     bash scripts/new-agent-instance.sh $SLUG <function> <agent-name>"
echo "  5. Read $TARGET/GUIDANCE.md for the full setup walkthrough"
