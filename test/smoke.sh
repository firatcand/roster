#!/usr/bin/env bash
# Roster Phase 1 smoke test.
#
# End-to-end exercise of the published-package install path:
#   1. pnpm build the source
#   2. npm pack to produce a tarball
#   3. npm install -g <tarball> --prefix <isolated-tmp-prefix>
#   4. <prefix>/bin/roster install with HOME + ROSTER_CLAUDE_HOME redirected
#   5. <prefix>/bin/roster init my-test-workspace in a scratch dir
#   6. Assert all the files Phase 1 promises actually land
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
WORKSPACE="$SMOKE_DIR/workspace"
FAKE_HOME="$SMOKE_DIR/fake-home"
mkdir -p "$NPM_PREFIX" "$CLAUDE_HOME" "$CODEX_HOME" "$WORKSPACE" "$FAKE_HOME"

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
  package/templates/scaffold/logs/cron/.gitkeep
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
assert "-f \"$CLAUDE_HOME/agents/lesson-drafter.md\"" "lesson-drafter.md installed (claude md-copy)"

# Idempotency: re-running install should not throw
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --yes --scope user --silent
assert "$? -eq 0" "roster install is idempotent"

# 4b. Codex install — agents rendered as <name>.toml + <name>.persona.md (ROS-33)
HOME="$FAKE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" "$ROSTER_BIN" install --tool codex --yes --scope user --silent
assert "-f \"$CODEX_HOME/agents/lesson-drafter.toml\"" "codex emits lesson-drafter.toml"
assert "-f \"$CODEX_HOME/agents/lesson-drafter.persona.md\"" "codex emits lesson-drafter.persona.md sidecar"
assert "! -f \"$CODEX_HOME/agents/lesson-drafter.md\"" "codex does NOT copy raw .md into agents/"
assert_contains "$CODEX_HOME/agents/lesson-drafter.toml" "^developer_instructions = \"\"\"$" "toml uses developer_instructions key"
assert_contains "$CODEX_HOME/agents/lesson-drafter.toml" "openai/codex#19399" "toml header references upstream issue"
# Schema contract: legacy field names must NOT appear at the start of any line.
if grep -E '^(instructions|reasoning_effort)\s*=' "$CODEX_HOME/agents/lesson-drafter.toml" > /dev/null 2>&1; then
  fail "toml emits legacy keys (instructions/reasoning_effort)"
else
  pass "toml has no legacy instructions/reasoning_effort keys"
fi

# 5. roster init
echo ""
echo "===> 5. roster init"
cd "$WORKSPACE"
"$ROSTER_BIN" init my-test-workspace --silent --no-git
assert "-f CLAUDE.md" "CLAUDE.md exists"
assert_contains CLAUDE.md "my-test-workspace" "CLAUDE.md contains project name"
assert "! -z \"\$(grep -v '{{PROJECT_NAME}}' CLAUDE.md)\"" "no unresolved {{PROJECT_NAME}} tokens"
assert "-f conventions.md" "conventions.md ported into workspace"
assert "-f gtm/EXPERT.md" "gtm/EXPERT.md ported (function dir, no preinstalled agent)"
assert "-f product/EXPERT.md" "product/EXPERT.md ported"
assert "-f design/EXPERT.md" "design/EXPERT.md ported"
assert "-f ops/EXPERT.md" "ops/EXPERT.md ported"
assert "! -e gtm/sdr" "no SDR worked example shipped into workspace"
assert "-f chief-of-staff/agent.md" "chief-of-staff/agent.md ported"
assert "-f dreamer/agent.md" "dreamer/agent.md ported"
assert "-x scripts/new-agent.sh" "scripts/new-agent.sh ported + executable (ROS-58)"
assert "-x scripts/lib/bindings-prompt.sh" "scripts/lib/bindings-prompt.sh ported + executable"
assert "-f .config/functions.yaml" ".config/functions.yaml ported"
assert "-d logs/cron" "logs/cron/ ported"
assert "-f .env.example" ".env.example exists"
assert "-f .gitignore" ".gitignore exists"
assert_contains .gitignore "# Roster defaults" ".gitignore has Roster defaults marker"

# ROS-79: v1 single-project workspace shape — positive assertions after roster init.
# Use a recursive find so nested legacy paths (e.g. <function>/<agent>/projects)
# also fail the assertion, not just a top-level projects/ dir.
assert "-z \"\$(find . -type d -name projects)\"" "no projects/ dirs anywhere after init (v1 single-project shape)"
assert "-f config/project.yaml" "config/project.yaml ported (v1 identity)"
# ROS-81: config/project.yaml must have substituted {{PROJECT_NAME}} + {{DISPLAY_NAME}}
assert_contains config/project.yaml "name: my-test-workspace" "config/project.yaml name substituted"
assert_contains config/project.yaml 'display_name: "my-test-workspace"' "config/project.yaml display_name substituted"
assert_count config/project.yaml "{{PROJECT_NAME}}" 0 "config/project.yaml has no PROJECT_NAME placeholder"
assert_count config/project.yaml "{{DISPLAY_NAME}}" 0 "config/project.yaml has no DISPLAY_NAME placeholder"
assert "! -e config/project.yaml.template" "config/project.yaml.template suffix stripped after init"
assert "-d guidelines" "guidelines/ ported (v1 cross-agent substrate)"
assert "-f guidelines/voice.md" "guidelines/voice.md ported"
assert "-f guidelines/messaging.md" "guidelines/messaging.md ported"
assert "-f guidelines/brand-book.md" "guidelines/brand-book.md ported"
assert "-f guidelines/asset-links.md" "guidelines/asset-links.md ported"
assert "-d guidelines/icps" "guidelines/icps/ ported"
assert "-f guidelines/icps/_persona-template.md" "guidelines/icps/_persona-template.md seed ported"

# 5c. new-agent.sh end-to-end against the fresh workspace.
# Script has interactive tool-bindings prompts — </dev/null + AGENT_TEAM_NO_CONFIRM=1
# is load-bearing per non-interactive-flags-need-tty-audits.md.
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent.sh gtm test-agent </dev/null > /dev/null
assert "-d gtm/test-agent" "new-agent.sh creates gtm/test-agent/ (ROS-58)"
assert "-f gtm/test-agent/agent.md" "new-agent.sh creates agent.md (ROS-58)"
assert "-f .claude/commands/test-agent.md" "new-agent.sh creates slash command (ROS-58)"
# ROS-79: flat v1 agent shape — no projects/ subdir anywhere under the agent,
# all expected files/dirs present. Recursive find guards against any nested
# projects/ regression, not just an immediate child.
assert "-z \"\$(find gtm/test-agent -type d -name projects)\"" "new-agent.sh does NOT create any projects/ subdir (v1 flat shape)"
assert "-f gtm/test-agent/README.md" "new-agent.sh creates README.md"
assert "-f gtm/test-agent/config.yaml" "new-agent.sh creates config.yaml (v1 flat)"
assert "-f gtm/test-agent/asset-references.md" "new-agent.sh creates asset-references.md"
assert "-d gtm/test-agent/plans" "new-agent.sh creates plans/"
assert "-d gtm/test-agent/playbook" "new-agent.sh creates playbook/"
assert "-d gtm/test-agent/pending" "new-agent.sh creates pending/"
assert "-d gtm/test-agent/logs/runs" "new-agent.sh creates logs/runs/"
assert "-d gtm/test-agent/logs/feedback" "new-agent.sh creates logs/feedback/"
assert "-d gtm/test-agent/subagents" "new-agent.sh creates subagents/"
assert "-f gtm/test-agent/.mcp.json" "new-agent.sh creates .mcp.json"
# --slash-only recovery flag (ROS-53) — exercised end-to-end against the shipped script
rm .claude/commands/test-agent.md
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent.sh --slash-only gtm test-agent </dev/null > /dev/null
assert "-f .claude/commands/test-agent.md" "--slash-only recovery (ROS-53) works via shipped script (ROS-58)"

# Idempotency: re-run init with --force, marker should still appear exactly once
# AND the v1 shape contract must still hold (no resurrected projects/, identity
# anchor + guidelines seeds preserved).
"$ROSTER_BIN" init my-test-workspace --silent --no-git --force
assert_count .gitignore "# Roster defaults" 1 "Roster defaults block appended exactly once"
assert "-z \"\$(find . -type d -name projects)\"" "no projects/ dirs after --force re-init"
assert "-f config/project.yaml" "config/project.yaml survives --force re-init"
assert "-f guidelines/voice.md" "guidelines/voice.md survives --force re-init"

# 6. Schedule list/status/remove smoke (ROS-36).
#
# Writes schedules.yaml + state.md as fixtures directly (skipping install)
# so the section works cross-platform — `install --tool claude` is
# macOS/Windows-only, and `install --tool codex` requires a logged-in
# Codex CLI with cleared env, neither of which Linux CI provides.
# Install is exercised in its own unit tests + the macOS Mac mini gate
# (ROS-40). What's being smoked here is the four NEW commands.
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

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
