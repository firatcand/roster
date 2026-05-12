#!/usr/bin/env bash
# new-project.sh — scaffold a new project substrate inside a roster workspace.
#
# Usage:
#   bash scripts/new-project.sh <project-name> [<function>]
#
# Arguments:
#   project-name   Free-form name. Normalized to kebab-case (lowercase,
#                  [a-z0-9-], non-alphanumeric runs collapsed to '-').
#                  Examples:
#                    "My Co"        -> my-co
#                    "foo bar/baz"  -> foo-bar-baz
#                    "Acme Corp 2"  -> acme-corp-2
#   function       Optional. If provided, must be registered in
#                  .config/functions.yaml (gtm, product, design, ops, ...).
#
# Creates:
#   projects/<slug>/
#     guidelines/.gitkeep
#     config/default.yaml      (project-level config skeleton)
#     state.md                 (frontmatter + 5-line stub)
#
# Exit codes:
#   0  success
#   1  usage / validation error

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/functions.sh"

usage() {
  echo "Usage: $0 <project-name> [<function>]" >&2
  echo "  project-name   Free-form; normalized to kebab-case" >&2
  echo "  function       Optional; must be in .config/functions.yaml" >&2
}

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  usage
  exit 1
fi

RAW_NAME="$1"
FUNCTION="${2:-}"

normalize() {
  # 1. lowercase
  # 2. replace any run of non-alphanumeric chars with a single '-'
  # 3. trim leading/trailing '-'
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

SLUG="$(normalize "$RAW_NAME")"

if [ -z "$SLUG" ]; then
  echo "ERROR: project name '$RAW_NAME' is empty after normalization" >&2
  exit 1
fi

if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: normalized slug '$SLUG' must start with a letter and contain only a-z, 0-9, '-'" >&2
  exit 1
fi

if [ -n "$FUNCTION" ]; then
  if ! is_valid_function "$FUNCTION"; then
    echo "ERROR: function '$FUNCTION' is not registered in .config/functions.yaml" >&2
    echo "Registered functions:" >&2
    read_functions 2>/dev/null | sed 's/^/  - /' >&2 || echo "  (registry empty or missing)" >&2
    exit 1
  fi
fi

TARGET="$ROOT/projects/$SLUG"

if [ -e "$TARGET" ]; then
  echo "ERROR: project '$SLUG' already exists at $TARGET" >&2
  exit 1
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$TARGET/guidelines" "$TARGET/config" "$TARGET/assets"
touch "$TARGET/guidelines/.gitkeep" "$TARGET/assets/.gitkeep"

cat >"$TARGET/config/default.yaml" <<EOF
---
project: $SLUG
created: ${TIMESTAMP%T*}
---

# Project-level config for $SLUG.
# Cross-agent defaults. Agent-scoped instance config lives at:
#   <function>/<agent>/projects/$SLUG/config/default.yaml

display_name: $SLUG
stage: early
motion: outbound
approval_channel: auto
EOF

cat >"$TARGET/state.md" <<EOF
---
updated: $TIMESTAMP
---

Last task: (none yet)
Active artifacts: (none)
Open questions: (none)
Next session: fill in guidelines/voice.md and at least one ICP
Notes: created via scripts/new-project.sh
EOF

echo "✓ Project '$SLUG' created at projects/$SLUG/"
echo ""
echo "Next steps:"
echo "  1. Fill projects/$SLUG/guidelines/voice.md (3 adjectives + tone)"
echo "  2. Add at least one ICP under projects/$SLUG/guidelines/icps/"
echo "  3. Edit projects/$SLUG/config/default.yaml — set display_name, stage, motion"
if [ -n "$FUNCTION" ]; then
  echo "  4. Wire an agent instance via chief-of-staff: add-agent-to-project project=$SLUG function=$FUNCTION agent=<name>"
fi
