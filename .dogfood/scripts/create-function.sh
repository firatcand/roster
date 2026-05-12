#!/usr/bin/env bash
# create-function.sh — register a new function category and scaffold its folder
# Usage: bash scripts/create-function.sh <slug> [--description "..."] [--with-expert] [--no-confirm]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/.config/functions.yaml"

source "$ROOT/scripts/lib/functions.sh"

usage() {
  cat <<EOF
Usage: $0 <slug> [--description "..."] [--with-expert] [--no-confirm]

  <slug>           required, lowercase kebab-case, ^[a-z][a-z0-9-]*\$
  --description    one-line description (prompted if omitted in TTY)
  --with-expert    scaffold EXPERT.md stub and set has_expert: true
  --no-confirm     skip the interactive proliferation prompt

Environment:
  AGENT_TEAM_NO_CONFIRM=1   equivalent to --no-confirm
EOF
}

if [ $# -lt 1 ]; then
  usage >&2
  exit 1
fi

SLUG=""
DESCRIPTION=""
WITH_EXPERT=""        # "" | "true" | "false"; "" means unresolved (will prompt)
DESC_PROVIDED=0
NO_CONFIRM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --description)
      [ $# -lt 2 ] && { echo "ERROR: --description requires a value" >&2; exit 1; }
      DESCRIPTION="$2"
      DESC_PROVIDED=1
      shift 2
      ;;
    --description=*)
      DESCRIPTION="${1#--description=}"
      DESC_PROVIDED=1
      shift
      ;;
    --with-expert)
      WITH_EXPERT="true"
      shift
      ;;
    --no-confirm)
      NO_CONFIRM=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: unknown flag '$1'" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -z "$SLUG" ]; then
        SLUG="$1"
        shift
      else
        echo "ERROR: unexpected positional arg '$1'" >&2
        exit 1
      fi
      ;;
  esac
done

if [ "${AGENT_TEAM_NO_CONFIRM:-0}" = "1" ]; then
  NO_CONFIRM=1
fi

if [ -z "$SLUG" ]; then
  echo "ERROR: <slug> is required" >&2
  usage >&2
  exit 1
fi

# 1. Validate slug format
if ! [[ "$SLUG" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: slug '$SLUG' is invalid. Must be lowercase, start with a letter, and only contain a-z, 0-9, and hyphens." >&2
  exit 1
fi

# 2. Check config exists and is parseable
if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found or unreadable" >&2
  exit 1
fi
if ! read_functions >/dev/null 2>&1; then
  echo "ERROR: failed to read $CONFIG (malformed YAML or unreadable)" >&2
  read_functions >/dev/null  # re-run to surface stderr
  exit 1
fi

# 3. Check slug not already in registry
if is_valid_function "$SLUG"; then
  echo "ERROR: function '$SLUG' is already registered in $CONFIG" >&2
  exit 1
fi

# 4. Check folder doesn't exist
TARGET="$ROOT/$SLUG"
if [ -e "$TARGET" ]; then
  echo "ERROR: '$TARGET' already exists on disk" >&2
  exit 1
fi

# 5. Resolve description
is_tty() { [ -t 0 ] && [ -t 1 ]; }

if [ $DESC_PROVIDED -eq 0 ]; then
  if is_tty; then
    printf "Description (one line, e.g. 'Research — discovery, market analysis'): " >&2
    IFS= read -r DESCRIPTION
  fi
  if [ -z "$DESCRIPTION" ]; then
    echo "ERROR: --description not provided and not running interactively" >&2
    exit 1
  fi
fi

# Strip trailing whitespace
DESCRIPTION="${DESCRIPTION%"${DESCRIPTION##*[![:space:]]}"}"
if [ -z "$DESCRIPTION" ]; then
  echo "ERROR: description is empty" >&2
  exit 1
fi

# 6. Resolve has_expert
if [ -z "$WITH_EXPERT" ]; then
  if is_tty; then
    printf "Does this function need an expert? (y/N): " >&2
    IFS= read -r ANS
    case "$ANS" in
      y|Y|yes|YES) WITH_EXPERT="true" ;;
      *) WITH_EXPERT="false" ;;
    esac
  else
    WITH_EXPERT="false"
  fi
fi

# 7. Soft proliferation reminder
if [ "$NO_CONFIRM" -eq 0 ] && is_tty; then
  cat >&2 <<EOF
About to create function: $SLUG
Reminder: function categories should map to how you mentally divide work.
Will you have at least 2-3 agents in this function within ~90 days?
If not, the agent likely fits an existing function. Press Ctrl-C to abort,
or any key to proceed.
EOF
  read -r -n 1 _ || true
  echo "" >&2
fi

# === Mutations begin here ===
# Track what we created so we can roll back on failure.
CREATED_PATHS=()
CONFIG_BACKUP="$(mktemp -t functions-yaml-backup.XXXXXX)" || {
  echo "ERROR: could not create backup tempfile" >&2
  exit 1
}
cp "$CONFIG" "$CONFIG_BACKUP"

rollback() {
  echo "Rolling back partial changes..." >&2
  for p in "${CREATED_PATHS[@]:-}"; do
    [ -e "$p" ] && rm -rf "$p"
  done
  cp "$CONFIG_BACKUP" "$CONFIG"
}
trap 'rollback; rm -f "$CONFIG_BACKUP"' ERR

# 8. Append entry to YAML
{
  printf '  - slug: %s\n' "$SLUG"
  printf '    description: %s\n' "$DESCRIPTION"
  printf '    has_expert: %s\n' "$WITH_EXPERT"
} >> "$CONFIG"

# 9. Create folder
mkdir -p "$TARGET"
CREATED_PATHS+=("$TARGET")

# 10. Stub README.md
README_PATH="$TARGET/README.md"
{
  printf '# Global %s agents\n\n' "$SLUG"
  printf '%s\n\n' "$DESCRIPTION"
  printf 'No agents yet. Add via:\n\n'
  printf '```bash\n'
  printf 'bash scripts/new-agent.sh %s <agent-name>\n' "$SLUG"
  printf '```\n\n'
  printf "When you add the first agent here, see \`gtm/sdr/\` as the canonical example of an agent's directory layout.\n"
} > "$README_PATH"

# 11. Optional EXPERT.md stub
if [ "$WITH_EXPERT" = "true" ]; then
  EXPERT_PATH="$TARGET/EXPERT.md"
  cat > "$EXPERT_PATH" <<EOF
# $SLUG Expert

<!--
This is a stub. Fill in the expert system prompt for this function.

Experts shape SUBSTRATE (project guidelines), not artifacts. They critique
and generate guideline files in \`projects/<project>/guidelines/\`.

Required sections (see other EXPERT.md files for examples once they exist):
- Identity (1 paragraph)
- Scope (guide / critique / generate guidelines)
- Skill routing (table)
- Practitioner panel (optional, only if it adds value)
- Read-first protocol
- Output rules (what writes where, what doesn't)
- Stage filter (early-stage constraints)

Keep it concise. Lean on skills rather than restating their content here.
-->

# Stub: replace with the function's expert system prompt.
EOF
fi

# 12. Append to operation log
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/operations-$(date +%Y-%m-%d).md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
{
  echo ""
  echo "## $TIMESTAMP — create-function: $SLUG"
  echo "Description: $DESCRIPTION"
  echo "has_expert: $WITH_EXPERT"
} >> "$LOG_FILE"

# Success — disarm rollback trap
trap - ERR
rm -f "$CONFIG_BACKUP"

echo ""
echo "✓ Function '$SLUG' created."
echo "  Folder:      $TARGET/"
echo "  README:      $README_PATH"
[ "$WITH_EXPERT" = "true" ] && echo "  EXPERT.md:   $TARGET/EXPERT.md (stub)"
echo "  Registry:    $CONFIG (entry appended)"
echo "  Log:         $LOG_FILE"
echo ""
SLUG_ENV=$(echo "$SLUG" | tr '[:lower:]-' '[:upper:]_')

echo "Reminders for the new function:"
echo "  1. HITL routing — agents in this function will route to #${SLUG}"
echo "     - Create the Slack channel #${SLUG}"
echo "     - Add to .env: SLACK_HITL_CHANNEL_${SLUG_ENV}=#${SLUG}"
[ "$WITH_EXPERT" = "true" ] && echo "  2. Fill in $TARGET/EXPERT.md with the expert system prompt"
echo "  $([ "$WITH_EXPERT" = "true" ] && echo 3 || echo 2). Add the first agent: bash scripts/new-agent.sh $SLUG <agent-name>"
