#!/usr/bin/env bash
# Roster Phase 3 perf test.
#
# Measures the user-facing operations against the budgets in
# spec/SPEC.md §Performance targets:
#   roster install (warm)  ≤ 2s
#   roster init            ≤ 3s
#   roster doctor          ≤ 1s
#   npm pack tarball       ≤ 1 MB
#
# The cold-npx budget (≤ 10s) is a *manual* measurement: clearing the
# npm cache is a host-global side effect, so the script prints a
# copy-pasteable procedure instead of executing it automatically.
#
# Run from anywhere:  pnpm perf  |  bash test/perf.sh
# Exit non-zero on any budget miss.

set -euo pipefail

# Resolve repo root from this script's location so perf can be run from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PERF_DIR="$(mktemp -d -t roster-perf-XXXXXXXX)"
NPM_PREFIX="$PERF_DIR/npm-prefix"
CLAUDE_HOME="$PERF_DIR/claude"
WORKSPACE="$PERF_DIR/workspace"
FAKE_HOME="$PERF_DIR/fake-home"
mkdir -p "$NPM_PREFIX" "$CLAUDE_HOME" "$WORKSPACE" "$FAKE_HOME"

cleanup() {
  local rc=$?
  rm -rf "$PERF_DIR" 2>/dev/null || true
  if [ $rc -eq 0 ]; then
    echo ""
    echo "===> perf PASS"
  else
    echo ""
    echo "===> perf FAIL (exit $rc)"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Bash builtin `time` with TIMEFORMAT='%R' → elapsed seconds, three decimals.
# Group-command `{ ...; }` (not subshell) so the timer sees the redirect.
TIMEFORMAT='%R'
measure() {
  # measure <label> <budget-seconds> <command...>
  local label="$1" budget="$2"; shift 2
  local elapsed
  elapsed=$( { time "$@" >/dev/null 2>&1; } 2>&1 )
  budget_check "$label" "$elapsed" "$budget"
}
budget_check() {
  # budget_check <label> <elapsed-seconds> <budget-seconds>
  local label="$1" elapsed="$2" budget="$3"
  if awk "BEGIN{exit !($elapsed <= $budget)}"; then
    pass "$label: ${elapsed}s ≤ ${budget}s"
  else
    fail "$label: ${elapsed}s > ${budget}s"
  fi
}

echo "===> roster perf test"
echo "  perf dir: $PERF_DIR"

# 0. Cold npx — documented manual procedure
echo ""
echo "===> 0. Cold npx (manual; ≤ 10s budget)"
cat <<'EOF'
  To measure cold npx, run from a separate shell (clears host npm cache):
      npm cache clean --force
      rm -rf "$(npm config get cache)/_npx"
      time npx --yes @firatcand/roster --version
  Excluded from automated runs to avoid clobbering the host cache.
EOF

# 1. Build
echo ""
echo "===> 1. Build"
pnpm build > /dev/null
[ -x bin/roster.js ] || { fail "bin/roster.js not produced"; exit 1; }
pass "bin/roster.js produced and executable"

# 2. Pack + tarball size budget
echo ""
echo "===> 2. Pack (tarball ≤ 1 MB)"
TARBALL_NAME=$(npm pack --pack-destination "$PERF_DIR" 2>/dev/null | tail -1)
TARBALL="$PERF_DIR/$TARBALL_NAME"
TARBALL_KB=$(du -k "$TARBALL" | awk '{print $1}')
if [ "$TARBALL_KB" -le 1024 ]; then
  pass "tarball size: ${TARBALL_KB} KB ≤ 1024 KB"
else
  fail "tarball size: ${TARBALL_KB} KB > 1024 KB"
fi

# 3. Global install (isolated prefix) — setup, not measured
echo ""
echo "===> 3. Global install (isolated, not budgeted)"
npm install -g "$TARBALL" --prefix "$NPM_PREFIX" --no-audit --no-fund --silent > /dev/null
ROSTER_BIN="$NPM_PREFIX/bin/roster"
[ -x "$ROSTER_BIN" ] || { fail "roster binary not installed"; exit 1; }
pass "roster installed at $ROSTER_BIN"

# 4. roster install (warm) — prime once, then measure
echo ""
echo "===> 4. roster install (warm, ≤ 2s)"
# Prime filesystem caches with a discarded first run.
HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" \
  "$ROSTER_BIN" install --tool claude --silent > /dev/null 2>&1
# Recorded measurement (second run = warm).
measure "roster install (warm)" 2.0 \
  env HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" \
    "$ROSTER_BIN" install --tool claude --silent

# 5. roster init
echo ""
echo "===> 5. roster init (≤ 3s)"
cd "$WORKSPACE"
measure "roster init" 3.0 "$ROSTER_BIN" init perf-test --silent --no-git

# 6. roster doctor — audit the CLAUDE_HOME we just populated in step 4
#    (HOME + ROSTER_CLAUDE_HOME redirect → known-good state, exit 0).
#    CWD is irrelevant — doctor reads tool config dirs, not the workspace.
echo ""
echo "===> 6. roster doctor (≤ 1s)"
measure "roster doctor" 1.0 \
  env HOME="$FAKE_HOME" ROSTER_CLAUDE_HOME="$CLAUDE_HOME" \
    "$ROSTER_BIN" doctor

# 7. banner.sh — SessionStart hook latency. The hook fires on every CLI
#    session start in a roster workspace, so it has the tightest budget
#    of any roster surface: 200ms hard ceiling per ROS-37 acceptance.
#    Measured across three pending-item counts (0/10/100) — the budget
#    holds for all three.
echo ""
echo "===> 7. banner.sh SessionStart latency (≤ 0.2s, 3 scenarios)"
BANNER_SH="$REPO_ROOT/templates/hooks/banner.sh"
[ -x "$BANNER_SH" ] || { fail "banner.sh missing or not executable"; exit 1; }

BANNER_WS="$PERF_DIR/banner-ws"
mkdir -p "$BANNER_WS/roster/gtm/pending" "$BANNER_WS/roster/dreamer/pending"

# Scenario A: 0 pending items
measure "banner.sh (0 items)" 0.2 sh "$BANNER_SH" </dev/null

# Scenario B: 10 pending items spread across two functions
for i in $(seq 1 5); do echo "stub" > "$BANNER_WS/roster/gtm/pending/g$i.md"; done
for i in $(seq 1 5); do echo "stub" > "$BANNER_WS/roster/dreamer/pending/d$i.md"; done
(cd "$BANNER_WS" && measure "banner.sh (10 items)" 0.2 sh "$BANNER_SH" </dev/null)

# Scenario C: 100 pending items
for i in $(seq 6 50); do echo "stub" > "$BANNER_WS/roster/gtm/pending/g$i.md"; done
for i in $(seq 6 50); do echo "stub" > "$BANNER_WS/roster/dreamer/pending/d$i.md"; done
(cd "$BANNER_WS" && measure "banner.sh (100 items)" 0.2 sh "$BANNER_SH" </dev/null)

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
