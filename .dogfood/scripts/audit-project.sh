#!/usr/bin/env bash
# audit-project.sh — checks project completeness, reports issues with suggested fixes
# Usage: bash scripts/audit-project.sh <project>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <project>"
  exit 1
fi

PROJECT="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$ROOT/projects/$PROJECT"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "ERROR: Project '$PROJECT' not found at $PROJECT_DIR"
  exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RUN_TIME=$(date +%Y-%m-%d-%H%M)
LOG_DIR="$ROOT/chief-of-staff/logs/$(date +%Y-%m)"
mkdir -p "$LOG_DIR"
REPORT="$LOG_DIR/audit-$PROJECT-$RUN_TIME.md"

# Buffers
FAILURES=()
WARNINGS=()
PASSED=()

# Check helper: file exists and isn't template content
is_template() {
  local file="$1"
  # Heuristic: contains a placeholder pattern like <something descriptive>
  # We use the simple heuristic of looking for "<3 adjectives" or "<list>" — common template strings
  if grep -qE '<[a-z0-9 ,/.:-]+>' "$file" 2>/dev/null; then
    return 0
  fi
  return 1
}

check_required_guideline() {
  local file="$1"
  local rel="${file#$ROOT/}"
  if [ ! -f "$file" ]; then
    FAILURES+=("[$rel] required file missing")
    FAILURES+=("  → Suggested fix: copy from projects/_template/${rel#projects/$PROJECT/}")
    return
  fi
  if is_template "$file"; then
    FAILURES+=("[$rel] still contains template placeholders (e.g., <list>, <3 adjectives>)")
    FAILURES+=("  → Suggested fix: edit $rel to replace all <placeholder> markers with real content")
    return
  fi
  PASSED+=("[$rel] OK (filled in)")
}

check_optional_guideline() {
  local file="$1"
  local rel="${file#$ROOT/}"
  if [ ! -f "$file" ]; then
    WARNINGS+=("[$rel] optional file missing")
    WARNINGS+=("  → Suggested fix: copy from projects/_template/${rel#projects/$PROJECT/} if needed")
    return
  fi
  PASSED+=("[$rel] present")
}

# === Required guidelines ===
check_required_guideline "$PROJECT_DIR/guidelines/voice.md"
check_required_guideline "$PROJECT_DIR/guidelines/design.md"
check_required_guideline "$PROJECT_DIR/guidelines/design-tokens.md"
check_required_guideline "$PROJECT_DIR/guidelines/brand-book.md"
check_required_guideline "$PROJECT_DIR/guidelines/messaging.md"
check_required_guideline "$PROJECT_DIR/guidelines/asset-links.md"

# ICPs: at least one non-template file
if [ ! -d "$PROJECT_DIR/guidelines/icps" ]; then
  FAILURES+=("[projects/$PROJECT/guidelines/icps/] directory missing")
  FAILURES+=("  → Suggested fix: mkdir -p $PROJECT_DIR/guidelines/icps && cp projects/_template/guidelines/icps/_persona-template.md $PROJECT_DIR/guidelines/icps/")
else
  ICP_COUNT=$(find "$PROJECT_DIR/guidelines/icps" -type f -name '*.md' -not -name '_persona-template.md' | wc -l)
  if [ "$ICP_COUNT" -eq 0 ]; then
    FAILURES+=("[projects/$PROJECT/guidelines/icps/] no persona file (only _persona-template.md or empty)")
    FAILURES+=("  → Suggested fix: cp projects/_template/guidelines/icps/_persona-template.md $PROJECT_DIR/guidelines/icps/<persona-slug>.md and fill in")
  else
    PASSED+=("[projects/$PROJECT/guidelines/icps/] $ICP_COUNT persona file(s)")
  fi
fi

# === Optional guidelines ===
check_optional_guideline "$PROJECT_DIR/guidelines/do-and-dont.md"
check_optional_guideline "$PROJECT_DIR/guidelines/compliance.md"
check_optional_guideline "$PROJECT_DIR/guidelines/competitors.md"

# === Project root files ===
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  if grep -q '<Project Name>' "$PROJECT_DIR/CLAUDE.md" 2>/dev/null; then
    FAILURES+=("[projects/$PROJECT/CLAUDE.md] still contains <Project Name> placeholder")
    FAILURES+=("  → Suggested fix: edit projects/$PROJECT/CLAUDE.md and fill in identity, audience, agents")
  else
    PASSED+=("[projects/$PROJECT/CLAUDE.md] filled in")
  fi
else
  FAILURES+=("[projects/$PROJECT/CLAUDE.md] missing")
fi

if [ -f "$PROJECT_DIR/state.md" ]; then
  PASSED+=("[projects/$PROJECT/state.md] present")
else
  WARNINGS+=("[projects/$PROJECT/state.md] missing")
  WARNINGS+=("  → Suggested fix: cp projects/_template/state.md $PROJECT_DIR/state.md")
fi

# === Agent instances ===
INSTANCES=()
while IFS= read -r path; do
  INSTANCES+=("$path")
done < <(find "$ROOT" -type d -path "*/projects/$PROJECT" -not -path "*/_template/*" -not -path "*/_archive/*" 2>/dev/null | grep -v "^$PROJECT_DIR$" || true)

LISTED_INSTANCES=()
if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
  while IFS= read -r line; do
    LISTED_INSTANCES+=("$line")
  done < <(grep -oE '`[a-z0-9-]+/[a-z0-9-]+/projects/[a-z0-9-]+/`' "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | tr -d '`' || true)
fi

for inst in "${INSTANCES[@]}"; do
  REL="${inst#$ROOT/}"

  # config/default.yaml
  CONFIG="$inst/config/default.yaml"
  if [ ! -f "$CONFIG" ]; then
    FAILURES+=("[$REL/config/default.yaml] missing")
  else
    # Try YAML parse (use python3 if available, else just check file is non-empty)
    if command -v python3 >/dev/null 2>&1; then
      if ! python3 -c "import yaml; list(yaml.safe_load_all(open('$CONFIG')))" 2>/dev/null; then
        FAILURES+=("[$REL/config/default.yaml] YAML parse error")
        FAILURES+=("  → Suggested fix: check YAML syntax with: python3 -c 'import yaml; list(yaml.safe_load_all(open(\"$CONFIG\"))'")
      else
        # Check project field matches folder
        DECLARED_PROJECT=$(python3 -c "import yaml; docs = list(yaml.safe_load_all(open('$CONFIG'))); print((docs[0] or {}).get('project', ''))" 2>/dev/null || echo "")
        if [ "$DECLARED_PROJECT" != "$PROJECT" ]; then
          FAILURES+=("[$REL/config/default.yaml] project field is '$DECLARED_PROJECT', expected '$PROJECT'")
          FAILURES+=("  → Suggested fix: edit $REL/config/default.yaml and set 'project: $PROJECT'")
        else
          PASSED+=("[$REL/config/default.yaml] valid YAML, project matches")
        fi
      fi
    else
      PASSED+=("[$REL/config/default.yaml] present (YAML not validated, python3 missing)")
    fi
  fi

  # asset-references.md
  if [ -f "$inst/asset-references.md" ]; then
    PASSED+=("[$REL/asset-references.md] present")
  else
    WARNINGS+=("[$REL/asset-references.md] missing")
  fi

  # === Tool bindings: TODO required → fail; TODO optional → warn ===
  # Resolve agent.md from the instance path: $inst is .../<fn>/<agent>/projects/<project>
  INST_PARENT="$(cd "$inst/../.." && pwd)"
  AGENT_MD_FOR_INST="$INST_PARENT/agent.md"
  if [ -f "$CONFIG" ] && [ -f "$AGENT_MD_FOR_INST" ] && command -v python3 >/dev/null 2>&1; then
    BINDING_REPORT=$(CONFIG_PATH="$CONFIG" AGENT_MD_PATH="$AGENT_MD_FOR_INST" REL_PATH="$REL" python3 << 'PYEOF' 2>/dev/null || true
import os, re, sys
config_path = os.environ["CONFIG_PATH"]
agent_md = os.environ["AGENT_MD_PATH"]
rel = os.environ["REL_PATH"]

try:
    import yaml
except ImportError:
    sys.exit(0)

with open(agent_md) as f:
    am = f.read()
sm = re.search(r'## Tools and bindings.*?\n```yaml\n(.*?)\n```', am, re.DOTALL)
if not sm:
    sys.exit(0)
try:
    schema = yaml.safe_load(sm.group(1)) or {}
except Exception:
    sys.exit(0)

with open(config_path) as f:
    raw = f.read()

# Walk lines inside the tools: block; capture (tool, key) pairs whose value is TODO.
in_tools = False
current_tool = None
todos = []
for line in raw.split("\n"):
    if re.match(r'^tools:\s*$', line):
        in_tools = True
        continue
    if not in_tools:
        continue
    if re.match(r'^[A-Za-z]', line):
        # left the tools block (back to top-level key)
        in_tools = False
        current_tool = None
        continue
    tm = re.match(r'^  ([a-z_][a-z0-9_]*):\s*$', line)
    if tm:
        current_tool = tm.group(1)
        continue
    bm = re.match(r'^    ([a-z_][a-z0-9_]*):\s*#\s*TODO\b', line)
    if bm and current_tool:
        todos.append((current_tool, bm.group(1)))

for tool, key in todos:
    tool_schema = schema.get(tool, {}) if isinstance(schema, dict) else {}
    key_schema = tool_schema.get(key, {}) if isinstance(tool_schema, dict) else {}
    required = bool(key_schema.get("required", False)) if isinstance(key_schema, dict) else False
    severity = "FAIL" if required else "WARN"
    print(f"{severity}\t{tool}.{key}")
PYEOF
)
    while IFS=$'\t' read -r severity binding; do
      [ -z "$severity" ] && continue
      if [ "$severity" = "FAIL" ]; then
        FAILURES+=("[$REL/config/default.yaml] required tool binding '$binding' is TODO")
        FAILURES+=("  → Suggested fix: edit $REL/config/default.yaml and set tools.$binding to a real value")
      else
        WARNINGS+=("[$REL/config/default.yaml] optional tool binding '$binding' is TODO (will be skipped at runtime)")
      fi
    done <<< "$BINDING_REPORT"
  fi

  # Required directories
  for d in log/runs log/feedback playbook; do
    if [ -d "$inst/$d" ]; then
      PASSED+=("[$REL/$d/] present")
    else
      WARNINGS+=("[$REL/$d/] missing (will be auto-created on first run)")
    fi
  done

  # Is this instance listed in CLAUDE.md?
  EXPECTED_PATH=$(echo "$REL/" | sed 's|/projects/.*|/projects/'"$PROJECT"'/|')
  FOUND=0
  for listed in "${LISTED_INSTANCES[@]}"; do
    if [ "$listed" = "$EXPECTED_PATH" ]; then
      FOUND=1
      break
    fi
  done
  if [ $FOUND -eq 0 ]; then
    WARNINGS+=("[$REL] instance not listed in projects/$PROJECT/CLAUDE.md ## Active agent instances")
    WARNINGS+=("  → Suggested fix: add a line under '## Active agent instances' in CLAUDE.md")
  fi
done

# Listed instances that don't exist
for listed in "${LISTED_INSTANCES[@]}"; do
  if [ ! -d "$ROOT/${listed%/}" ]; then
    WARNINGS+=("[$listed] listed in CLAUDE.md but folder does not exist")
    WARNINGS+=("  → Suggested fix: either create the instance with new-agent-instance.sh or remove the line from CLAUDE.md")
  fi
done

# === Determine status ===
if [ ${#FAILURES[@]} -gt 0 ]; then
  STATUS="fail"
elif [ ${#WARNINGS[@]} -gt 0 ]; then
  STATUS="warn"
else
  STATUS="pass"
fi

# Count items (each FAILURE/WARNING entry is sometimes 2 lines: msg + suggested fix)
# Real count is half the FAILURES/WARNINGS for entries with → Suggested fix
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

# === Write report ===
{
  echo "---"
  echo "operation: audit-project"
  echo "project: $PROJECT"
  echo "ran: $TIMESTAMP"
  echo "status: $STATUS"
  echo "---"
  echo ""
  echo "# Audit: $PROJECT"
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

# === Print summary ===
echo "Audit: $PROJECT — $STATUS"
echo "  Passed: $N_PASS"
echo "  Warnings: $N_WARN"
echo "  Failures: $N_FAIL"
echo ""
if [ $N_FAIL -gt 0 ]; then
  echo "Failures:"
  for line in "${FAILURES[@]}"; do
    echo "  $line"
  done
  echo ""
fi
if [ $N_WARN -gt 0 ] && [ $N_WARN -le 5 ]; then
  echo "Warnings:"
  for line in "${WARNINGS[@]}"; do
    echo "  $line"
  done
  echo ""
fi
echo "Full report: $REPORT"
