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
  # ROS-62: quote the description so YAML-special characters in $fn or the
  # placeholder body don't trip the I4 YAML parser when invariants run.
  cat > "$file" <<EOF
---
name: $name
description: "$fn agent — TODO: fill in description"
---

# /$name

You are operating the \`$fn/$name\` agent. Load \`$fn/$name/agent.md\` and the workspace's relevant context.

The user request is: \$ARGUMENTS

## Routing logic

Parse the user request:

1. **If it matches \`run <plan-name>\`**:
   - Load \`$fn/$name/plans/<plan-name>.yaml\`. If it doesn't exist, list available plans and ask user to pick.
   - Load \`$fn/$name/config.yaml\` and resolve env via \`resolveAgentEnv\` (\`$fn/$name/.env\` overrides workspace \`/.env\`).
   - Load workspace guidelines referenced under \`config.yaml\` \`guideline_refs:\` (e.g., \`/guidelines/voice.md\`, \`/guidelines/icps/\`, \`/guidelines/messaging.md\`).
   - Validate that all required tool bindings have non-empty env vars. Abort with a clear message if not.
   - Execute the plan steps. Substitute \`\${tools.X.env_var}\`, \`\${inputs.X}\`, \`\${config.X}\`.
   - Log to \`$fn/$name/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`.
   - Surface HITL approvals per the plan's \`approval_channel\`.

2. **If no plan is named**:
   - List available plans from \`$fn/$name/plans/\` with descriptions. Ask user to pick.

3. **For ad-hoc strategic work**: suggest invoking \`$fn/EXPERT.md\` instead.

## Constraints

- Only run plans that exist as files in \`$fn/$name/plans/\`.
- Don't bypass approval gates.
- File writes go to \`$fn/$name/logs/runs/\` unless the plan explicitly writes elsewhere.
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

mkdir -p "$TARGET"/{subagents,playbook,pending,logs/runs,logs/feedback,.claude/skills,.claude/plugins}

# agent.md stub
cat > "$TARGET/agent.md" << EOF
# $NAME

## Purpose

<One paragraph: what this agent does, why it exists.>

## Inputs

The orchestrator expects per-plan inputs (declared in each plan's \`inputs:\` block).

Read at runtime:

- \`agent.md\` (this file)
- \`config.yaml\` (workspace-root-relative guideline refs + tool bindings)
- Workspace guidelines referenced under \`config.yaml\` \`guideline_refs:\` (e.g., \`/guidelines/voice.md\`, \`/guidelines/icps/\`, \`/guidelines/messaging.md\`)
- \`playbook/\` — validated lessons (single playbook per agent)

Env resolution: \`<this-agent>/.env\` overrides workspace \`/.env\`. Required tool env vars validated before the plan runs.

## Plans

Named plans this agent runs (files in \`plans/<plan>.yaml\`). One-line description per plan.
No default plan — invoking without a plan triggers an interactive "which plan?" prompt.

- <plan-name>: <one-liner>

## Subagents

- <subagent-name>.md — <one-liner>

## Outputs

Run file at \`logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`. See \`conventions.md\` § "Run file format".
Per-plan output schemas live in each plan's \`outputs:\` block.

## Approval

\`approval_channel: auto\` — in-session if interactive, Slack \`#${FN}\` if cron (resolved via \`SLACK_HITL_CHANNEL_$(echo "$FN" | tr '[:lower:]-' '[:upper:]_')\` in workspace \`/.env\`).

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

- \`agent.md\` — orchestrator contract (behavioral prompt, plans list, tool bindings schema)
- \`config.yaml\` — guideline refs + tool bindings (workspace-root paths)
- \`.env\` — agent-scoped env overrides (gitignored, 0600 — optional, inherits from workspace \`/.env\`)
- \`plans/\` — named workflows (\`<plan>.yaml\`)
- \`subagents/\` — specialized roles
- \`playbook/\` — validated lessons (single playbook per agent)
- \`pending/\` — HITL items awaiting approval
- \`logs/runs/\`, \`logs/feedback/\` — run outputs + mirrored feedback
- \`asset-references.md\` — which workspace assets this agent uses (thin pointer)
- \`.claude/\` — agent-scoped Claude Code config (skills, plugins, settings)
- \`.mcp.json\` — agent-scoped MCPs

## Invocation

From the workspace root:

\`\`\`bash
claude
> /$NAME run <plan-name>
\`\`\`

Or via natural language:

\`\`\`
"Run $FN/$NAME using the <plan-name> plan"
\`\`\`

From cron: see ADR-0001 (subscription-billed scheduling via native local schedulers). Install via \`roster schedule install $FN/$NAME <plan> --cron "<expr>" --tool claude|codex\`.

## Configuration

\`config.yaml\` (this agent) — guideline refs + tool bindings.
Workspace \`/.env\` (root) + optional \`<this-agent>/.env\` for agent-scoped overrides.

## Outputs

\`logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\` — one file per invocation.
EOF

# .mcp.json stub
cat > "$TARGET/.mcp.json" << EOF
{
  "_comment": "Agent-scoped MCPs for $NAME. Available when working in this agent's tree. Add MCPs this agent specifically needs. Universal MCPs (Slack, Google Drive) are inherited from the workspace .mcp.json.",
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

# config.yaml — agent config (guideline refs + tool bindings)
# Minimal stub. The env-merge loader (resolveAgentEnv) reads bindings
# from this file's tools: block, with env-var values sourced from
# workspace /.env (or this agent's .env override). Until the dialogue-
# driven generator that auto-mirrors agent.md → config.yaml ships,
# copy the ## Tools and bindings YAML block from agent.md into the
# tools: mapping below by hand.
cat > "$TARGET/config.yaml" << EOF
agent: $FN/$NAME
plans_dir: ./plans/

# Workspace-root-relative refs. Loader rejects literal absolute fs paths
# like /Users/, /home/, /etc/, /var/, /tmp/, /opt/.
guideline_refs:
  voice: /guidelines/voice.md
  icps: /guidelines/icps/
  messaging: /guidelines/messaging.md
  # add more as needed:
  # brand_book: /guidelines/brand-book.md
  # do_and_dont: /guidelines/do-and-dont.md
  # compliance: /guidelines/compliance.md
  # competitors: /guidelines/competitors.md
  # ...or a guideline file you authored (project-local tier), e.g.:
  # channel_playbook: /guidelines/channel-playbook.md
  # To make one canonical for every future agent, follow the promotion
  # checklist in conventions.md § "Adding a new guideline file".

# Tool bindings. Each tool entry names the env var, required flag, and a
# short description. Env vars themselves live in workspace /.env (or are
# overridden in this agent's .env).
tools: {}
EOF

# asset-references.md — thin pointer at agent root
cat > "$TARGET/asset-references.md" << EOF
# Asset references — $FN/$NAME

This agent uses these assets from \`guidelines/asset-links.md\`:

- <e.g., specific asset by name>
EOF

touch "$TARGET/playbook/.gitkeep"
touch "$TARGET/pending/.gitkeep"
touch "$TARGET/logs/runs/.gitkeep"
touch "$TARGET/logs/feedback/.gitkeep"
touch "$TARGET/.claude/skills/.gitkeep"
touch "$TARGET/.claude/plugins/.gitkeep"

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
          echo "Tool bindings expected by this agent. The env-merge loader reads these from \`<agent>/config.yaml\` (under a \`tools:\` key), with env-var values from workspace \`/.env\` (overridable in \`<agent>/.env\`). For now, mirror the YAML block below into \`config.yaml\` by hand — the auto-mirroring generator that would derive it from this section is not yet shipped."
          echo ""
          echo "Fill in each tool's bindings below. Schema per conventions.md § \"Tool bindings\": each tool has a \`env_var\` (the env-var name the runtime reads), a \`required\` flag (true/false), and a one-line \`description\`."
          echo ""
          echo '```yaml'
          for tool in "${TOOL_NAMES[@]}"; do
            tool_env=$(echo "$tool" | tr '[:lower:]-' '[:upper:]_')
            echo "$tool:"
            echo "  env_var: ${tool_env}_API_KEY  # TODO: confirm env var name"
            echo "  required: true               # TODO: confirm required vs optional"
            echo "  description: \"\"             # TODO: one-line description"
          done
          echo '```'
        } >> "$NEW_AGENT_MD"

        echo ""
        echo "✓ Added '## Tools and bindings' to $NEW_AGENT_MD with stubs for: ${TOOL_NAMES[*]}"
        echo "  Edit agent.md to fill in env_var names + descriptions, then mirror the tools: block into <agent>/config.yaml by hand."
        echo "  (The env-merge loader reads bindings from <agent>/config.yaml at runtime; the auto-mirroring generator that would copy this block for you is not yet shipped, so this step is manual.)"
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
echo "  1. Fill in $TARGET/agent.md (purpose, inputs, plans, subagents, tools, outputs)"
echo "  2. Fill in $TARGET/config.yaml (guideline_refs, tools)"
echo "  3. Add subagents: cp $TARGET/subagents/_template.md $TARGET/subagents/<name>.md and fill in"
echo "  4. Add agent-scoped MCPs to $TARGET/.mcp.json if needed (HeyReach, Apollo, etc.)"
echo "  5. Update $TARGET/README.md with a real description"
echo "  6. Add at least one plan to $TARGET/plans/ (e.g., $TARGET/plans/<plan-name>.yaml)"
echo "  7. Edit .claude/commands/$NAME.md to fill in the description"
echo ""
echo "Reference: see gtm/sdr/ for a complete example."
