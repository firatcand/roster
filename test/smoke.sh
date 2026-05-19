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
# Tests for unshipped artifacts under .dogfood/ live in separate scripts and
# are invoked via `pnpm test:dogfood-scripts` (e.g. test/new-agent-slash-only.sh).
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
  local actual
  actual=$(grep -c -- "$2" "$1" 2>/dev/null || echo "0")
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
  package/templates/scaffold/scripts/new-project.sh \
  package/templates/scaffold/scripts/new-agent.sh \
  package/templates/scaffold/scripts/new-agent-instance.sh \
  package/templates/scaffold/scripts/create-function.sh \
  package/templates/scaffold/scripts/archive-project.sh \
  package/templates/scaffold/scripts/unarchive-project.sh \
  package/templates/scaffold/scripts/remove-agent-from-project.sh \
  package/templates/scaffold/scripts/rename-project.sh \
  package/templates/scaffold/scripts/audit-agent.sh \
  package/templates/scaffold/scripts/audit-project.sh \
  package/templates/scaffold/scripts/audit-repo.sh \
  package/templates/scaffold/scripts/lib/functions.sh \
  package/templates/scaffold/scripts/lib/bindings-prompt.sh \
  package/templates/scaffold/chief-of-staff/agent.md \
  package/templates/scaffold/dreamer/agent.md \
  package/templates/scaffold/gtm/sdr/agent.md \
  package/templates/scaffold/gtm/sdr/plans/cold-outreach.yaml \
  package/templates/scaffold/projects/_demo/CLAUDE.md \
  package/templates/scaffold/projects/_demo/state.md \
  package/templates/scaffold/projects/_demo/config/default.yaml \
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
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --silent
assert "-f \"$CLAUDE_HOME/skills/chief-of-staff/SKILL.md\"" "chief-of-staff SKILL.md installed"
assert "-f \"$CLAUDE_HOME/agents/lesson-drafter.md\"" "lesson-drafter.md installed (claude md-copy)"

# Idempotency: re-running install should not throw
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --silent
assert "$? -eq 0" "roster install is idempotent"

# 4b. Codex install — agents rendered as <name>.toml + <name>.persona.md (ROS-33)
HOME="$FAKE_HOME" ROSTER_CODEX_HOME="$CODEX_HOME" "$ROSTER_BIN" install --tool codex --silent
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
assert "-d projects/_demo" "projects/_demo/ exists"
assert "-f projects/_demo/README.md" "projects/_demo/README.md exists"
assert "-f projects/_demo/CLAUDE.md" "projects/_demo/CLAUDE.md exists"
assert "-f projects/_demo/state.md" "projects/_demo/state.md exists"
assert "-f projects/_demo/config/default.yaml" "projects/_demo/config/default.yaml exists"
assert "-f projects/_demo/guidelines/voice.md" "projects/_demo/guidelines/voice.md exists"
assert "-f conventions.md" "conventions.md ported into workspace"
assert "-f gtm/sdr/agent.md" "gtm/sdr/agent.md ported"
assert "-f chief-of-staff/agent.md" "chief-of-staff/agent.md ported"
assert "-f dreamer/agent.md" "dreamer/agent.md ported"
assert "-x scripts/new-project.sh" "scripts/new-project.sh ported + executable"
assert "-x scripts/new-agent.sh" "scripts/new-agent.sh ported + executable (ROS-58)"
assert "-x scripts/new-agent-instance.sh" "scripts/new-agent-instance.sh ported + executable (ROS-58)"
assert "-x scripts/lib/bindings-prompt.sh" "scripts/lib/bindings-prompt.sh ported + executable (sourced by new-agent-instance)"
assert "-f .config/functions.yaml" ".config/functions.yaml ported"
assert "-d logs/cron" "logs/cron/ ported"

# 5b. new-project.sh actually runs against the freshly initialized workspace
bash scripts/new-project.sh "Smoke Test Co" > /dev/null
assert "-d projects/smoke-test-co" "new-project.sh creates projects/smoke-test-co/"
assert "-f projects/smoke-test-co/state.md" "new-project.sh creates state.md"
assert "-f projects/smoke-test-co/config/default.yaml" "new-project.sh creates config/default.yaml"
assert "-f .env.example" ".env.example exists"
assert "-f .gitignore" ".gitignore exists"
assert_contains .gitignore "# Roster defaults" ".gitignore has Roster defaults marker"

# 5c. new-agent.sh + new-agent-instance.sh end-to-end against the fresh workspace.
# Both scripts have interactive prompts (tool-bindings on new-agent.sh, project
# instance prompts on new-agent-instance.sh) — </dev/null + AGENT_TEAM_NO_CONFIRM=1
# is load-bearing per non-interactive-flags-need-tty-audits.md.
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent.sh gtm test-agent </dev/null > /dev/null
assert "-d gtm/test-agent" "new-agent.sh creates gtm/test-agent/ (ROS-58)"
assert "-f gtm/test-agent/agent.md" "new-agent.sh creates agent.md (ROS-58)"
assert "-f .claude/commands/test-agent.md" "new-agent.sh creates slash command (ROS-58)"
assert "-d gtm/test-agent/projects/_template" "new-agent.sh creates instance template (ROS-58)"
# --slash-only recovery flag (ROS-53) — exercised end-to-end against the shipped script
rm .claude/commands/test-agent.md
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent.sh --slash-only gtm test-agent </dev/null > /dev/null
assert "-f .claude/commands/test-agent.md" "--slash-only recovery (ROS-53) works via shipped script (ROS-58)"
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent-instance.sh smoke-test-co gtm test-agent </dev/null > /dev/null
assert "-d gtm/test-agent/projects/smoke-test-co" "new-agent-instance.sh creates project instance (ROS-58)"

# 5d. Exercise the lib/bindings-prompt.sh path. Inject a "## Tools and
# bindings" section into the agent.md, create a SECOND project, and a
# SECOND instance — new-agent-instance.sh:83 will detect the section
# and invoke bindings-prompt.sh. In non-TTY mode (</dev/null), bindings-
# prompt falls back to TODO placeholders per its own docstring; this
# verifies the script ships, is executable, and runs to completion.
cat >> gtm/test-agent/agent.md <<'AGENT_TOOLS_EOF'

## Tools and bindings

```yaml
gmail:
  account:
    required: true
    description: "Email address to send from"
```
AGENT_TOOLS_EOF
bash scripts/new-project.sh "Bindings Test Co" > /dev/null
AGENT_TEAM_NO_CONFIRM=1 bash scripts/new-agent-instance.sh bindings-test-co gtm test-agent </dev/null > /dev/null 2>&1
assert "-f gtm/test-agent/projects/bindings-test-co/config/default.yaml" "bindings-prompt: instance config exists"
assert_contains gtm/test-agent/projects/bindings-test-co/config/default.yaml "tools:" "bindings-prompt appended tools: block (ROS-58)"
assert_contains gtm/test-agent/projects/bindings-test-co/config/default.yaml "TODO" "bindings-prompt fell back to TODO placeholders in non-TTY mode"

# Idempotency: re-run init with --force, marker should still appear exactly once
"$ROSTER_BIN" init my-test-workspace --silent --no-git --force
assert_count .gitignore "# Roster defaults" 1 "Roster defaults block appended exactly once"

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
    project: _demo
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
