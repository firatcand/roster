#!/usr/bin/env bash
# new-agent.sh — scaffolds a new global agent under a function category
#
# Usage:
#   bash scripts/new-agent.sh <function> <agent-name>
#   bash scripts/new-agent.sh --slash-only <function> <agent-name>
#
# --slash-only is the recovery flag invoked by chief-of-staff's guided-mode
# atomic-write transaction when the slash command file fails to land after
# the agent tree has already been written (see ROS-52). It writes only
# .claude/commands/<agent>.md, with strict no-clobber, and requires the
# agent tree to exist.

set -euo pipefail

print_usage() {
  cat >&2 <<EOF
Usage:
  $0 <function> <agent-name>
  $0 --slash-only <function> <agent-name>

Function: any slug registered in .config/functions.yaml
Example:  $0 gtm content-agent

--slash-only: recovery flag. Writes only .claude/commands/<agent-name>.md.
  Requires the agent tree at <function>/<agent-name>/ to already exist.
  Exits non-zero (no clobber) if the slash command file already exists.
EOF
}

SLASH_ONLY=0
if [ "${1:-}" = "--slash-only" ]; then
  SLASH_ONLY=1
  shift
fi

if [ $# -ne 2 ]; then
  print_usage
  exit 1
fi

FN="$1"
NAME="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/$FN/$NAME"

source "$ROOT/scripts/lib/functions.sh"

# write_slash_command <abs-file-path> <function> <agent-name>
# Canonical writer for .claude/commands/<agent>.md. Both the full-install
# path and --slash-only call this so the two paths cannot drift over time
# (see docs/learnings/2026-Q2/installer-mutations-need-drift-detector-mirror.md).
write_slash_command() {
  local file="$1" fn="$2" name="$3"
  cat > "$file" <<EOF
---
name: $name
description: $fn agent — TODO: fill in description
---

# /$name

You are operating the \`$fn/$name\` agent. Load \`$fn/$name/agent.md\` and the project's relevant context.

The user request is: \$ARGUMENTS

## Routing logic

Parse the user request:

1. **If it matches \`run <plan-name> for <project>\` or \`run <plan-name> on <project>\`**:
   - Load \`$fn/$name/plans/<plan-name>.yaml\`. If it doesn't exist, list available plans and ask user to pick.
   - Load \`projects/<project>/CLAUDE.md\` and relevant guidelines.
   - Load \`$fn/$name/projects/<project>/config/default.yaml\`.
   - Validate that all required tool bindings are non-TODO. Abort if not.
   - Execute the plan steps. Substitute \`\${tools.X.Y}\`, \`\${inputs.X}\`, \`\${config.X}\`.
   - Log to \`$fn/$name/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`.
   - Surface HITL approvals per the plan's approval_channel.

2. **If only a project is named (no plan)**:
   - List available plans from \`$fn/$name/plans/\` with descriptions. Ask user to pick.

3. **If neither plan nor project is named**:
   - List available projects and plans. Ask user to specify both.

4. **For ad-hoc strategic work**: suggest invoking \`$fn/EXPERT.md\` instead.

## Constraints

- Only run plans that exist as files in \`$fn/$name/plans/\`.
- Don't bypass approval gates.
- File writes go to the instance's \`log/runs/\` unless the plan explicitly writes elsewhere.
EOF
}

if ! is_valid_function "$FN"; then
  echo "ERROR: '$FN' is not a registered function." >&2
  echo "Registered functions:" >&2
  read_functions | sed 's/^/  - /' >&2
  echo "" >&2
  echo "To add a new function: bash scripts/create-function.sh $FN" >&2
  exit 1
fi

if ! [[ "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: Agent name must be lowercase, alphanumeric + hyphens." >&2
  exit 1
fi

# --slash-only branch: write only the slash command file and exit.
# Requires agent tree to exist; refuses to clobber an existing slash command.
if [ "$SLASH_ONLY" = "1" ]; then
  if [ ! -d "$TARGET" ]; then
    echo "ERROR: agent tree '$FN/$NAME' does not exist at $TARGET." >&2
    echo "  --slash-only is a recovery flag — create the agent tree first with:" >&2
    echo "    bash scripts/new-agent.sh $FN $NAME" >&2
    exit 1
  fi
  COMMANDS_DIR="$ROOT/.claude/commands"
  SLASH_CMD_FILE="$COMMANDS_DIR/$NAME.md"
  if [ -f "$SLASH_CMD_FILE" ]; then
    echo "ERROR: slash command already exists at .claude/commands/$NAME.md. Refusing to clobber." >&2
    exit 1
  fi
  mkdir -p "$COMMANDS_DIR"
  write_slash_command "$SLASH_CMD_FILE" "$FN" "$NAME"
  echo "Created: .claude/commands/$NAME.md"
  exit 0
fi

if [ -d "$TARGET" ]; then
  echo "ERROR: Agent '$FN/$NAME' already exists at $TARGET" >&2
  exit 1
fi

echo "Creating agent: $FN/$NAME"

mkdir -p "$TARGET"/{subagents,playbook,logs,projects/_template,.claude/skills,.claude/plugins}

# agent.md stub
cat > "$TARGET/agent.md" << EOF
# $NAME

## Purpose

<One paragraph: what this agent does, why it exists.>

## Inputs

The orchestrator expects:

- \`project\`: project slug
- <other inputs>

Read at runtime:

- \`agent.md\` (this file)
- \`projects/<project>/<this-agent>/config/default.yaml\`
- \`projects/<project>/CLAUDE.md\`
- \`projects/<project>/guidelines/voice.md\`
- <other guidelines this agent uses>
- \`<this-agent>/projects/<project>/playbook/\` — project-scoped lessons
- \`<this-agent>/playbook/\` — global lessons

## Steps

1. Resolve config and context
2. <step>
3. <step>

## Subagents

- <subagent-name>.md — <one-liner>

## Tools

Agent-scoped MCPs at \`<this-agent>/.mcp.json\`:
- <tool/MCP> — <purpose>

Universal MCPs (Slack, Google Drive) inherited from agent-team root.

## Outputs

Run file at \`projects/<project>/<this-agent>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`. See \`conventions.md\` § "Run file format".

## Approval

\`approval_channel: auto\` — in-session if interactive, Slack \`#${FN}\` if cron (resolved via \`SLACK_HITL_CHANNEL_$(echo "$FN" | tr '[:lower:]-' '[:upper:]_')\` in \`.env\`).

## Lessons protocol

Log candidate lessons inline in run output under \`## Candidate lessons\`. Don't write to \`playbook/\` directly during runs — that's the dreamer's job.

## Failure modes

- <known failure mode>: <handling>
EOF

# README
cat > "$TARGET/README.md" << EOF
# $NAME

<One-line description.>

## Files

- \`agent.md\` — orchestrator contract
- \`subagents/\` — specialized roles
- \`playbook/\` — global lessons (one file per lesson)
- \`logs/\` — agent-level operational logs
- \`.claude/\` — agent-scoped skills, plugins
- \`.mcp.json\` — agent-scoped MCPs (CREATE THIS — see template comment)
- \`projects/\` — per-project instances

## Invocation

From a project instance session:

\`\`\`bash
cd $FN/$NAME/projects/<project>/
claude
"Run $NAME on <inputs>"
\`\`\`

From cron:

\`\`\`bash
cd /path/to/agent-team
claude -p "\$(cat scripts/cron/wrappers/$NAME-prompt.txt)"
\`\`\`

## Configuration

Per-project: \`projects/<proj>/$FN/$NAME/config/default.yaml\` (created by \`new-agent-instance.sh\`).

## Outputs

\`projects/<proj>/$FN/$NAME/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`
EOF

# .mcp.json stub
cat > "$TARGET/.mcp.json" << EOF
{
  "_comment": "Agent-scoped MCPs for $NAME. Available when working in this agent's tree (including project instances). Add MCPs this agent specifically needs. Universal MCPs (Slack, Google Drive) are inherited from agent-team/.mcp.json.",
  "mcpServers": {}
}
EOF

# .claude/settings.json
cat > "$TARGET/.claude/settings.json" << EOF
{
  "_comment": "Agent-scoped Claude Code settings for $NAME."
}
EOF

# Subagent template
cat > "$TARGET/subagents/_template.md" << 'EOF'
# <Subagent Name>

## Role
<One paragraph: narrow job, single responsibility.>

## Inputs
<What the orchestrator passes in.>

## Output
<Structured output the orchestrator can parse.>

## Tools
<Named tools this subagent uses.>

## Boundaries
<What this subagent does NOT do.>

## Quality bar
<Specific criteria for acceptable output.>
EOF

# Project instance template
mkdir -p "$TARGET/projects/_template/config"
mkdir -p "$TARGET/projects/_template/playbook"
mkdir -p "$TARGET/projects/_template/log/runs"
mkdir -p "$TARGET/projects/_template/log/feedback"

cat > "$TARGET/projects/_template/config/default.yaml" << EOF
---
agent: $NAME
project: <project-slug>
created: <YYYY-MM-DD>
last_modified: <YYYY-MM-DD>
---

# $NAME Config — <Project>

# See $FN/$NAME/agent.md § "Inputs" for required fields.
# Use prose comments to explain "why" alongside "what".
EOF

cat > "$TARGET/projects/_template/asset-references.md" << EOF
# Asset references — $NAME / <project>

This agent uses these assets from \`projects/<project>/guidelines/asset-links.md\`:

- <e.g., specific asset by name>
EOF

touch "$TARGET/playbook/.gitkeep"
touch "$TARGET/logs/.gitkeep"
touch "$TARGET/.claude/skills/.gitkeep"
touch "$TARGET/.claude/plugins/.gitkeep"
touch "$TARGET/projects/_template/playbook/.gitkeep"
touch "$TARGET/projects/_template/log/runs/.gitkeep"
touch "$TARGET/projects/_template/log/feedback/.gitkeep"

# === Tool bindings prompt (added by tool-bindings workflow) ===
# Ask the user whether to define tools now. If yes, collect tool names and scaffold
# a stub `## Tools and bindings` section in the new agent.md.

echo ""
NEW_AGENT_MD="$ROOT/$FN/$NAME/agent.md"

# Skip prompt entirely if non-interactive (no TTY) or AGENT_TEAM_NO_CONFIRM=1
if [ -t 0 ] && [ "${AGENT_TEAM_NO_CONFIRM:-0}" != "1" ]; then
  read -r -p "Define tools and bindings now? (y/N): " DEFINE_TOOLS
  DEFINE_TOOLS="${DEFINE_TOOLS:-N}"

  if [[ "$DEFINE_TOOLS" =~ ^[Yy]$ ]]; then
    echo ""
    echo "Which tools is this agent using?"
    echo "  Enter comma-separated names (e.g., gmail, drive, attio, heyreach)."
    echo "  Or press Enter to skip."
    read -r -p "  > " TOOLS_LINE

    if [ -n "$TOOLS_LINE" ]; then
      # Normalize: split by comma, trim whitespace, lowercase
      TOOL_NAMES=()
      IFS=',' read -ra RAW_TOOLS <<< "$TOOLS_LINE"
      for raw in "${RAW_TOOLS[@]}"; do
        clean="$(echo "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')"
        if [[ -n "$clean" && "$clean" =~ ^[a-z][a-z0-9_-]*$ ]]; then
          TOOL_NAMES+=("$clean")
        elif [ -n "$clean" ]; then
          echo "  WARN: skipping invalid tool name '$clean' (must be lowercase, start with letter, only [a-z0-9_-])" >&2
        fi
      done

      if [ ${#TOOL_NAMES[@]} -gt 0 ]; then
        {
          echo ""
          echo "## Tools and bindings"
          echo ""
          echo "Per-project tool bindings expected by this agent. Chief-of-staff prompts for these when scaffolding a new agent-instance. Values land in \`projects/<project>/config/default.yaml\` under a \`tools:\` key."
          echo ""
          echo "Fill in each tool's bindings below. Schema: each binding has a \`required\` flag (true/false) and a \`description\`."
          echo ""
          echo '```yaml'
          for tool in "${TOOL_NAMES[@]}"; do
            echo "$tool:"
            echo "  # TODO: define bindings"
            echo "  #   <binding_name>:"
            echo "  #     required: true"
            echo "  #     description: \"...\""
          done
          echo '```'
        } >> "$NEW_AGENT_MD"

        echo ""
        echo "✓ Added '## Tools and bindings' to $NEW_AGENT_MD with stubs for: ${TOOL_NAMES[*]}"
        echo "  Edit agent.md to fill in actual bindings before adding instances."
      else
        echo "  No valid tool names provided. Skipping section."
      fi
    else
      echo "  Empty input. Skipping section."
    fi
  else
    echo "(Skipped tool definition. Add a '## Tools and bindings' section manually later if needed.)"
  fi
else
  # Non-interactive: skip the prompt entirely. User can add the section manually.
  :
fi
# === End tool bindings prompt ===

# === Plans directory ===
PLANS_DIR="$TARGET/plans"
mkdir -p "$PLANS_DIR"
touch "$PLANS_DIR/.gitkeep"
echo "Created: $FN/$NAME/plans/"

# === Slash command file ===
COMMANDS_DIR="$ROOT/.claude/commands"
mkdir -p "$COMMANDS_DIR"
SLASH_CMD_FILE="$COMMANDS_DIR/$NAME.md"

if [ ! -f "$SLASH_CMD_FILE" ]; then
  write_slash_command "$SLASH_CMD_FILE" "$FN" "$NAME"
  echo "Created: .claude/commands/$NAME.md"
fi

echo ""
echo "✓ Agent '$FN/$NAME' created at $TARGET"
echo ""
echo "Next steps:"
echo "  1. Fill in $TARGET/agent.md (purpose, inputs, steps, subagents, tools, outputs)"
echo "  2. Add subagents: cp $TARGET/subagents/_template.md $TARGET/subagents/<name>.md and fill in"
echo "  3. Add agent-scoped MCPs to $TARGET/.mcp.json if needed (HeyReach, Apollo, etc.)"
echo "  4. Update $TARGET/README.md with a real description"
echo "  5. Add at least one plan to $TARGET/plans/ (e.g., $TARGET/plans/<plan-name>.yaml)"
echo "  6. Edit .claude/commands/$NAME.md to fill in the description"
echo "  7. Add an instance to a project: bash scripts/new-agent-instance.sh <project> $FN $NAME"
echo ""
echo "Reference: see gtm/sdr/ for a complete example."
