#!/usr/bin/env bash
# Roster packaged-product smoke test.
#
# End-to-end exercise of the published-package install path:
#   1. pnpm build the source
#   2. npm pack to produce a tarball
#   3. npm install -g <tarball> --prefix <isolated-tmp-prefix>
#   4. <prefix>/bin/roster install with HOME + ROSTER_CLAUDE_HOME redirected
#   5. <prefix>/bin/roster init my-test-workspace in a scratch dir
#   6. Assert the sparse v2 workspace and generated host activation contracts
#
# Everything writes under a single tmp dir cleaned up on exit (trap),
# so the host machine's /usr/local, ~/.claude, and ~/.npm-global are
# untouched.

set -euo pipefail

# Resolve repo root from this script's location so smoke can be run from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"
EXPECTED_VERSION="$(node -p "require('./package.json').version")"

# Note: this script tests SHIPPED behavior (npm pack + install + roster init).
# Regression tests for individual scaffold scripts (e.g. new-agent.sh --slash-only)
# live in test/new-agent-slash-only.sh and are invoked via `pnpm test:scaffold-scripts`.
# Keep this gate focused on what end users actually receive.

SMOKE_DIR="$(mktemp -d -t roster-smoke-XXXXXXXX)"
NPM_PREFIX="$SMOKE_DIR/npm-prefix"
CLAUDE_HOME="$SMOKE_DIR/claude"
CODEX_HOME="$SMOKE_DIR/codex"
GEMINI_HOME="$SMOKE_DIR/gemini"
WORKSPACE="$SMOKE_DIR/workspace"
FAKE_HOME="$SMOKE_DIR/fake-home"
mkdir -p "$NPM_PREFIX" "$CLAUDE_HOME" "$CODEX_HOME" "$GEMINI_HOME" "$WORKSPACE" "$FAKE_HOME"

cleanup() {
  local rc=$?
  rm -rf "$SMOKE_DIR" 2>/dev/null || true
  if [ $rc -eq 0 ]; then
    echo ""
    echo "===> smoke PASS"
  else
    echo ""
    echo "===> smoke FAIL (exit $rc)"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
assert() {
  # assert <bash test expression> <description>
  if eval "[ $1 ]"; then pass "$2"; else fail "$2 (test: [ $1 ])"; fi
}
assert_contains() {
  # assert_contains <file> <pattern> <description>
  if grep -q -- "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3 (pattern '$2' not in $1)"; fi
}
assert_count() {
  # assert_count <file> <pattern> <expected-count> <description>
  # Note: `grep -c` prints the count and exits 1 when count=0, so the prior
  # `|| echo "0"` fallback double-printed and produced "0\n0". Use a true
  # override instead.
  local actual
  actual=$(grep -c -- "$2" "$1" 2>/dev/null) || actual=0
  if [ "$actual" -eq "$3" ]; then pass "$4 (count=$actual)"; else fail "$4 (expected $3, got $actual)"; fi
}

echo "===> roster smoke test"
echo "  smoke dir: $SMOKE_DIR"

# 1. Build
echo ""
echo "===> 1. Build"
pnpm build > /dev/null
assert "-x bin/roster.js" "bin/roster.js produced and executable"
assert "\"\$(head -1 bin/roster.js)\" = '#!/usr/bin/env node'" "bin/roster.js shebang correct"

# 2. Pack
echo ""
echo "===> 2. Pack"
TARBALL_NAME=$(npm pack --pack-destination "$SMOKE_DIR" 2>/dev/null | tail -1)
TARBALL="$SMOKE_DIR/$TARBALL_NAME"
TARBALL_KB=$(du -k "$TARBALL" | awk '{print $1}')
assert "-f \"$TARBALL\"" "tarball produced: $TARBALL_NAME"
assert "$TARBALL_KB -le 1024" "tarball ≤ 1 MB (${TARBALL_KB} KB)"

# 2b. Tarball contents: scaffold templates ship
TARBALL_LIST="$SMOKE_DIR/tarball.list"
tar -tzf "$TARBALL" > "$TARBALL_LIST"
for expected in \
  package/templates/scaffold/conventions.md \
  package/templates/scaffold/.config/functions.yaml \
  package/templates/scaffold/scripts/new-agent.sh \
  package/templates/scaffold/scripts/create-function.sh \
  package/templates/scaffold/scripts/audit-agent.sh \
  package/templates/scaffold/scripts/audit-repo.sh \
  package/templates/scaffold/scripts/lib/functions.sh \
  package/templates/scaffold/scripts/lib/bindings-prompt.sh \
  package/templates/scaffold/chief-of-staff/agent.md \
  package/templates/scaffold/dreamer/agent.md \
  package/templates/scaffold/gtm/EXPERT.md \
  package/templates/scaffold/product/EXPERT.md \
  package/templates/scaffold/design/EXPERT.md \
  package/templates/scaffold/ops/EXPERT.md \
  package/templates/scaffold/logs/cron/.gitkeep \
  package/templates/scaffold/founder-skills.yaml.example \
  package/templates/scaffold/brain/RESOLVER.md \
  package/skills/brain/SKILL.md \
  package/skills/tasks/SKILL.md \
  package/agents/brain-organizer.md
do
  assert_contains "$TARBALL_LIST" "^$expected\$" "tarball contains $expected"
done

# 3. Global install (isolated prefix; no sudo, no touching host)
echo ""
echo "===> 3. Global install (isolated prefix)"
npm install -g "$TARBALL" --prefix "$NPM_PREFIX" --no-audit --no-fund --silent > /dev/null
ROSTER_BIN="$NPM_PREFIX/bin/roster"
assert "-x \"$ROSTER_BIN\"" "roster binary installed at $ROSTER_BIN"
VER=$("$ROSTER_BIN" --version)
assert "\"$VER\" = '$EXPECTED_VERSION'" "roster --version → $EXPECTED_VERSION (got '$VER')"

# 4. roster install (Claude redirected via ROSTER_CLAUDE_HOME)
echo ""
echo "===> 4. roster install"
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --yes --scope user --silent
assert "-f \"$CLAUDE_HOME/skills/chief-of-staff/SKILL.md\"" "chief-of-staff SKILL.md installed"
assert "-f \"$CLAUDE_HOME/skills/inbox/SKILL.md\"" "inbox SKILL.md installed (ROS-132 — /inbox)"
assert "-f \"$CLAUDE_HOME/skills/brain/SKILL.md\"" "brain SKILL.md installed (ROS-139 — /brain)"
assert "-f \"$CLAUDE_HOME/skills/tasks/SKILL.md\"" "tasks SKILL.md installed (ROS-152 — /tasks)"
assert "-f \"$CLAUDE_HOME/agents/lesson-drafter.md\"" "lesson-drafter.md installed (claude md-copy)"
assert "-f \"$CLAUDE_HOME/agents/brain-organizer.md\"" "brain-organizer.md installed (ROS-145 — claude md-copy)"

# Idempotency: re-running install should not throw
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --yes --scope user --silent
assert "$? -eq 0" "roster install is idempotent"

# 4b. Codex install — agents rendered as <name>.toml + <name>.persona.md (ROS-33)
HOME="$FAKE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" "$ROSTER_BIN" install --tool codex --yes --scope user --silent
assert "-f \"$CODEX_HOME/agents/lesson-drafter.toml\"" "codex emits lesson-drafter.toml"
assert "-f \"$CODEX_HOME/agents/lesson-drafter.persona.md\"" "codex emits lesson-drafter.persona.md sidecar"
assert "! -f \"$CODEX_HOME/agents/lesson-drafter.md\"" "codex does NOT copy raw .md into agents/"
assert "-f \"$CODEX_HOME/agents/brain-organizer.toml\"" "codex emits brain-organizer.toml (ROS-145)"
assert "-f \"$CODEX_HOME/agents/brain-organizer.persona.md\"" "codex emits brain-organizer.persona.md sidecar (ROS-145)"
assert "! -f \"$CODEX_HOME/agents/brain-organizer.md\"" "codex does NOT copy raw brain-organizer.md (ROS-145)"
assert "-f \"$SMOKE_DIR/.agents/skills/tasks/SKILL.md\"" "codex installs tasks skill into .agents/skills/ (ROS-152)"
assert_contains "$CODEX_HOME/agents/lesson-drafter.toml" "^developer_instructions = \"\"\"$" "toml uses developer_instructions key"
assert_contains "$CODEX_HOME/agents/lesson-drafter.toml" "openai/codex#19399" "toml header references upstream issue"
# Schema contract: legacy field names must NOT appear at the start of any line.
if grep -E '^(instructions|reasoning_effort)\s*=' "$CODEX_HOME/agents/lesson-drafter.toml" > /dev/null 2>&1; then
  fail "toml emits legacy keys (instructions/reasoning_effort)"
else
  pass "toml has no legacy instructions/reasoning_effort keys"
fi

# 4c. Gemini install — skills under extensions/, agents copied as .md (ROS-145)
HOME="$FAKE_HOME" ROSTER_GEMINI_HOME="$GEMINI_HOME" "$ROSTER_BIN" install --tool gemini --yes --scope user --silent
assert "-f \"$GEMINI_HOME/extensions/brain/SKILL.md\"" "gemini installs brain skill into extensions/"
assert "-f \"$GEMINI_HOME/extensions/tasks/SKILL.md\"" "gemini installs tasks skill into extensions/ (ROS-152)"
assert "-f \"$GEMINI_HOME/agents/lesson-drafter.md\"" "gemini emits lesson-drafter.md (md-copy)"
assert "-f \"$GEMINI_HOME/agents/brain-organizer.md\"" "gemini emits brain-organizer.md (ROS-145 — md-copy)"

# 5. Sparse v2 workspace and qualified registry
echo ""
echo "===> 5. sparse v2 workspace"
cd "$WORKSPACE"
"$ROSTER_BIN" init my-test-workspace --silent
assert "-f roster.yaml" "init creates roster.yaml"
assert "-f ROSTER.md" "init creates ROSTER.md"
TOP_LEVEL=$(find . -mindepth 1 -maxdepth 1 -print | sed 's#^./##' | sort)
if [ "$TOP_LEVEL" = $'ROSTER.md\nroster.yaml' ]; then
  pass "fresh init creates exactly two files"
else
  fail "fresh init creates exactly two files (got: $TOP_LEVEL)"
fi
assert "! -e .roster" "fresh init does not create generated or state metadata"
assert "! -e functions" "fresh init does not create optional authored roots"
assert "! -e .env" "fresh init does not create local secret files"
assert "! -e .gitignore" "fresh init does not create unrelated Git policy"
assert_contains roster.yaml "workspace_id: my-test-workspace" "registry carries workspace identity"

# An identical retry adopts the exact bytes without overlaying authored content.
INIT_ROSTER_HASH=$(shasum -a 256 roster.yaml | awk '{print $1}')
INIT_BOOTSTRAP_HASH=$(shasum -a 256 ROSTER.md | awk '{print $1}')
if "$ROSTER_BIN" init my-test-workspace --silent > /dev/null 2>&1; then
  pass "identical init retry is byte-idempotent"
else
  fail "identical init retry is byte-idempotent"
fi
assert "\"\$(shasum -a 256 roster.yaml | awk '{print \$1}')\" = '$INIT_ROSTER_HASH'" "init retry preserves roster.yaml"
assert "\"\$(shasum -a 256 ROSTER.md | awk '{print \$1}')\" = '$INIT_BOOTSTRAP_HASH'" "init retry preserves ROSTER.md"

"$ROSTER_BIN" scaffold function gtm --purpose "Go-to-market policy" --json > /dev/null
"$ROSTER_BIN" scaffold function product --purpose "Product policy" --json > /dev/null
"$ROSTER_BIN" scaffold agent social-manager --scope function:gtm --purpose "Social discovery" --json > /dev/null
"$ROSTER_BIN" scaffold agent social-manager --scope function:product --purpose "Product social" --json > /dev/null
"$ROSTER_BIN" scaffold guideline voice --scope function:gtm --purpose "Company voice" --json > /dev/null
"$ROSTER_BIN" scaffold plan opportunity-discovery --scope agent:gtm/social-manager --purpose "Find reply opportunities" --json > /dev/null
"$ROSTER_BIN" scaffold plan history-screen --scope agent:gtm/social-manager --purpose "Screen prior interactions" --json > /dev/null
"$ROSTER_BIN" scaffold subagent researcher --scope agent:gtm/social-manager --purpose "Collect evidence" --json > /dev/null
"$ROSTER_BIN" scaffold tool-use social-search --scope plan:gtm/social-manager#opportunity-discovery --purpose "Use the selected search source" --json > /dev/null
"$ROSTER_BIN" scaffold lesson strong-hook --scope agent:gtm/social-manager --purpose "Approved hook pattern" --json > /dev/null

assert "-f functions/gtm/function.yaml" "function scaffold creates only the registered function"
assert "-f functions/gtm/agents/social-manager/agent.yaml" "agent scaffold creates its qualified record"
assert "-f functions/product/agents/social-manager/agent.yaml" "same local agent id works in another function"
assert "-f functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml" "plan scaffold creates one structured plan"
assert "-f functions/gtm/agents/social-manager/tools/social-search.yaml" "plan-scoped tool guidance lands under its agent"
assert "-f functions/gtm/agents/social-manager/playbook/strong-hook.md" "lesson scaffold creates one authored lesson"
assert "! -e functions/product/agents/social-manager/plans" "unused agent slots remain absent"
assert "! -e functions/gtm/agents/social-manager/logs" "scaffolding creates no runtime log forest"
assert_contains functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml "brain_selectors: {}" "plan scaffold exposes the Brain selector catalog"
assert_contains functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml "output_guidance: \"\"" "plan scaffold exposes incomplete completion guidance"

if "$ROSTER_BIN" validate gtm/social-manager#opportunity-discovery --json > /dev/null 2>&1; then
  fail "incomplete plan draft fails semantic validation"
else
  pass "incomplete plan draft fails semantic validation"
fi

cat > functions/gtm/agents/social-manager/plans/history-screen.yaml <<'PLAN'
schema_version: 2
id: history-screen
agent: gtm/social-manager
purpose: Screen prior interactions before recommending a reply.
inputs: {}
brain_selectors: {}
guidelines: []
artifacts: {}
caps: {}
steps:
  - id: screen
    kind: reasoning
    instruction: Review the supplied interaction history for conflicts.
completion:
  artifacts: []
  output_guidance: Return any conflicts that affect the shortlist.
  criteria:
    - Relevant prior interactions have been considered.
PLAN

cat > functions/gtm/agents/social-manager/plans/opportunity-discovery.yaml <<'PLAN'
schema_version: 2
id: opportunity-discovery
agent: gtm/social-manager
purpose: Produce a reviewed shortlist of relevant reply opportunities.
inputs:
  request:
    description: The human's current discovery request.
    required: true
    shape: Plain text.
brain_selectors:
  successful-replies:
    description: Examples of successful prior replies.
    required: false
guidelines:
  - gtm/guidelines/voice
artifacts:
  search-brief:
    description: Filters prepared by the host for the selected search tool.
  shortlist:
    description: The human-reviewed opportunity shortlist.
caps:
  candidates:
    maximum: 25
    guidance: Keep only opportunities that match the current request.
steps:
  - id: prepare
    kind: reasoning
    instruction: Derive request-specific filters before choosing a tool query.
    context:
      brain:
        - successful-replies
      guidelines:
        - gtm/guidelines/voice
    expected:
      artifacts:
        - search-brief
      output_guidance: Explain why each filter matches the request.
  - id: research
    kind: subagent
    instruction: Ask the research specialist to gather candidate evidence.
    subagent: researcher
  - id: collaborate
    kind: cross-agent
    instruction: Ask the product social manager to challenge relevance.
    agent: product/social-manager
  - id: screen-history
    kind: nested-plan
    instruction: Apply the registered history-screen operating guide.
    plan: gtm/social-manager#history-screen
  - id: search
    kind: tool
    instruction: Use the company-defined social search use case.
    tool_use: social-search
    retry_guidance:
      max_attempts: 2
      instruction: Narrow the host-prepared filters before retrying.
  - id: approve
    kind: approval
    instruction: Pause before presenting the final shortlist.
    approval_guidance: Wait for the human to approve the shortlist in the host interface.
  - id: return
    kind: artifact
    instruction: Return the approved shortlist.
    artifact: shortlist
completion:
  artifacts:
    - shortlist
  output_guidance: Return the approved shortlist with relevance rationale.
  criteria:
    - Every opportunity is supported by evidence.
    - The human approved the shortlist.
PLAN

DISCOVER_JSON=$("$ROSTER_BIN" discover social-manager --kind agent --json)
if node -e 'const x=JSON.parse(process.argv[1]); const ids=x.records.map(r=>r.qualified_id); if(!x.ok || ids.length!==2 || !ids.includes("gtm/social-manager") || !ids.includes("product/social-manager")) process.exit(1)' "$DISCOVER_JSON"; then
  pass "discovery returns both qualified same-name agents"
else
  fail "discovery returns both qualified same-name agents"
fi
VALIDATE_JSON=$("$ROSTER_BIN" validate --json)
if node -e 'const x=JSON.parse(process.argv[1]); if(!x.ok || x.diagnostics.some(d=>d.severity==="error")) process.exit(1)' "$VALIDATE_JSON"; then
  pass "validate accepts the registered sparse workspace"
else
  fail "validate accepts the registered sparse workspace"
fi

# 5b. Explicit v2 project activation works without user-level host homes.
echo ""
echo "===> 5b. generated project activation"
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$SMOKE_DIR/missing-claude-home" \
  "$ROSTER_BIN" install --tool claude --scope project --yes --silent
assert "-f .claude/CLAUDE.md" "Claude activation creates its project instruction"
assert "-f .roster/generated-manifest.json" "project activation creates the generated manifest"
assert "-f .roster/.gitignore" "first generated state creates narrow state ignore policy"
assert_contains .roster/.gitignore "^state/$" "generated ignore policy covers only local state"

HOME="$FAKE_HOME" ROSTER_CODEX_HOME="$SMOKE_DIR/missing-codex-home" \
  "$ROSTER_BIN" install --tool codex --scope project --yes --silent
assert "-f AGENTS.md" "Codex activation creates root AGENTS.md when safe"
assert "-f .agents/skills/roster/SKILL.md" "Codex activation creates its project skill fallback"
assert_contains roster.yaml "claude: enabled" "Claude activation is registered"
assert_contains roster.yaml "codex: enabled" "Codex activation is registered"

"$ROSTER_BIN" update > /dev/null
assert "! -e .claude/skills" "v2 update does not copy the legacy skill forest"
assert "! -e brain" "v2 update does not create optional Brain files"
assert "! -e pending" "v2 update does not create approval or operations queues"
if "$ROSTER_BIN" upgrade > /dev/null 2>&1; then
  fail "v2 workspace refuses the eager legacy upgrader"
else
  pass "v2 workspace refuses the eager legacy upgrader"
fi

echo ""
echo "===> 6. Schedule list/status/remove (ROS-36)"

# list on a fresh workspace → no schedules registered
LIST_OUT=$("$ROSTER_BIN" schedule list 2>&1)
echo "$LIST_OUT" | grep -q "no schedules registered" && pass "list (empty): prints no-schedules message" || fail "list (empty)"

# Write fixture schedule + state.md
mkdir -p roster/ops
cat > roster/ops/schedules.yaml <<'EOF'
version: 1
schedules:
  - name: heartbeat-noop
    agent: noop
    plan: noop
    cron: "*/5 * * * *"
    tool: claude
    install_mode: ui-handoff
    status: pending-ui-install
EOF
cat > roster/ops/state.md <<'EOF'
2026-05-18T10:25:00Z | ops/noop/noop/_demo | success
2026-05-18T10:30:00Z | ops/noop/noop/_demo | success
EOF
assert "-f roster/ops/schedules.yaml" "fixture: schedules.yaml written"
assert "-f roster/ops/state.md" "fixture: state.md written"

# list → shows the fixture
LIST_OUT=$("$ROSTER_BIN" schedule list 2>&1)
echo "$LIST_OUT" | grep -q "heartbeat-noop" && pass "list: shows registered schedule" || fail "list: missing schedule name"
echo "$LIST_OUT" | grep -q "claude" && pass "list: shows tool column" || fail "list: missing tool column"
echo "$LIST_OUT" | grep -q "2026-05-18T10:30:00Z" && pass "list: shows last_run from state.md" || fail "list: missing last_run"

# status reads state.md
STATUS_OUT=$("$ROSTER_BIN" schedule status heartbeat-noop 2>&1)
echo "$STATUS_OUT" | grep -q "Schedule:" && pass "status: prints schedule metadata" || fail "status: missing metadata"
echo "$STATUS_OUT" | grep -q "2026-05-18T10:30:00Z" && pass "status: prints last_run timestamp" || fail "status: missing last_run"
echo "$STATUS_OUT" | grep -q "success" && pass "status: prints last_status" || fail "status: missing last_status"

# remove --dry-run leaves YAML intact
"$ROSTER_BIN" schedule remove heartbeat-noop --dry-run --silent
assert_contains roster/ops/schedules.yaml "heartbeat-noop" "remove --dry-run: YAML untouched"

# remove --yes strips the entry
"$ROSTER_BIN" schedule remove heartbeat-noop --yes --silent
if grep -q "heartbeat-noop" roster/ops/schedules.yaml 2>/dev/null; then
  fail "remove --yes: YAML still contains entry"
else
  pass "remove --yes: YAML entry stripped"
fi

# list after remove → empty again
LIST_OUT=$("$ROSTER_BIN" schedule list 2>&1)
echo "$LIST_OUT" | grep -q "heartbeat-noop" && fail "list (after remove): still shows entry" || pass "list (after remove): empty"

# 8. founder-skills sync (ROS-125) — runs in the $WORKSPACE workspace (CWD).
echo ""
echo "===> 8. founder-skills sync"
# 8a. Opt-out: the sparse scaffold creates neither an example nor an active manifest.
assert "! -f founder-skills.yaml.example" "sparse scaffold creates no founder-skills example"
assert "! -f founder-skills.yaml" "no active founder-skills.yaml after init (opt-out default)"
# 8b. No manifest → sync is a clean no-op, exit 0, nothing installed.
"$ROSTER_BIN" skills sync --silent > /dev/null 2>&1
assert "$? -eq 0" "skills sync with no manifest exits 0 (opt-out)"
assert "! -e .claude/skills/pricing" "no manifest → no founder skills installed"

# 8c. With a manifest + a stubbed npx, sync installs project-local + writes a lock.
# Stub `npx skills add <tree-url> --copy -y -a <agent>...` to materialize the
# skill dir into the matching tool target, so smoke stays hermetic (no network).
STUBBIN="$SMOKE_DIR/stubbin"
mkdir -p "$STUBBIN"
cat > "$STUBBIN/npx" <<'STUB'
#!/usr/bin/env bash
# Minimal `npx skills add` stub: parse the tree URL + -a agents, create dirs.
args=("$@"); url=""; agents=()
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[i]}" in
    https://github.com/*) url="${args[i]}" ;;
    -a) agents+=("${args[i+1]}") ;;
  esac
done
skill="${url##*/}"
for a in "${agents[@]}"; do
  case "$a" in
    claude-code) d=".claude/skills/$skill" ;;
    codex)       d=".agents/skills/$skill" ;;
    *) continue ;;
  esac
  mkdir -p "$d"
  printf -- '---\nname: %s\ndescription: %s skill\n---\nbody\n' "$skill" "$skill" > "$d/SKILL.md"
done
STUB
chmod +x "$STUBBIN/npx"

cat > founder-skills.yaml <<'EOF'
source: github:firatcand/founder-skills
ref: v1.0.0
skills:
  - pricing
EOF
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" \
  PATH="$STUBBIN:$PATH" "$ROSTER_BIN" skills sync --silent > /dev/null 2>&1
assert "-f .claude/skills/pricing/SKILL.md" "sync installs pricing into .claude/skills/ (project-local)"
assert "-f .agents/skills/pricing/SKILL.md" "sync installs pricing into .agents/skills/ (codex)"
assert "-f founder-skills.lock" "sync writes founder-skills.lock"
assert "! -e \"$FAKE_HOME/.claude/skills/pricing\"" "sync does NOT install founder skills into home dir"

# 8d. Drop the skill from the manifest → re-sync prunes it (full reconcile).
cat > founder-skills.yaml <<'EOF'
source: github:firatcand/founder-skills
ref: v1.0.0
skills:
  - sales-skill
EOF
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" \
  PATH="$STUBBIN:$PATH" "$ROSTER_BIN" skills sync --silent > /dev/null 2>&1
assert "! -e .claude/skills/pricing" "re-sync prunes a skill dropped from the manifest"
assert "-f .claude/skills/sales-skill/SKILL.md" "re-sync installs the newly-declared skill"

# 8e. OPTIONAL real-npx sync — gated behind ROSTER_NETWORK_SMOKE=1 so CI stays
# hermetic. Exercises the live `npx skills add <tree-url>` path against the real
# founder-skills repo (verifies the per-skill tree-URL + --copy invocation, R1).
if [ "${ROSTER_NETWORK_SMOKE:-}" = "1" ]; then
  echo "  (ROSTER_NETWORK_SMOKE=1 → real npx against firatcand/founder-skills)"
  rm -rf .claude/skills .agents/skills founder-skills.lock
  cat > founder-skills.yaml <<'EOF'
source: github:firatcand/founder-skills
ref: main
skills:
  - pricing
EOF
  HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" \
    "$ROSTER_BIN" skills sync --silent > /dev/null 2>&1
  assert "-f .claude/skills/pricing/SKILL.md" "real-npx: pricing installed into .claude/skills/ (R1)"
  assert "-f .agents/skills/pricing/SKILL.md" "real-npx: pricing installed into .agents/skills/ (codex)"
  assert "-f founder-skills.lock" "real-npx: lockfile written"
else
  echo "  (skipping real-npx sync — set ROSTER_NETWORK_SMOKE=1 to enable)"
fi

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
