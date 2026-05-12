#!/usr/bin/env bash
# audit-agent.sh — checks agent structure completeness, reports issues with suggested fixes
# Usage: bash scripts/audit-agent.sh <function> <agent>

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <function> <agent>"
  exit 1
fi

FN="$1"
AGENT="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$ROOT/$FN/$AGENT"

source "$ROOT/scripts/lib/functions.sh"

if ! is_valid_function "$FN"; then
  echo "ERROR: '$FN' is not a registered function." >&2
  echo "Registered functions:" >&2
  read_functions | sed 's/^/  - /' >&2
  exit 1
fi

if [ ! -d "$AGENT_DIR" ]; then
  echo "ERROR: Agent '$FN/$AGENT' not found at $AGENT_DIR"
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RUN_TIME=$(date +%Y-%m-%d-%H%M)
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
REPORT="$LOG_DIR/audit-$FN-$AGENT-$RUN_TIME.md"

FAILURES=()
WARNINGS=()
PASSED=()

# === agent.md required sections ===
if [ ! -f "$AGENT_DIR/agent.md" ]; then
  FAILURES+=("[$FN/$AGENT/agent.md] missing")
else
  REQUIRED_SECTIONS=("## Purpose" "## Inputs" "## Plans" "## Subagents" "## Tools and bindings" "## Outputs" "## Approval" "## Lessons protocol")
  MISSING=()
  for section in "${REQUIRED_SECTIONS[@]}"; do
    if ! grep -qF "$section" "$AGENT_DIR/agent.md"; then
      MISSING+=("$section")
    fi
  done
  if [ ${#MISSING[@]} -gt 0 ]; then
    FAILURES+=("[$FN/$AGENT/agent.md] missing required sections: ${MISSING[*]}")
    FAILURES+=("  → Suggested fix: add the missing sections per conventions.md § 'Agent contract'")
  else
    PASSED+=("[$FN/$AGENT/agent.md] all required sections present")
  fi

  # Steps section should NOT be present anymore — workflows live in plans/
  if grep -qE '^## Steps' "$AGENT_DIR/agent.md"; then
    WARNINGS+=("[$FN/$AGENT/agent.md] still has a '## Steps' section — workflow logic should live in plans/<plan>.yaml, not agent.md")
    WARNINGS+=("  → Suggested fix: extract workflow steps into a plan file under $FN/$AGENT/plans/ and remove the section from agent.md")
  fi
fi

# === plans/ directory ===
PLANS_DIR="$AGENT_DIR/plans"
if [ ! -d "$PLANS_DIR" ]; then
  WARNINGS+=("[$FN/$AGENT/plans/] missing — agent has no plans declared")
  WARNINGS+=("  → Suggested fix: mkdir $PLANS_DIR && add at least one .yaml plan file")
else
  PLAN_COUNT=$(find "$PLANS_DIR" -maxdepth 1 -name '*.yaml' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PLAN_COUNT" -eq 0 ]; then
    WARNINGS+=("[$FN/$AGENT/plans/] empty — agent has no plans declared")
    WARNINGS+=("  → Suggested fix: add at least one .yaml plan to $PLANS_DIR")
  else
    PASSED+=("[$FN/$AGENT/plans/] $PLAN_COUNT plan(s)")
    for plan in "$PLANS_DIR"/*.yaml; do
      [ -f "$plan" ] || continue
      REL="${plan#$ROOT/}"
      if command -v python3 >/dev/null 2>&1; then
        if ! python3 -c "import yaml; yaml.safe_load(open('$plan'))" 2>/dev/null; then
          FAILURES+=("[$REL] YAML parse error")
        else
          PASSED+=("[$REL] valid YAML")
        fi
      fi
    done
  fi
fi

# === Slash command file ===
SLASH_CMD="$ROOT/.claude/commands/$AGENT.md"
if [ ! -f "$SLASH_CMD" ]; then
  WARNINGS+=("[.claude/commands/$AGENT.md] missing — slash command not registered")
  WARNINGS+=("  → Suggested fix: scaffold via 'bash scripts/new-agent.sh' template, or copy from another agent's slash command file")
else
  PASSED+=("[.claude/commands/$AGENT.md] present")
fi

# README
if [ ! -f "$AGENT_DIR/README.md" ]; then
  FAILURES+=("[$FN/$AGENT/README.md] missing")
else
  PASSED+=("[$FN/$AGENT/README.md] present")
fi

# .mcp.json valid JSON
if [ ! -f "$AGENT_DIR/.mcp.json" ]; then
  WARNINGS+=("[$FN/$AGENT/.mcp.json] missing (no agent-scoped MCPs configured)")
else
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import json; json.load(open('$AGENT_DIR/.mcp.json'))" 2>/dev/null; then
      FAILURES+=("[$FN/$AGENT/.mcp.json] invalid JSON")
      FAILURES+=("  → Suggested fix: validate with: python3 -c 'import json; json.load(open(\"$AGENT_DIR/.mcp.json\"))'")
    else
      PASSED+=("[$FN/$AGENT/.mcp.json] valid JSON")
    fi
  else
    PASSED+=("[$FN/$AGENT/.mcp.json] present (JSON not validated, python3 missing)")
  fi
fi

# .claude/settings.json
if [ ! -f "$AGENT_DIR/.claude/settings.json" ]; then
  WARNINGS+=("[$FN/$AGENT/.claude/settings.json] missing")
else
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import json; json.load(open('$AGENT_DIR/.claude/settings.json'))" 2>/dev/null; then
      FAILURES+=("[$FN/$AGENT/.claude/settings.json] invalid JSON")
    else
      PASSED+=("[$FN/$AGENT/.claude/settings.json] valid JSON")
    fi
  else
    PASSED+=("[$FN/$AGENT/.claude/settings.json] present")
  fi
fi

# subagents/ exists
if [ ! -d "$AGENT_DIR/subagents" ]; then
  WARNINGS+=("[$FN/$AGENT/subagents/] missing (may be intentional for very simple agents)")
else
  # Check each subagent has required sections
  for sub in "$AGENT_DIR/subagents"/*.md; do
    [ -f "$sub" ] || continue
    BASENAME=$(basename "$sub")
    [ "$BASENAME" = "_template.md" ] && continue
    REL="${sub#$ROOT/}"
    SUB_REQUIRED=("## Role" "## Inputs" "## Output" "## Tools" "## Boundaries" "## Quality bar")
    SUB_MISSING=()
    for section in "${SUB_REQUIRED[@]}"; do
      if ! grep -qF "$section" "$sub"; then
        SUB_MISSING+=("$section")
      fi
    done
    if [ ${#SUB_MISSING[@]} -gt 0 ]; then
      WARNINGS+=("[$REL] missing sections: ${SUB_MISSING[*]}")
    else
      PASSED+=("[$REL] all subagent sections present")
    fi
  done
fi

# playbook/ exists
if [ ! -d "$AGENT_DIR/playbook" ]; then
  WARNINGS+=("[$FN/$AGENT/playbook/] missing")
else
  PASSED+=("[$FN/$AGENT/playbook/] present")
fi

# projects/_template/ exists
if [ ! -d "$AGENT_DIR/projects/_template" ]; then
  FAILURES+=("[$FN/$AGENT/projects/_template/] missing — new instances cannot be created without it")
  FAILURES+=("  → Suggested fix: rebuild via 'bash scripts/new-agent.sh $FN $AGENT' (will fail if exists; manually copy from gtm/sdr/projects/_template/ as reference)")
else
  PASSED+=("[$FN/$AGENT/projects/_template/] present")
fi

# === Each instance ===
INSTANCES=()
while IFS= read -r path; do
  INSTANCES+=("$path")
done < <(find "$AGENT_DIR/projects" -maxdepth 1 -mindepth 1 -type d -not -name '_template' 2>/dev/null || true)

for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"
  PROJECT_NAME=$(basename "$inst")

  CONFIG="$inst/config/default.yaml"
  if [ ! -f "$CONFIG" ]; then
    FAILURES+=("[$REL/config/default.yaml] missing")
  else
    if command -v python3 >/dev/null 2>&1; then
      if ! python3 -c "import yaml; list(yaml.safe_load_all(open('$CONFIG')))" 2>/dev/null; then
        FAILURES+=("[$REL/config/default.yaml] YAML parse error")
      else
        DECLARED=$(python3 -c "import yaml; docs = list(yaml.safe_load_all(open('$CONFIG'))); print((docs[0] or {}).get('project', ''))" 2>/dev/null || echo "")
        if [ "$DECLARED" != "$PROJECT_NAME" ]; then
          FAILURES+=("[$REL/config/default.yaml] project field '$DECLARED' doesn't match folder '$PROJECT_NAME'")
        else
          PASSED+=("[$REL/config/default.yaml] valid")
        fi
      fi
    fi
  fi

  for d in log/runs log/feedback playbook; do
    if [ ! -d "$inst/$d" ]; then
      WARNINGS+=("[$REL/$d/] missing")
    fi
  done

  if [ ! -f "$inst/asset-references.md" ]; then
    WARNINGS+=("[$REL/asset-references.md] missing")
  fi
done

# === Status ===
if [ ${#FAILURES[@]} -gt 0 ]; then
  STATUS="fail"
elif [ ${#WARNINGS[@]} -gt 0 ]; then
  STATUS="warn"
else
  STATUS="pass"
fi

count_items() {
  local arr=("$@")
  local n=0
  for item in "${arr[@]}"; do
    if ! [[ "$item" =~ ^[[:space:]]*→ ]]; then
      n=$((n+1))
    fi
  done
  echo $n
}

N_FAIL=0
for item in "${FAILURES[@]:-}"; do
  [ -z "$item" ] && continue
  [[ "$item" =~ ^[[:space:]]+→ ]] && continue
  N_FAIL=$((N_FAIL + 1))
done
N_WARN=0
for item in "${WARNINGS[@]:-}"; do
  [ -z "$item" ] && continue
  [[ "$item" =~ ^[[:space:]]+→ ]] && continue
  N_WARN=$((N_WARN + 1))
done
N_PASS=${#PASSED[@]}

# Write report
{
  echo "---"
  echo "operation: audit-agent"
  echo "function: $FN"
  echo "agent: $AGENT"
  echo "ran: $TIMESTAMP"
  echo "status: $STATUS"
  echo "---"
  echo ""
  echo "# Audit: $FN/$AGENT"
  echo ""
  echo "## Summary"
  echo "- $N_PASS passed"
  echo "- $N_WARN warnings"
  echo "- $N_FAIL failures"
  echo "- ${#INSTANCES[@]} instance(s) audited"
  echo ""
  if [ $N_FAIL -gt 0 ]; then
    echo "## Failures"
    for line in "${FAILURES[@]}"; do
      echo "- $line"
    done
    echo ""
  fi
  if [ $N_WARN -gt 0 ]; then
    echo "## Warnings"
    for line in "${WARNINGS[@]}"; do
      echo "- $line"
    done
    echo ""
  fi
  if [ $N_PASS -gt 0 ]; then
    echo "## Passed"
    for line in "${PASSED[@]}"; do
      echo "- $line"
    done
  fi
} > "$REPORT"

echo "Audit: $FN/$AGENT — $STATUS"
echo "  Passed: $N_PASS, Warnings: $N_WARN, Failures: $N_FAIL"
echo "  Instances audited: ${#INSTANCES[@]}"
[ $N_FAIL -gt 0 ] && {
  echo "Failures:"
  for line in "${FAILURES[@]}"; do echo "  $line"; done
}
echo "Full report: $REPORT"
