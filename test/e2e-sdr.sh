#!/usr/bin/env bash
# Roster Phase 2 end-to-end test: SDR contract is intact after `roster init`.
#
# Complements test/smoke.sh — which is the install-path gate (build → pack →
# global install → init). This script is the SDR-contract gate:
#
#   1. pnpm build the source
#   2. npm pack and assert the SDR contract files ship in the tarball
#      (skills/sdr/SKILL.md, gtm/sdr/agent.md + plans + subagents + .mcp.json,
#       projects/_demo/config/default.yaml)
#   3. roster init in a fresh tmp workspace, run non-interactively
#   4. Structural assertions: every SDR contract file the user needs is on disk
#   5. agent.md ⇄ disk cross-reference: every gtm/sdr/plans/*.yaml and
#      subagent .md mentioned by agent.md actually exists. Catches future drift
#      where someone renames a plan but forgets to update agent.md.
#   6. Demo config sanity (grep-only — no YAML parser dep)
#
# Manual gate (Claude Code can't be automated in CI):
#   After this script passes, re-run with --keep to preserve the workspace,
#   then in a separate terminal:
#       cd <workspace-path-printed-on-success>
#       claude
#       > /sdr run cold-outreach for _demo
#   The script prints the exact workspace path before exiting under --keep.
#
# Flags:
#   --keep   Skip tmp-dir cleanup on success. Workspace path is printed.
#            (Cleanup still runs on failure / Ctrl-C so we don't leak.)
#
# TTY guard: the `roster init` call is invoked with `< /dev/null` so any
# regression that re-introduces an unguarded prompt in the init path hangs CI
# instead of silently passing. See docs/learnings/2026-Q2/non-interactive-flags-need-tty-audits.md.

set -euo pipefail

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "e2e-sdr: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

E2E_DIR="$(mktemp -d -t roster-e2e-sdr-XXXXXXXX)"
WORKSPACE="$E2E_DIR/workspace"
mkdir -p "$WORKSPACE"

cleanup() {
  local rc=$?
  if [ "$KEEP" -eq 1 ] && [ "$rc" -eq 0 ]; then
    echo ""
    echo "===> e2e-sdr PASS — workspace preserved (--keep)"
    echo "  $WORKSPACE"
  else
    rm -rf "$E2E_DIR" 2>/dev/null || true
    if [ "$rc" -eq 0 ]; then
      echo ""
      echo "===> e2e-sdr PASS"
    else
      echo ""
      echo "===> e2e-sdr FAIL (exit $rc)"
    fi
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

echo "===> roster e2e-sdr"
echo "  tmp dir: $E2E_DIR"

# 1. Build (gives us a fresh bin/roster.js)
echo ""
echo "===> 1. Build"
pnpm build > /dev/null
assert "-x bin/roster.js" "bin/roster.js produced and executable"

# 2. Pack — assert the SDR contract ships in the tarball.
# We use `tar -tzf` on the real tarball (not `npm pack --dry-run`) so this
# catches the .gitignore-vs-files-allowlist divergence class. See:
# docs/learnings/2026-Q2/gitignore-vs-npm-files-allowlist.md
echo ""
echo "===> 2. Pack"
TARBALL_NAME=$(npm pack --pack-destination "$E2E_DIR" 2>/dev/null | tail -1)
TARBALL="$E2E_DIR/$TARBALL_NAME"
TARBALL_LIST="$E2E_DIR/tarball.list"
assert "-f \"$TARBALL\"" "tarball produced: $TARBALL_NAME"
tar -tzf "$TARBALL" > "$TARBALL_LIST"
for expected in \
  package/skills/sdr/SKILL.md \
  package/templates/scaffold/gtm/sdr/agent.md \
  package/templates/scaffold/gtm/sdr/.mcp.json \
  package/templates/scaffold/gtm/sdr/plans/cold-outreach.yaml \
  package/templates/scaffold/gtm/sdr/subagents/prospector.md \
  package/templates/scaffold/gtm/sdr/subagents/enricher.md \
  package/templates/scaffold/gtm/sdr/subagents/writer.md \
  package/templates/scaffold/gtm/sdr/subagents/critic.md \
  package/templates/scaffold/projects/_demo/config/default.yaml
do
  assert_contains "$TARBALL_LIST" "^$expected\$" "tarball contains $expected"
done

# 3. roster init in a fresh workspace, non-interactive.
# `< /dev/null` is the TTY-audit guard from the ROS-16 learning:
# any regression that adds an unguarded prompt in the init path hangs here
# instead of silently passing on a real terminal.
echo ""
echo "===> 3. roster init (non-interactive)"
cd "$WORKSPACE"
node "$REPO_ROOT/bin/roster.js" init e2e-sdr-demo --silent --no-git < /dev/null
assert "-f CLAUDE.md" "CLAUDE.md exists"

# 4. SDR contract files exist in the initialized workspace
echo ""
echo "===> 4. SDR contract files present"
SDR_AGENT="gtm/sdr/agent.md"
assert "-f \"$SDR_AGENT\"" "$SDR_AGENT exists"
assert "-f gtm/sdr/.mcp.json" "gtm/sdr/.mcp.json exists"
assert "-f gtm/sdr/plans/cold-outreach.yaml" "gtm/sdr/plans/cold-outreach.yaml exists"
for sub in prospector enricher writer critic; do
  assert "-f gtm/sdr/subagents/${sub}.md" "gtm/sdr/subagents/${sub}.md exists"
done
assert "-f projects/_demo/config/default.yaml" "projects/_demo/config/default.yaml exists"
assert "-f projects/_demo/CLAUDE.md" "projects/_demo/CLAUDE.md exists"
assert "-f projects/_demo/guidelines/voice.md" "projects/_demo/guidelines/voice.md exists"
assert "-f conventions.md" "conventions.md exists"
assert "-f .config/functions.yaml" ".config/functions.yaml exists"

# 5. agent.md ⇄ disk cross-reference.
# Every plan listed in agent.md's "## Plans" section as `- \`<name>\` — ...`
# must resolve to gtm/sdr/plans/<name>.yaml. Also pick up any literal
# `gtm/sdr/plans/<name>.yaml` paths if they appear elsewhere. Catches future
# drift where someone renames a plan but forgets to update agent.md.
echo ""
echo "===> 5. agent.md cross-reference"
PLAN_SECTION=$(awk '/^## Plans/{flag=1;next} /^## /{flag=0} flag' "$SDR_AGENT")
PLAN_NAMES_BULLETS=$(printf '%s\n' "$PLAN_SECTION" | grep -oE '^- `[a-z0-9_-]+`' | sed -E 's/^- `([a-z0-9_-]+)`/\1/' || true)
PLAN_NAMES_LITERAL=$(grep -oE 'gtm/sdr/plans/[a-z0-9_-]+\.yaml' "$SDR_AGENT" | sed -E 's|gtm/sdr/plans/([a-z0-9_-]+)\.yaml|\1|' || true)
PLAN_NAMES=$(printf '%s\n%s\n' "$PLAN_NAMES_BULLETS" "$PLAN_NAMES_LITERAL" | grep -v '^$' | sort -u || true)
if [ -z "$PLAN_NAMES" ]; then
  fail "agent.md '## Plans' section has no plan bullets — expected at least cold-outreach"
else
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    assert "-f \"gtm/sdr/plans/${name}.yaml\"" "agent.md → gtm/sdr/plans/${name}.yaml resolves"
  done <<< "$PLAN_NAMES"
fi

# Subagent references: agent.md lists them as bare filenames in the Subagents
# section (e.g., `prospector.md`). Confirm each documented subagent .md exists
# under gtm/sdr/subagents/.
for sub in prospector enricher writer critic; do
  if grep -qE "\b${sub}\.md\b" "$SDR_AGENT"; then
    assert "-f gtm/sdr/subagents/${sub}.md" "agent.md → gtm/sdr/subagents/${sub}.md resolves"
  else
    fail "agent.md no longer mentions ${sub}.md — Subagents section drift?"
  fi
done

# 6. Demo project config sanity — grep-only, no YAML parser dependency
echo ""
echo "===> 6. _demo config sanity"
DEMO_CFG="projects/_demo/config/default.yaml"
assert_contains "$DEMO_CFG" "^display_name:" "$DEMO_CFG has display_name"
assert_contains "$DEMO_CFG" "^motion:" "$DEMO_CFG has motion"
assert_contains "$DEMO_CFG" "^approval_channel:" "$DEMO_CFG has approval_channel"

# 7. Manual gate hint
echo ""
echo "===> Manual Claude Code gate (NOT run by this script)"
if [ "$KEEP" -eq 1 ] && [ "$FAIL_COUNT" -eq 0 ]; then
  echo "  Workspace preserved via --keep:"
  echo "    cd $WORKSPACE"
  echo "    claude"
  echo "    > /sdr run cold-outreach for _demo"
else
  echo "  Re-run with --keep to preserve the workspace, then:"
  echo "    cd <workspace-path>"
  echo "    claude"
  echo "    > /sdr run cold-outreach for _demo"
fi

# Summary
echo ""
echo "===> $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
