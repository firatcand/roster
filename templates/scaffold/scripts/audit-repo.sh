#!/usr/bin/env bash
# audit-repo.sh — full workspace audit; runs agent audits and repo-level checks
# Usage: bash scripts/audit-repo.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

source "$ROOT/scripts/lib/functions.sh"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RUN_TIME=$(date +%Y-%m-%d-%H%M)
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
REPORT="$LOG_DIR/audit-repo-$RUN_TIME.md"

REPO_FAILURES=()
REPO_WARNINGS=()
REPO_PASSED=()

# === Repo-level checks ===

# Universal .mcp.json
if [ ! -f "$ROOT/.mcp.json" ]; then
  REPO_WARNINGS+=("[.mcp.json] universal MCP config missing")
elif command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import json; json.load(open('$ROOT/.mcp.json'))" 2>/dev/null; then
    REPO_FAILURES+=("[.mcp.json] invalid JSON")
  else
    REPO_PASSED+=("[.mcp.json] valid")
  fi
fi

# Universal .claude/settings.json
if [ ! -f "$ROOT/.claude/settings.json" ]; then
  REPO_WARNINGS+=("[.claude/settings.json] universal settings missing")
elif command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import json; json.load(open('$ROOT/.claude/settings.json'))" 2>/dev/null; then
    REPO_FAILURES+=("[.claude/settings.json] invalid JSON")
  else
    REPO_PASSED+=("[.claude/settings.json] valid")
  fi
fi

# Required root files
for f in CLAUDE.md conventions.md README.md; do
  if [ ! -f "$ROOT/$f" ]; then
    REPO_FAILURES+=("[$f] missing at repo root")
  else
    REPO_PASSED+=("[$f] present")
  fi
done

# config/project.yaml — workspace identity (v1 shape)
if [ ! -f "$ROOT/config/project.yaml" ]; then
  REPO_FAILURES+=("[config/project.yaml] missing — workspace identity required")
elif command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import yaml; yaml.safe_load(open('$ROOT/config/project.yaml'))" 2>/dev/null; then
    REPO_FAILURES+=("[config/project.yaml] YAML parse error")
  else
    REPO_PASSED+=("[config/project.yaml] valid")
  fi
fi

# guidelines/ — cross-agent substrate
if [ ! -d "$ROOT/guidelines" ]; then
  REPO_FAILURES+=("[guidelines/] missing — workspace substrate dir required")
else
  REPO_PASSED+=("[guidelines/] present")
  for f in voice.md messaging.md brand-book.md asset-links.md; do
    if [ ! -f "$ROOT/guidelines/$f" ]; then
      REPO_WARNINGS+=("[guidelines/$f] missing — required substrate file")
    fi
  done
  if [ ! -d "$ROOT/guidelines/icps" ] || [ -z "$(find "$ROOT/guidelines/icps" -maxdepth 1 -name '*.md' -type f 2>/dev/null | head -1)" ]; then
    REPO_WARNINGS+=("[guidelines/icps/] empty or missing — at least one persona file required")
  fi
fi

# Build a regex of registered functions for matching grandparent dirs.
REGISTERED_FNS_PIPE=$(read_functions 2>/dev/null | tr '\n' '|' | sed 's/|$//')

# Registered function should have a folder
while IFS= read -r fn; do
  [ -z "$fn" ] && continue
  if [ ! -d "$ROOT/$fn" ]; then
    REPO_FAILURES+=("[$fn] registered in .config/functions.yaml but folder does not exist")
    REPO_FAILURES+=("  → Suggested fix: mkdir $fn && cp <stub README>, OR remove from .config/functions.yaml")
  fi
done < <(read_functions 2>/dev/null || true)

# has_expert: true → EXPERT.md must exist
while IFS=$'\t' read -r slug has_expert; do
  [ -z "$slug" ] && continue
  if [ "$has_expert" = "true" ] && [ ! -f "$ROOT/$slug/EXPERT.md" ]; then
    REPO_WARNINGS+=("[$slug/EXPERT.md] registry says has_expert=true but file missing")
  fi
done < <(read_functions_with_metadata 2>/dev/null || true)

# HITL channel env vars: every function should have SLACK_HITL_CHANNEL_<FN> in .env.example
ENV_EXAMPLE="$ROOT/.env.example"
if [ -f "$ENV_EXAMPLE" ]; then
  while IFS= read -r fn; do
    [ -z "$fn" ] && continue
    var="SLACK_HITL_CHANNEL_$(echo "$fn" | tr '[:lower:]-' '[:upper:]_')"
    if ! grep -q "^${var}=" "$ENV_EXAMPLE"; then
      REPO_WARNINGS+=("[.env.example] missing $var (function '$fn' has no HITL channel env var)")
    fi
  done < <(read_functions 2>/dev/null || true)
  if ! grep -q "^SLACK_HITL_CHANNEL_ADMIN=" "$ENV_EXAMPLE"; then
    REPO_WARNINGS+=("[.env.example] missing SLACK_HITL_CHANNEL_ADMIN (used by dreamer + chief-of-staff)")
  fi
fi

# Function-shaped top-level dirs not in the registry
KNOWN_NON_FUNCTIONS="dreamer chief-of-staff scripts logs _archive"
for dir in "$ROOT"/*/; do
  basename=$(basename "$dir")
  [[ "$basename" == .* ]] && continue
  echo "$KNOWN_NON_FUNCTIONS" | grep -qw "$basename" && continue
  if [ -n "$REGISTERED_FNS_PIPE" ] && echo "$basename" | grep -qE "^($REGISTERED_FNS_PIPE)\$"; then
    continue
  fi
  if find "$dir" -maxdepth 2 -name 'agent.md' -type f 2>/dev/null | head -1 | grep -q .; then
    REPO_WARNINGS+=("[$basename/] looks function-shaped but not registered in .config/functions.yaml")
    REPO_WARNINGS+=("  → Suggested fix: add to registry via 'bash scripts/create-function.sh $basename' (or remove if intended)")
  fi
done

# === Run audit-agent for each agent ===
AGENTS=()
while IFS= read -r fn; do
  [ -z "$fn" ] && continue
  if [ -d "$ROOT/$fn" ]; then
    while IFS= read -r path; do
      AGENTS+=("$fn:$(basename "$path")")
    done < <(find "$ROOT/$fn" -maxdepth 1 -mindepth 1 -type d 2>/dev/null || true)
  fi
done < <(read_functions 2>/dev/null || true)

AGENT_RESULTS=()
for entry in "${AGENTS[@]:-}"; do
  FN="${entry%%:*}"
  AGENT="${entry##*:}"
  RESULT=$(bash "$ROOT/scripts/audit-agent.sh" "$FN" "$AGENT" 2>&1 | head -5 || echo "  (audit failed)")
  AGENT_RESULTS+=("### $FN/$AGENT")
  AGENT_RESULTS+=("\`\`\`")
  while IFS= read -r line; do
    AGENT_RESULTS+=("$line")
  done <<< "$RESULT"
  AGENT_RESULTS+=("\`\`\`")
  AGENT_RESULTS+=("")
done

# === Status ===
if [ ${#REPO_FAILURES[@]} -gt 0 ]; then
  STATUS="fail"
elif [ ${#REPO_WARNINGS[@]} -gt 0 ]; then
  STATUS="warn"
else
  STATUS="pass"
fi

# Write report
{
  echo "---"
  echo "operation: audit-repo"
  echo "ran: $TIMESTAMP"
  echo "status: $STATUS"
  echo "---"
  echo ""
  echo "# Repo Audit"
  echo ""
  echo "## Summary"
  echo "- Agents audited: ${#AGENTS[@]}"
  echo "- Repo-level passed: ${#REPO_PASSED[@]}"
  echo "- Repo-level warnings: ${#REPO_WARNINGS[@]}"
  echo "- Repo-level failures: ${#REPO_FAILURES[@]}"
  echo ""
  if [ ${#REPO_FAILURES[@]} -gt 0 ]; then
    echo "## Repo-level Failures"
    for line in "${REPO_FAILURES[@]}"; do
      echo "- $line"
    done
    echo ""
  fi
  if [ ${#REPO_WARNINGS[@]} -gt 0 ]; then
    echo "## Repo-level Warnings"
    for line in "${REPO_WARNINGS[@]}"; do
      echo "- $line"
    done
    echo ""
  fi
  if [ ${#REPO_PASSED[@]} -gt 0 ]; then
    echo "## Repo-level Passed"
    for line in "${REPO_PASSED[@]}"; do
      echo "- $line"
    done
    echo ""
  fi
  echo "## Agent audits (summaries)"
  echo ""
  for line in "${AGENT_RESULTS[@]:-}"; do
    echo "$line"
  done
  echo ""
  echo "Individual audit reports are in $LOG_DIR/"
} > "$REPORT"

# Print summary
echo "Repo audit: $STATUS"
echo "  Agents: ${#AGENTS[@]}"
echo "  Repo-level: ${#REPO_PASSED[@]} passed, ${#REPO_WARNINGS[@]} warnings, ${#REPO_FAILURES[@]} failures"
[ ${#REPO_FAILURES[@]} -gt 0 ] && {
  echo "Repo failures:"
  for line in "${REPO_FAILURES[@]}"; do echo "  $line"; done
}
echo "Full report: $REPORT"
