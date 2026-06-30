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
assert "-f \"$GEMINI_HOME/agents/lesson-drafter.md\"" "gemini emits lesson-drafter.md (md-copy)"
assert "-f \"$GEMINI_HOME/agents/brain-organizer.md\"" "gemini emits brain-organizer.md (ROS-145 — md-copy)"

# 5. roster init
echo ""
echo "===> 5. roster init"
cd "$WORKSPACE"
"$ROSTER_BIN" init my-test-workspace --silent --no-git
assert "-f CLAUDE.md" "CLAUDE.md exists"
assert_contains CLAUDE.md "my-test-workspace" "CLAUDE.md contains project name"
assert "! -z \"\$(grep -v '{{PROJECT_NAME}}' CLAUDE.md)\"" "no unresolved {{PROJECT_NAME}} tokens"
assert "-f conventions.md" "conventions.md ported into workspace"
assert "-f brain/RESOLVER.md" "brain/RESOLVER.md ported (ROS-139 brain scaffold)"
assert_contains CLAUDE.md "roster:managed:start brain" "CONTEXT/CLAUDE.md carries the brain managed region"
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
# ROS-79 follow-up: also guard the prompt TEXT. v0.4 EXPERT/agent prompts pointed
# agents at projects/<project>/... paths that do not exist in the v1 flat shape.
# (The disabled bindings-prompt.sh historical note uses projects/<inst>/, which
# this literal does not match — intentionally left as a migration record.)
assert "-z \"\$(grep -rl 'projects/<project>/' . 2>/dev/null)\"" "no projects/<project>/ path residue in shipped prompts (v1 flat shape)"
assert "-f config/project.yaml" "config/project.yaml ported (v1 identity)"
# ROS-81: config/project.yaml must have substituted {{PROJECT_NAME}} + {{DISPLAY_NAME}}
assert_contains config/project.yaml "name: my-test-workspace" "config/project.yaml name substituted"
assert_contains config/project.yaml 'display_name: "my-test-workspace"' "config/project.yaml display_name substituted"
assert_count config/project.yaml "{{PROJECT_NAME}}" 0 "config/project.yaml has no PROJECT_NAME placeholder"
assert_count config/project.yaml "{{DISPLAY_NAME}}" 0 "config/project.yaml has no DISPLAY_NAME placeholder"
assert "! -e config/project.yaml.template" "config/project.yaml.template suffix stripped after init"
# ROS-143: fresh init produces the workspace identity file but NOT the runtime
# roster/ queue tree — the exact precondition that made the Codex
# roster-orchestrator chat bootstrap falsely abort. Lock it so the mode-aware
# guard always has a real fresh-init scaffold to bootstrap against. (.roster/
# scaffold metadata DOES exist and must not be confused with runtime roster/.)
assert "! -e roster" "fresh init does NOT create a runtime roster/ dir (ROS-143 precondition)"
assert "-d .roster" ".roster/ scaffold metadata exists, distinct from runtime roster/ (ROS-143)"
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
echo "===> 5e. roster upgrade (ROS-130) — runs in the $WORKSPACE workspace (CWD)"
assert "-f .roster/scaffold-manifest.json" "init wrote the scaffold manifest"
# Fresh workspace → upgrade is a clean no-op.
UPGRADE_OUT=$("$ROSTER_BIN" upgrade 2>&1)
assert "$? -eq 0" "roster upgrade exits 0 on a fresh workspace"
echo "$UPGRADE_OUT" | grep -q "already matches" && pass "upgrade: fresh workspace reports no changes" || fail "upgrade: expected no-change report"
# Delete a scaffold file → upgrade recreates it (create path, end-to-end).
rm -f gtm/EXPERT.md
"$ROSTER_BIN" upgrade > /dev/null 2>&1
assert "-f gtm/EXPERT.md" "upgrade recreates a deleted scaffold file"
# Edit a file → --dry-run must not write a .new.
printf '\nMY EDIT\n' >> conventions.md
"$ROSTER_BIN" upgrade --dry-run > /dev/null 2>&1
assert "! -f conventions.md.new" "upgrade --dry-run writes nothing"
# ROS-131: guidelines/ excluded by default — editing voice.md never yields a .new.
printf '\nMY VOICE\n' >> guidelines/voice.md
"$ROSTER_BIN" upgrade > /dev/null 2>&1
assert "! -f guidelines/voice.md.new" "upgrade excludes guidelines/ by default (no .new)"
# --exclude skips an additional path (gtm here).
rm -f gtm/EXPERT.md.new; printf '\nEDIT\n' >> gtm/EXPERT.md
"$ROSTER_BIN" upgrade --exclude gtm > /dev/null 2>&1
assert "! -f gtm/EXPERT.md.new" "upgrade --exclude skips the named path"

echo ""
echo "===> 5f. inbox / headless review apply (ROS-132) — in $WORKSPACE"
# Shipped banner reworded to "unread decisions … /inbox" (rebrand only).
assert_contains "$REPO_ROOT/templates/hooks/banner.sh" "unread %s awaiting — run /inbox" "banner.sh reworded to /inbox"
if grep -q "pending HITL items — run" "$REPO_ROOT/templates/hooks/banner.sh"; then
  fail "old banner literal still present in banner.sh"
else
  pass "old banner literal gone from banner.sh"
fi
# Plant a decision, list it (with id), approve it headlessly → moves to target.
mkdir -p roster/gtm/pending
printf -- '---\ntarget_on_approve: gtm/sdr/logs/runs/resolved.md\n---\nbody\n' > roster/gtm/pending/error-smoke.md
INBOX_ID=$("$ROSTER_BIN" review --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);process.stdout.write(a[0]?a[0].id:'')})" 2>/dev/null)
assert "-n \"$INBOX_ID\"" "review --json yields a decision id"
"$ROSTER_BIN" review --approve "$INBOX_ID" --json > /dev/null 2>&1
assert "-f gtm/sdr/logs/runs/resolved.md" "review --approve <id> moves the decision to its target"
assert "! -f roster/gtm/pending/error-smoke.md" "approved decision leaves the pending queue"

echo ""
echo "===> 5g. roster update umbrella (ROS-133) — in $WORKSPACE"
UPDATE_OUT=$(HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" update 2>&1)
assert "$? -eq 0" "roster update exits 0 in a workspace"
echo "$UPDATE_OUT" | grep -q "Skills + agents" && pass "update: runs the install step" || fail "update: missing install step"
echo "$UPDATE_OUT" | grep -q "Scaffold files" && pass "update: runs the upgrade step" || fail "update: missing upgrade step"
echo "$UPDATE_OUT" | grep -q "npm i -g @firatcand/roster@latest" && pass "update: prints CLI-bump reminder" || fail "update: missing CLI reminder"
assert "-f .claude/skills/inbox/SKILL.md" "update installs the inbox skill project-local"

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
# 8a. Opt-out: the scaffold ships the .example, NOT an active manifest.
assert "-f founder-skills.yaml.example" "scaffold ships founder-skills.yaml.example"
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
