#!/bin/sh
# roster:hitl-banner:v1 — SessionStart hook for Claude Code and Codex CLI.
#
# Counts pending HITL items in $PWD/roster/<function>/pending/*.md and
# prints one banner line if count > 0. Silent when count is 0.
#
# Self-contained POSIX shell — no Node, no roster CLI. Meets the
# <200ms session-start latency budget (typical p50 ~25ms).
#
# Installed by `roster hooks install` to:
#   ~/.claude/hooks/roster-banner.sh
#   ~/.codex/hooks/roster-banner.sh

set -u

# Run only inside roster workspaces. Quiet exit otherwise so non-roster
# sessions get zero overhead beyond shell startup.
[ -d "$PWD/roster" ] || exit 0

# `find … | wc -l` returns 0 on empty, never errors on absent subdirs
# thanks to `-path` matching against a non-existent prefix being a no-op
# (the explicit `2>/dev/null` covers any read-permission edge case).
count=$(find "$PWD/roster" -mindepth 3 -maxdepth 3 -type f -name '*.md' -path '*/pending/*.md' 2>/dev/null | wc -l | tr -d ' ')

if [ "${count:-0}" -gt 0 ]; then
  printf '⚠ %s pending HITL items — run `roster review`\n' "$count"
fi
