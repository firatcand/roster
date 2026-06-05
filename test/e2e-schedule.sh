#!/usr/bin/env bash
# ROS-40 — Phase 2.5 scheduling end-to-end shell test.
#
# Exercises the published-package install path for Codex `--via cron`:
#   1. Build + pack + global-install the tarball (mirrors smoke.sh isolation)
#   2. Stub `crontab` on PATH so writes go to a tmp file (not the user's real crontab)
#   3. Seed Codex auth.json with subscription tokens (preflight passes)
#   4. roster init in a scratch workspace
#   5. roster schedule install --tool codex --via cron
#   6. Assert the crontab line includes `env -i` and
#      `shell_environment_policy.inherit=core`, and the marker block
#   7. roster schedule remove --yes
#   8. Assert the crontab block is gone
#
# CRITICAL: the test does NOT actually fire any cron — installing a stub
# `crontab` on PATH ensures the user's real crontab is never touched,
# and the cron line never executes. This is enforced even if the test
# crashes mid-flow by `trap cleanup EXIT INT TERM`.

set -euo pipefail

# Resolve repo root from script location so this can run from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

E2E_DIR="$(mktemp -d -t roster-e2e-schedule-XXXXXXXX)"
NPM_PREFIX="$E2E_DIR/npm-prefix"
CODEX_HOME="$E2E_DIR/codex"
WORKSPACE="$E2E_DIR/workspace"
FAKE_HOME="$E2E_DIR/fake-home"
STUB_BIN="$E2E_DIR/stub-bin"
CRONTAB_FILE="$E2E_DIR/fake-crontab"
FAKE_CODEX="$STUB_BIN/codex"

mkdir -p "$NPM_PREFIX" "$CODEX_HOME" "$WORKSPACE" "$FAKE_HOME" "$STUB_BIN"

cleanup() {
  local rc=$?
  rm -rf "$E2E_DIR" 2>/dev/null || true
  if [ $rc -eq 0 ]; then
    echo ""
    echo "===> e2e-schedule PASS"
  else
    echo ""
    echo "===> e2e-schedule FAIL (exit $rc)"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
assert() {
  if eval "[ $1 ]"; then pass "$2"; else fail "$2 (test: [ $1 ])"; fi
}
assert_contains() {
  if grep -q -- "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3 (pattern '$2' not in $1)"; fi
}
assert_not_contains() {
  if grep -q -- "$2" "$1" 2>/dev/null; then fail "$3 (pattern '$2' still in $1)"; else pass "$3"; fi
}

echo "===> roster scheduling e2e test (ROS-40)"
echo "  e2e dir: $E2E_DIR"

# ── 1. Stub `crontab` on PATH ─────────────────────────────────────────────
# The stub emulates the two operations defaultCrontabIO() uses:
#   crontab -l → read the fake crontab file (or "no crontab" if missing)
#   crontab -  → overwrite the fake crontab file from stdin
# It does NOT touch the user's real crontab, even if invoked outside this test.
echo ""
echo "===> 1. Stub crontab on PATH"
cat > "$STUB_BIN/crontab" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
: "${ROSTER_TEST_CRONTAB:?ROSTER_TEST_CRONTAB env var required for stub crontab}"
case "${1:-}" in
  -l)
    if [ -f "$ROSTER_TEST_CRONTAB" ]; then
      cat "$ROSTER_TEST_CRONTAB"
    else
      echo "no crontab for $USER" >&2
      exit 1
    fi
    ;;
  -)
    cat > "$ROSTER_TEST_CRONTAB"
    ;;
  *)
    echo "stub crontab: unsupported args: $*" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$STUB_BIN/crontab"
assert "-x \"$STUB_BIN/crontab\"" "stub crontab is executable"

# Fake codex binary — must exist so `command -v codex` resolves under
# resolveCodexBinaryPath, but is never actually invoked because the cron
# line is never fired in this test.
cat > "$FAKE_CODEX" <<'CODEX'
#!/usr/bin/env bash
echo "stub codex called: $*" >&2
exit 0
CODEX
chmod +x "$FAKE_CODEX"

# ── 2. Seed Codex auth.json so preflight passes ───────────────────────────
echo ""
echo "===> 2. Seed Codex auth"
cat > "$CODEX_HOME/auth.json" <<'AUTH'
{ "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": { "id_token": "stub", "access_token": "stub", "refresh_token": "stub", "account_id": "stub" } }
AUTH
assert "-f \"$CODEX_HOME/auth.json\"" "auth.json seeded for preflight"

# ── 3. Build + pack + install globally to isolated prefix ─────────────────
echo ""
echo "===> 3. Build + pack + install"
pnpm build > /dev/null
TARBALL_NAME=$(npm pack --pack-destination "$E2E_DIR" 2>/dev/null | tail -1)
TARBALL="$E2E_DIR/$TARBALL_NAME"
npm install -g "$TARBALL" --prefix "$NPM_PREFIX" --no-audit --no-fund --silent > /dev/null
ROSTER_BIN="$NPM_PREFIX/bin/roster"
assert "-x \"$ROSTER_BIN\"" "roster binary installed at $ROSTER_BIN"

# Compose the environment the CLI sees during install / remove.
# stub-bin precedes everything: crontab → stub, codex → fake.
# Node's bin dir is included because the shebang in `bin/roster.js`
# is `#!/usr/bin/env node` — env looks up node on PATH, not just /usr/bin.
NODE_BIN_DIR="$(dirname "$(command -v node)")"
TEST_PATH="$STUB_BIN:$NPM_PREFIX/bin:$NODE_BIN_DIR:/usr/bin:/bin"

# ── 4. roster init ────────────────────────────────────────────────────────
echo ""
echo "===> 4. roster init workspace"
cd "$WORKSPACE"
HOME="$FAKE_HOME" PATH="$TEST_PATH" "$ROSTER_BIN" init my-e2e-workspace --silent --no-git
assert "-f CLAUDE.md" "workspace CLAUDE.md exists"
assert "-d gtm" "gtm/ function dir scaffolds (v1.0: empty function dir, no sdr/)"

# ── 5. Install one Codex --via cron schedule ──────────────────────────────
echo ""
echo "===> 5. roster schedule install --tool codex --via cron"
# We pass:
#   ROSTER_TEST_CRONTAB → the stub's tmp file (intercepts `crontab` calls)
#   ROSTER_CODEX_PATH   → fake codex binary (resolved before PATH lookup)
#   HOME                → fake home (preflight reads $HOME/.codex)
# CODEX_HOME is deliberately NOT set; preflight wants $HOME/.codex, so we
# symlink/copy our seeded auth into $FAKE_HOME/.codex.
mkdir -p "$FAKE_HOME/.codex"
cp "$CODEX_HOME/auth.json" "$FAKE_HOME/.codex/auth.json"

HOME="$FAKE_HOME" \
  PATH="$TEST_PATH" \
  ROSTER_TEST_CRONTAB="$CRONTAB_FILE" \
  ROSTER_CODEX_PATH="$FAKE_CODEX" \
  "$ROSTER_BIN" schedule install \
    gtm/sdr cold-outreach \
    --cron "0 9 * * 1-5" \
    --tool codex \
    --via cron \
    --silent

assert "-f \"$CRONTAB_FILE\"" "stub crontab file was written by install"

# ── 6. Assert crontab line content ────────────────────────────────────────
echo ""
echo "===> 6. Assert crontab line content"
# Subscription-safety markers from ADR-0001:
assert_contains "$CRONTAB_FILE" "env -i"                                "crontab line contains 'env -i' wrapper"
assert_contains "$CRONTAB_FILE" "shell_environment_policy.inherit=core" "crontab line passes shell_environment_policy.inherit=core"
# Roster-managed block markers:
assert_contains "$CRONTAB_FILE" "# roster:schedule:sdr-cold-outreach:begin" "crontab has roster begin marker"
assert_contains "$CRONTAB_FILE" "# roster:schedule:sdr-cold-outreach:end"   "crontab has roster end marker"
# Cron expression (escaped for grep regex):
assert_contains "$CRONTAB_FILE" "0 9 \* \* 1-5"                              "crontab line includes the cron expression"
# Forwarded env vars only:
assert_contains "$CRONTAB_FILE" "HOME=\"\\\$HOME\""                          "crontab forwards HOME"
assert_contains "$CRONTAB_FILE" "CODEX_HOME=\"\\\$HOME/.codex\""             "crontab forwards CODEX_HOME"
# CRITICAL: no API-key env vars must appear in the env -i forward list.
assert_not_contains "$CRONTAB_FILE" "OPENAI_API_KEY"    "crontab line never forwards OPENAI_API_KEY"
assert_not_contains "$CRONTAB_FILE" "CODEX_API_KEY"     "crontab line never forwards CODEX_API_KEY"
assert_not_contains "$CRONTAB_FILE" "ANTHROPIC_API_KEY" "crontab line never forwards ANTHROPIC_API_KEY"
# Use of `claude -p` would consume API credits → must never appear (ADR-0001).
assert_not_contains "$CRONTAB_FILE" "claude -p" "crontab line never uses 'claude -p' (subscription-safety)"

# ── 7. roster schedule remove --yes ──────────────────────────────────────
echo ""
echo "===> 7. roster schedule remove --yes"
HOME="$FAKE_HOME" \
  PATH="$TEST_PATH" \
  ROSTER_TEST_CRONTAB="$CRONTAB_FILE" \
  ROSTER_CODEX_PATH="$FAKE_CODEX" \
  "$ROSTER_BIN" schedule remove sdr-cold-outreach --yes --silent

# ── 8. Assert crontab cleanup ─────────────────────────────────────────────
echo ""
echo "===> 8. Assert crontab cleanup"
assert_not_contains "$CRONTAB_FILE" "# roster:schedule:sdr-cold-outreach" "begin/end markers removed from crontab"
assert_not_contains "$CRONTAB_FILE" "shell_environment_policy.inherit=core" "cron line removed from crontab"

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
