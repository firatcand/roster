#!/usr/bin/env bash
# new-agent-instance.sh — adds an instance of a global agent to a project
# Usage: bash scripts/new-agent-instance.sh <project> <function> <agent-name>

set -euo pipefail

if [ $# -ne 3 ]; then
  echo "Usage: $0 <project> <function> <agent-name>"
  echo "Example: $0 myproject gtm sdr"
  exit 1
fi

PROJECT="$1"
FN="$2"
AGENT="$3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

source "$ROOT/scripts/lib/functions.sh"

if ! is_valid_function "$FN"; then
  echo "ERROR: '$FN' is not a registered function." >&2
  echo "Registered functions:" >&2
  read_functions | sed 's/^/  - /' >&2
  exit 1
fi

PROJECT_DIR="$ROOT/projects/$PROJECT"
GLOBAL_AGENT_DIR="$ROOT/$FN/$AGENT"
INSTANCE_DIR="$GLOBAL_AGENT_DIR/projects/$PROJECT"
INSTANCE_TEMPLATE="$GLOBAL_AGENT_DIR/projects/_template"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "ERROR: Project '$PROJECT' not found at $PROJECT_DIR"
  echo "Create it first: bash scripts/new-project.sh $PROJECT"
  exit 1
fi

if [ ! -d "$GLOBAL_AGENT_DIR" ]; then
  echo "ERROR: Global agent '$FN/$AGENT' not found at $GLOBAL_AGENT_DIR"
  echo "Create it first: bash scripts/new-agent.sh $FN $AGENT"
  exit 1
fi

if [ -d "$INSTANCE_DIR" ]; then
  echo "ERROR: Instance already exists at $INSTANCE_DIR"
  exit 1
fi

if [ ! -d "$INSTANCE_TEMPLATE" ]; then
  echo "ERROR: Agent has no _template instance at $INSTANCE_TEMPLATE"
  echo "(Recreate the agent or create the template manually.)"
  exit 1
fi

CURRENT_MONTH=$(date -u +"%Y-%m")
TODAY=$(date -u +"%Y-%m-%d")

echo "Adding instance of $FN/$AGENT to project $PROJECT"

# Copy the template
cp -R "$INSTANCE_TEMPLATE" "$INSTANCE_DIR"

# Portable sed
SED_INPLACE=(-i)
if [[ "$(uname)" == "Darwin" ]]; then
  SED_INPLACE=(-i '')
fi

# Patch placeholders in config and asset-references
sed "${SED_INPLACE[@]}" "s/<project-slug>/$PROJECT/g" "$INSTANCE_DIR/config/default.yaml"
sed "${SED_INPLACE[@]}" "s/<YYYY-MM-DD>/$TODAY/g" "$INSTANCE_DIR/config/default.yaml"
sed "${SED_INPLACE[@]}" "s/<Project>/$PROJECT/g" "$INSTANCE_DIR/config/default.yaml"
sed "${SED_INPLACE[@]}" "s/<project>/$PROJECT/g" "$INSTANCE_DIR/asset-references.md"

# Set up current month in log dirs
mkdir -p "$INSTANCE_DIR/log/runs/$CURRENT_MONTH" "$INSTANCE_DIR/log/feedback/$CURRENT_MONTH"
touch "$INSTANCE_DIR/log/runs/$CURRENT_MONTH/.gitkeep"
touch "$INSTANCE_DIR/log/feedback/$CURRENT_MONTH/.gitkeep"

# Prompt for tool bindings if the global agent.md has them
AGENT_MD="$GLOBAL_AGENT_DIR/agent.md"
INSTANCE_CONFIG="$INSTANCE_DIR/config/default.yaml"
if [ -f "$AGENT_MD" ] && grep -q '^## Tools and bindings' "$AGENT_MD"; then
  echo ""
  echo "=== Tool bindings for $FN/$AGENT in $PROJECT ==="
  echo "Enter values for each binding. Press Enter (or type 'skip') to leave as TODO."
  bash "$ROOT/scripts/lib/bindings-prompt.sh" "$AGENT_MD" "$INSTANCE_CONFIG" || \
    echo "WARNING: bindings-prompt failed; tools: block not appended. Edit $INSTANCE_CONFIG manually."
else
  echo ""
  echo "(Agent has no '## Tools and bindings' section in agent.md — skipping binding prompt)"
fi

# Pull list of expected MCPs and skills from agent's .mcp.json (rough — just shows what file exists)
echo ""
echo "✓ Instance added: $INSTANCE_DIR"
echo ""
echo "Reminders:"
echo "  - Edit $INSTANCE_DIR/config/default.yaml (see $GLOBAL_AGENT_DIR/agent.md § Inputs)"
echo "  - Edit $INSTANCE_DIR/asset-references.md to list which assets this agent uses"
echo "  - Verify project has required guidelines:"
echo "      $PROJECT_DIR/guidelines/voice.md"
echo "      $PROJECT_DIR/guidelines/icps/*.md (at least one)"
echo "      $PROJECT_DIR/guidelines/asset-links.md"
echo "  - Verify agent's MCPs are configured in $GLOBAL_AGENT_DIR/.mcp.json"
echo ""
echo "Test from a session:"
echo "  cd $INSTANCE_DIR/"
echo "  claude"
echo "  \"Run $AGENT — dry run, just show me the plan\""
echo ""
echo "Optionally schedule via cron:"
echo "  bash scripts/new-cron.sh $PROJECT-$AGENT-<frequency>"
