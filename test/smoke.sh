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

SMOKE_DIR="$(mktemp -d -t roster-smoke-XXXXXXXX)"
NPM_PREFIX="$SMOKE_DIR/npm-prefix"
CLAUDE_HOME="$SMOKE_DIR/claude"
WORKSPACE="$SMOKE_DIR/workspace"
FAKE_HOME="$SMOKE_DIR/fake-home"
mkdir -p "$NPM_PREFIX" "$CLAUDE_HOME" "$WORKSPACE" "$FAKE_HOME"

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

# 3. Global install (isolated prefix; no sudo, no touching host)
echo ""
echo "===> 3. Global install (isolated prefix)"
npm install -g "$TARBALL" --prefix "$NPM_PREFIX" --no-audit --no-fund --silent > /dev/null
ROSTER_BIN="$NPM_PREFIX/bin/roster"
assert "-x \"$ROSTER_BIN\"" "roster binary installed at $ROSTER_BIN"
VER=$("$ROSTER_BIN" --version)
assert "\"$VER\" = '0.1.0'" "roster --version → 0.1.0 (got '$VER')"

# 4. roster install (Claude redirected via ROSTER_CLAUDE_HOME)
echo ""
echo "===> 4. roster install"
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --silent
assert "-f \"$CLAUDE_HOME/skills/chief-of-staff/SKILL.md\"" "chief-of-staff SKILL.md installed"
assert "-f \"$CLAUDE_HOME/agents/lesson-drafter.md\"" "lesson-drafter.md installed"

# Idempotency: re-running install should not throw
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" "$ROSTER_BIN" install --silent
assert "$? -eq 0" "roster install is idempotent"

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
assert "-f .env.example" ".env.example exists"
assert "-f .gitignore" ".gitignore exists"
assert_contains .gitignore "# Roster defaults" ".gitignore has Roster defaults marker"

# Idempotency: re-run init with --force, marker should still appear exactly once
"$ROSTER_BIN" init my-test-workspace --silent --no-git --force
assert_count .gitignore "# Roster defaults" 1 "Roster defaults block appended exactly once"

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
