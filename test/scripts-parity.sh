#!/usr/bin/env bash
# Drift detector: every shell script present in BOTH .dogfood/scripts/
# and templates/scaffold/scripts/ must be byte-identical. Catches the
# moment someone edits one without the other.
#
# Why: .dogfood/scripts/ is gitignored (not shipped) and templates/
# scaffold/scripts/ ships in the npm tarball. Shipped chief-of-staff
# plans reference these scripts, so any divergence breaks user
# workspaces. The dual-copy invariant is enforced here until we promote
# templates/scaffold/scripts/ to canonical (see ROS-58 follow-up).
#
# Files in only one tree are FINE — this checks the intersection only.
# Run via `pnpm test:dogfood-scripts`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAFFOLD="$REPO_ROOT/templates/scaffold/scripts"
DOGFOOD="$REPO_ROOT/.dogfood/scripts"

if [ ! -d "$SCAFFOLD" ] || [ ! -d "$DOGFOOD" ]; then
  echo "scripts-parity: one of the trees is missing — skipping (this is fine for fresh checkouts)"
  exit 0
fi

PASS=0
FAIL=0

check_pair() {
  local scaffold_file="$1"
  local rel="${scaffold_file#$SCAFFOLD/}"
  local dogfood_file="$DOGFOOD/$rel"
  [ -f "$dogfood_file" ] || return 0  # scaffold-only file: fine
  if cmp -s "$scaffold_file" "$dogfood_file"; then
    printf "  \033[32m✓\033[0m %s\n" "$rel"
    PASS=$((PASS + 1))
  else
    printf "  \033[31m✗\033[0m DRIFT: %s\n" "$rel"
    diff "$scaffold_file" "$dogfood_file" | head -10
    FAIL=$((FAIL + 1))
  fi
}

echo "===> scripts-parity: scaffold ↔ dogfood byte-equality"
# Top-level scripts
for f in "$SCAFFOLD"/*.sh; do
  [ -e "$f" ] || continue
  check_pair "$f"
done
# lib/
for f in "$SCAFFOLD"/lib/*.sh; do
  [ -e "$f" ] || continue
  check_pair "$f"
done

echo ""
echo "===> $PASS in parity, $FAIL drifted"
if [ "$FAIL" -eq 0 ]; then
  echo "===> scripts-parity PASS"
  exit 0
else
  echo "===> scripts-parity FAIL — edit BOTH copies, or promote one to canonical"
  exit 1
fi
