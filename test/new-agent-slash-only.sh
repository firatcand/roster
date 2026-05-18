#!/usr/bin/env bash
# Subprocess test for .dogfood/scripts/new-agent.sh --slash-only.
#
# Why shell, not Node test runner: the target IS a shell script, so a Node
# wrapper would add noise. Why subprocess with </dev/null + timeout: the
# `--slash-only` mode must NOT prompt under any condition. A future
# regression that adds a stray `read` would hang the subprocess; the
# timeout converts that into a loud failure instead of a silent CI stall
# (see docs/learnings/2026-Q2/non-interactive-flags-need-tty-audits.md).
#
# This script tests an unshipped artifact under .dogfood/. It is not wired
# into `pnpm smoke` (which is for shipped behavior only); invoke directly
# via `pnpm test:dogfood-scripts`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SCRIPT="$REPO_ROOT/.dogfood/scripts/new-agent.sh"
SOURCE_LIB="$REPO_ROOT/.dogfood/scripts/lib/functions.sh"
SOURCE_CONFIG="$REPO_ROOT/.dogfood/.config/functions.yaml"

if [ ! -f "$SOURCE_SCRIPT" ]; then
  echo "ERROR: $SOURCE_SCRIPT not found" >&2; exit 1
fi
if [ ! -f "$SOURCE_LIB" ]; then
  echo "ERROR: $SOURCE_LIB not found" >&2; exit 1
fi
if [ ! -f "$SOURCE_CONFIG" ]; then
  # Fall back to the shipped scaffold config if the dogfood copy is absent.
  SOURCE_CONFIG="$REPO_ROOT/templates/scaffold/.config/functions.yaml"
fi

TMPDIR_ROOT="$(mktemp -d -t roster-slash-only-XXXXXXXX)"
PASS_COUNT=0
FAIL_COUNT=0

cleanup() {
  local rc=$?
  rm -rf "$TMPDIR_ROOT" 2>/dev/null || true
  echo ""
  echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
  if [ $rc -eq 0 ] && [ "$FAIL_COUNT" -eq 0 ]; then
    echo "===> new-agent-slash-only PASS"
    exit 0
  else
    echo "===> new-agent-slash-only FAIL"
    exit 1
  fi
}
trap cleanup EXIT INT TERM

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# assert_nonzero_not_timeout <exit-code> <description>
# Use after run_subject when you EXPECT non-zero exit. Distinguishes a
# legitimate refusal (exit 1) from a timeout (exit 124) — without this,
# a stray `read` regression that hangs the subprocess would satisfy the
# "non-zero" assertion and pass for the wrong reason.
assert_nonzero_not_timeout() {
  local rc="$1" desc="$2"
  if [ "$rc" -eq 124 ]; then
    fail "$desc — subprocess TIMED OUT (5s, likely a hang or stray read)"
  elif [ "$rc" -ne 0 ]; then
    pass "$desc"
  else
    fail "$desc — expected non-zero exit, got 0"
  fi
}

# Set up a fresh workspace mimicking the layout the script expects:
#   <root>/scripts/new-agent.sh
#   <root>/scripts/lib/functions.sh
#   <root>/.config/functions.yaml
#   <root>/<fn>/<agent>/   (created per-test via touch_agent_tree)
make_workspace() {
  local ws="$1"
  mkdir -p "$ws/scripts/lib" "$ws/.config"
  cp "$SOURCE_SCRIPT" "$ws/scripts/new-agent.sh"
  cp "$SOURCE_LIB" "$ws/scripts/lib/functions.sh"
  cp "$SOURCE_CONFIG" "$ws/.config/functions.yaml"
  chmod +x "$ws/scripts/new-agent.sh"
}

touch_agent_tree() {
  local ws="$1" fn="$2" name="$3"
  mkdir -p "$ws/$fn/$name/subagents" "$ws/$fn/$name/plans"
  : > "$ws/$fn/$name/agent.md"
}

# Run the script under test with stdin from /dev/null + a 5s timeout.
# Exit code conventions:
#   0      — script exited 0
#   1..123 — script exited non-zero (propagated)
#   124    — TIMEOUT (subprocess hung; matches GNU `timeout(1)` convention)
# Callers that expect non-zero MUST use assert_nonzero_not_timeout to
# distinguish a hang from a legitimate refusal.
run_subject() {
  local ws="$1"; shift
  # macOS has no GNU `timeout` by default; use a portable perl one-liner.
  ( cd "$ws" && perl -e '
    use strict; use warnings;
    my $pid = fork();
    if ($pid == 0) { exec @ARGV or die "exec: $!"; }
    local $SIG{ALRM} = sub { kill 9, $pid; exit 124; };
    alarm 5;
    waitpid($pid, 0);
    alarm 0;
    exit($? >> 8);
  ' bash scripts/new-agent.sh "$@" </dev/null )
}

# -----------------------------------------------------------------------------
# Test 1: happy path
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 1: happy path"
WS="$TMPDIR_ROOT/t1"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "happy-agent"
if run_subject "$WS" --slash-only gtm happy-agent > "$WS/stdout" 2> "$WS/stderr"; then
  pass "exit 0 on happy path"
else
  fail "happy path exited non-zero (stderr: $(cat $WS/stderr))"
fi
if [ -f "$WS/.claude/commands/happy-agent.md" ]; then
  pass "slash command file created"
else
  fail "slash command file missing at .claude/commands/happy-agent.md"
fi
if grep -q 'description: "gtm agent' "$WS/.claude/commands/happy-agent.md" 2>/dev/null; then
  pass "description renders with function name"
else
  fail "description did not substitute function name"
fi
if grep -q "Created: .claude/commands/happy-agent.md" "$WS/stdout"; then
  pass "stdout reports created path"
else
  fail "stdout missing 'Created:' line"
fi

# -----------------------------------------------------------------------------
# Test 2: drift check — full-install and --slash-only produce byte-identical
# slash command files for the same fn/name. Regression trap for the shared
# write_slash_command helper.
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 2: full-install and --slash-only produce byte-identical slash commands"
WS="$TMPDIR_ROOT/t2"
make_workspace "$WS"
# Full install (no TTY → tool-bindings prompt is skipped)
if run_subject "$WS" gtm drift-agent > "$WS/full.stdout" 2> "$WS/full.stderr"; then
  pass "full-install exits 0"
else
  fail "full-install exited non-zero (stderr: $(cat $WS/full.stderr))"
fi
FULL_CMD_FILE="$WS/.claude/commands/drift-agent.md"
[ -f "$FULL_CMD_FILE" ] || { fail "full-install did not create slash command"; FULL_CMD_FILE=""; }
# Now in a separate workspace, manually stand up an agent tree (no full
# install) and use --slash-only.
WS2="$TMPDIR_ROOT/t2b"
make_workspace "$WS2"
touch_agent_tree "$WS2" "gtm" "drift-agent"
if run_subject "$WS2" --slash-only gtm drift-agent > "$WS2/stdout" 2> "$WS2/stderr"; then
  pass "--slash-only exits 0 in fresh workspace"
else
  fail "--slash-only exited non-zero (stderr: $(cat $WS2/stderr))"
fi
SLASH_CMD_FILE="$WS2/.claude/commands/drift-agent.md"
if [ -n "$FULL_CMD_FILE" ] && [ -f "$SLASH_CMD_FILE" ]; then
  if cmp -s "$FULL_CMD_FILE" "$SLASH_CMD_FILE"; then
    pass "byte-identical (no drift between modes)"
  else
    fail "DRIFT: full-install and --slash-only produced different content"
    diff "$FULL_CMD_FILE" "$SLASH_CMD_FILE" || true
  fi
fi

# -----------------------------------------------------------------------------
# Test 3: no-clobber — second --slash-only run on the same target exits 1
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 3: no-clobber"
WS="$TMPDIR_ROOT/t3"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "clobber-agent"
# Setup: the FIRST --slash-only must succeed for the clobber assertion to mean
# anything. If setup silently failed, the second call would also exit non-zero
# (no file to clobber), and the test would pass for the wrong reason.
if ! run_subject "$WS" --slash-only gtm clobber-agent > /dev/null 2> "$TMPDIR_ROOT/t3.setup.stderr"; then
  fail "clobber-test setup: first --slash-only failed (stderr: $(cat $TMPDIR_ROOT/t3.setup.stderr))"
fi
run_subject "$WS" --slash-only gtm clobber-agent > "$WS/stdout" 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "second --slash-only exits non-zero (no-clobber)"
if grep -q "already exists" "$WS/stderr"; then
  pass "stderr explains the clobber refusal"
else
  fail "stderr missing 'already exists' message (got: $(cat $WS/stderr))"
fi

# -----------------------------------------------------------------------------
# Test 4: agent tree missing — --slash-only refuses to scaffold a command
# that points at a nonexistent tree
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 4: agent tree must exist"
WS="$TMPDIR_ROOT/t4"
make_workspace "$WS"
run_subject "$WS" --slash-only gtm ghost-agent > "$WS/stdout" 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only with missing tree exits non-zero"
if grep -q "does not exist" "$WS/stderr"; then
  pass "stderr explains the missing-tree refusal"
else
  fail "stderr missing 'does not exist' message"
fi
if [ ! -d "$WS/.claude/commands" ]; then
  pass ".claude/commands/ not created on early abort"
else
  fail ".claude/commands/ was created despite abort"
fi

# -----------------------------------------------------------------------------
# Test 5: function not registered
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 5: function validation"
WS="$TMPDIR_ROOT/t5"
make_workspace "$WS"
touch_agent_tree "$WS" "nonexistent" "x-agent"
run_subject "$WS" --slash-only nonexistent x-agent > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only rejects unregistered function"
if grep -q "not a registered function" "$WS/stderr"; then
  pass "stderr explains the registry rejection"
else
  fail "stderr missing registry rejection message"
fi

# -----------------------------------------------------------------------------
# Test 6: invalid slug (defense-in-depth against ..foo footgun is handled
# by the existing slug regex)
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 6: slug validation"
WS="$TMPDIR_ROOT/t6"
make_workspace "$WS"
run_subject "$WS" --slash-only gtm Bad-Agent > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only rejects uppercase slug"
if grep -q "must be lowercase" "$WS/stderr"; then
  pass "stderr explains slug requirement"
else
  fail "stderr missing slug requirement message"
fi
# Also check the ..foo case explicitly per the path-validator-startswith-dotdot-footgun learning
WS6b="$TMPDIR_ROOT/t6b"
make_workspace "$WS6b"
run_subject "$WS6b" --slash-only gtm ..foo > /dev/null 2> "$WS6b/stderr"
assert_nonzero_not_timeout "$?" "--slash-only rejects ..foo slug (segment-anchored validation)"

# -----------------------------------------------------------------------------
# Test 7: flag misplacement — --slash-only must be the leading arg
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 7: flag must lead"
WS="$TMPDIR_ROOT/t7"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "tail-agent"
run_subject "$WS" gtm tail-agent --slash-only > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only at tail rejected (treated as 3-arg usage error)"

# -----------------------------------------------------------------------------
# Test 8: side-effect quarantine — --slash-only writes exactly one file
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 8: side-effect quarantine"
WS="$TMPDIR_ROOT/t8"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "quiet-agent"
BEFORE="$TMPDIR_ROOT/t8.before"
AFTER="$TMPDIR_ROOT/t8.after"
T8_STDERR="$TMPDIR_ROOT/t8.stderr"
( cd "$WS" && find . -type f -not -path './scripts/*' -not -path './.config/*' -not -path './gtm/quiet-agent/*' | sort > "$BEFORE" )
# Stderr redirect lands OUTSIDE the workspace so it does not appear in find.
if run_subject "$WS" --slash-only gtm quiet-agent > /dev/null 2> "$T8_STDERR"; then
  pass "side-effect test: --slash-only exits 0"
else
  fail "side-effect test: --slash-only exited non-zero (stderr: $(cat $T8_STDERR))"
fi
( cd "$WS" && find . -type f -not -path './scripts/*' -not -path './.config/*' -not -path './gtm/quiet-agent/*' | sort > "$AFTER" )
NEW_FILES=$(diff "$BEFORE" "$AFTER" | grep '^> ' | sed 's/^> //')
EXPECTED="./.claude/commands/quiet-agent.md"
if [ "$NEW_FILES" = "$EXPECTED" ]; then
  pass "exactly one new file written: $EXPECTED"
else
  fail "side-effect leak — new files were: $NEW_FILES"
fi

# -----------------------------------------------------------------------------
# Test 9: argv edge cases — duplicate flag, 0/1 positionals, unknown leading
# flag. The script's $# -ne 2 guard handles all of these as usage errors;
# these tests pin the behavior so a future flag addition can't quietly
# accept a malformed invocation.
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 9: argv edge cases"

# 9a. Duplicate --slash-only flag — the second --slash-only is consumed as a
# positional arg ($# becomes 3 after the first shift), hitting the usage guard.
WS="$TMPDIR_ROOT/t9a"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "dup-agent"
run_subject "$WS" --slash-only --slash-only gtm dup-agent > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "duplicate --slash-only flag rejected"

# 9b. --slash-only with 0 positionals (just the flag).
WS="$TMPDIR_ROOT/t9b"
make_workspace "$WS"
run_subject "$WS" --slash-only > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only with 0 positionals rejected"

# 9c. --slash-only with 1 positional.
WS="$TMPDIR_ROOT/t9c"
make_workspace "$WS"
run_subject "$WS" --slash-only gtm > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "--slash-only with 1 positional rejected"

# 9d. Unknown leading flag — must not match the --slash-only branch, falls
# through to full-install which then trips on the unrecognized function slug
# (because --foo is consumed as $FN). The important property: no slash command
# is written.
WS="$TMPDIR_ROOT/t9d"
make_workspace "$WS"
run_subject "$WS" --foo gtm test-agent > /dev/null 2> "$WS/stderr"
assert_nonzero_not_timeout "$?" "unknown leading flag rejected"
if [ ! -f "$WS/.claude/commands/test-agent.md" ]; then
  pass "unknown leading flag wrote no slash command"
else
  fail "unknown leading flag wrote .claude/commands/test-agent.md (should not have)"
fi

# -----------------------------------------------------------------------------
# Test 10: TTY trap — explicit verification that the subprocess never blocks
# on stdin (the 5s timeout above is the active guard; this test just
# documents that the happy path completes well under the timeout)
# -----------------------------------------------------------------------------
echo ""
echo "===> Test 10: no TTY hang"
WS="$TMPDIR_ROOT/t10"
make_workspace "$WS"
touch_agent_tree "$WS" "gtm" "fast-agent"
START=$(date +%s)
run_subject "$WS" --slash-only gtm fast-agent > /dev/null 2> /dev/null || true
END=$(date +%s)
ELAPSED=$((END - START))
if [ "$ELAPSED" -le 4 ]; then
  pass "no TTY hang (completed in ${ELAPSED}s, well under 5s timeout)"
else
  fail "suspicious latency: ${ELAPSED}s for a no-op script"
fi
