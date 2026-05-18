#!/bin/sh
# roster:hitl-banner:v2 — SessionStart hook for Claude Code and Codex CLI.
#
# 1. (ROS-42) If `roster` is on PATH, run `roster pending sync --silent` with
#    a 5s timeout to synthesize HITL items from any failed-fire signals
#    (.exit non-zero + STALE detections). Silent on success, silent on
#    skip-because-no-roster, silent on timeout.
# 2. Count pending HITL items in $PWD/roster/<function>/pending/*.md and
#    print one banner line if count > 0. Silent when count is 0.
#
# Self-contained POSIX shell — Step 1 is best-effort opt-in, never blocks
# the session. Step 2 stays under the <200ms latency budget (p50 ~25ms).
#
# Installed by `roster hooks install` to:
#   ~/.claude/hooks/roster-banner.sh
#   ~/.codex/hooks/roster-banner.sh

set -u

# Run only inside roster workspaces. Quiet exit otherwise so non-roster
# sessions get zero overhead beyond shell startup.
[ -d "$PWD/roster" ] || exit 0

# Step 1: failed-fire synthesis (best-effort).
# Run only if `roster` resolves AND a `timeout` binary is available. macOS
# ships `gtimeout` via coreutils; Linux ships `timeout`. Fall back to no
# wrapper if neither is present — the sync is bounded by its own logic and
# typically <100ms on a small workspace.
if command -v roster >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 roster pending sync --silent --cwd "$PWD" >/dev/null 2>&1 || true
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout 5 roster pending sync --silent --cwd "$PWD" >/dev/null 2>&1 || true
  else
    roster pending sync --silent --cwd "$PWD" >/dev/null 2>&1 || true
  fi
fi

# Step 2: banner. `find … | wc -l` returns 0 on empty, never errors on
# absent subdirs thanks to `-path` matching against a non-existent prefix
# being a no-op (the explicit `2>/dev/null` covers any read-permission
# edge case).
count=$(find "$PWD/roster" -mindepth 3 -maxdepth 3 -type f -name '*.md' -path '*/pending/*.md' 2>/dev/null | wc -l | tr -d ' ')

if [ "${count:-0}" -gt 0 ]; then
  printf '⚠ %s pending HITL items — run `roster review`\n' "$count"
fi
