#!/usr/bin/env bash
# install.sh — installs the versioned crontab into the user's actual crontab
# Usage: bash scripts/cron/install.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CRONTAB_FILE="$ROOT/scripts/cron/crontab"

if [ ! -f "$CRONTAB_FILE" ]; then
  echo "ERROR: $CRONTAB_FILE not found"
  exit 1
fi

# Backup current crontab
BACKUP="$HOME/.crontab.backup.$(date +%Y%m%d-%H%M%S)"
crontab -l > "$BACKUP" 2>/dev/null || echo "# (no previous crontab)" > "$BACKUP"
echo "Previous crontab backed up to: $BACKUP"

TMP_FILE=$(mktemp)

# Get existing crontab without our managed section
crontab -l 2>/dev/null | awk '
  /^# AGENT-TEAM-START$/ { skip=1; next }
  /^# AGENT-TEAM-END$/   { skip=0; next }
  !skip                  { print }
' > "$TMP_FILE" || true

# Append our managed section
{
  echo ""
  echo "# AGENT-TEAM-START"
  echo "# Managed by agent-team. Edit scripts/cron/crontab and re-run install.sh."
  cat "$CRONTAB_FILE"
  echo "# AGENT-TEAM-END"
} >> "$TMP_FILE"

crontab "$TMP_FILE"
rm "$TMP_FILE"

echo ""
echo "✓ Crontab installed."
echo "  Verify: crontab -l"
echo "  Logs land in: $ROOT/logs/cron/"
