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
  REQUIRED_SECTIONS=("## Purpose" "## Inputs" "## Plans" "## Subagents" "## Outputs" "## Approval" "## Lessons protocol")
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

  # ## Tools and bindings is required ONLY for agents that use external tools.
  # Missing → warning, not failure (agents reading only workspace guidelines
  # don't need it). The chief-of-staff create-agent guided flow adds the
  # section when the user names tools.
  if ! grep -qF "## Tools and bindings" "$AGENT_DIR/agent.md"; then
    WARNINGS+=("[$FN/$AGENT/agent.md] '## Tools and bindings' not declared — fine for tool-less agents; required if this agent calls external APIs")
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

# config.yaml — agent config (guideline refs + tool bindings).
# Schema check: single-document mapping with agent=$FN/$AGENT, plans_dir,
# guideline_refs (mapping), tools (mapping). Drift here breaks the runtime
# loader (Phase 2) and `chief-of-staff create-agent` reuse.
if [ ! -f "$AGENT_DIR/config.yaml" ]; then
  FAILURES+=("[$FN/$AGENT/config.yaml] missing")
  FAILURES+=("  → Suggested fix: add config.yaml at agent root with at least 'agent: $FN/$AGENT' and 'plans_dir: ./plans/'")
elif command -v python3 >/dev/null 2>&1; then
  CFG_RC=0
  CFG_MSG="$(AGENT_EXPECT="$FN/$AGENT" CFG_PATH="$AGENT_DIR/config.yaml" python3 - <<'PYEOF' 2>&1
import os, sys
try:
    import yaml
except ImportError:
    sys.stderr.write("pyyaml-missing")
    sys.exit(2)
expect = os.environ["AGENT_EXPECT"]
path = os.environ["CFG_PATH"]
with open(path) as f:
    try:
        doc = yaml.safe_load(f)
    except yaml.YAMLError as e:
        sys.stderr.write(f"yaml-parse-error: {e}")
        sys.exit(1)
if not isinstance(doc, dict):
    sys.stderr.write("not-a-mapping")
    sys.exit(1)
errs = []
agent = doc.get("agent")
if agent != expect:
    errs.append(f"agent field is {agent!r}, expected {expect!r}")
if "plans_dir" not in doc:
    errs.append("missing plans_dir")
gr = doc.get("guideline_refs")
if gr is not None and not isinstance(gr, dict):
    errs.append("guideline_refs is not a mapping")
tools = doc.get("tools")
if tools is not None and not isinstance(tools, dict):
    errs.append("tools is not a mapping")
if errs:
    sys.stderr.write("; ".join(errs))
    sys.exit(1)
PYEOF
)" || CFG_RC=$?
  if [ $CFG_RC -eq 0 ]; then
    PASSED+=("[$FN/$AGENT/config.yaml] valid (schema)")
  elif [ $CFG_RC -eq 2 ]; then
    PASSED+=("[$FN/$AGENT/config.yaml] present (schema not validated, pyyaml missing)")
  else
    FAILURES+=("[$FN/$AGENT/config.yaml] $CFG_MSG")
    FAILURES+=("  → Suggested fix: open the file and ensure it is a single YAML mapping with 'agent: $FN/$AGENT', 'plans_dir', a 'guideline_refs:' mapping, and a 'tools:' mapping (may be empty)")
  fi
else
  PASSED+=("[$FN/$AGENT/config.yaml] present (schema not validated, python3 missing)")
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

# Flat-shape directories
for d in logs/runs logs/feedback pending; do
  if [ ! -d "$AGENT_DIR/$d" ]; then
    WARNINGS+=("[$FN/$AGENT/$d/] missing")
  fi
done

# asset-references.md at agent root
if [ ! -f "$AGENT_DIR/asset-references.md" ]; then
  WARNINGS+=("[$FN/$AGENT/asset-references.md] missing")
fi

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
[ $N_FAIL -gt 0 ] && {
  echo "Failures:"
  for line in "${FAILURES[@]}"; do echo "  $line"; done
}
echo "Full report: $REPORT"
