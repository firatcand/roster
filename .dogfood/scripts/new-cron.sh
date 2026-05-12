#!/usr/bin/env bash
# new-cron.sh — scaffolds a cron job entry, wrapper, and prompt
# Usage: bash scripts/new-cron.sh <job-name>

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <job-name>"
  echo "Example: $0 _demo-outreach-daily"
  exit 1
fi

JOB="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$ROOT/scripts/cron/wrappers/$JOB.sh"
PROMPT="$ROOT/scripts/cron/wrappers/$JOB-prompt.txt"
CRONTAB="$ROOT/scripts/cron/crontab"

if ! [[ "$JOB" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "ERROR: Job name must be lowercase, alphanumeric + hyphens."
  exit 1
fi

if [ -f "$WRAPPER" ]; then
  echo "ERROR: Wrapper already exists at $WRAPPER"
  exit 1
fi

# Wrapper
cat > "$WRAPPER" << EOF
#!/usr/bin/env bash
# Cron wrapper for: $JOB
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

set -euo pipefail

ROOT="\$(cd "\$(dirname "\$0")/../../.." && pwd)"
LOG_DIR="\$ROOT/logs/cron"
LOG_FILE="\$LOG_DIR/$JOB-\$(date +%Y-%m-%d).log"

mkdir -p "\$LOG_DIR"

# Load .env if present
if [ -f "\$ROOT/.env" ]; then
  set -a
  source "\$ROOT/.env"
  set +a
fi

# Working directory matters — Claude Code reads .claude/ hierarchy from cwd
# For agent-specific jobs, cd into the agent's project instance:
#   cd "\$ROOT/<function>/<agent>/projects/<project>"
# For dreamer (cross-cutting), cd to root:
#   cd "\$ROOT"
cd "\$ROOT"

PROMPT_FILE="\$ROOT/scripts/cron/wrappers/$JOB-prompt.txt"

if [ ! -f "\$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file missing at \$PROMPT_FILE" >&2
  exit 1
fi

echo "[\$(date -u +%FT%TZ)] Starting $JOB" >> "\$LOG_FILE"

claude -p "\$(cat "\$PROMPT_FILE")" >> "\$LOG_FILE" 2>&1

EXIT_CODE=\$?

echo "[\$(date -u +%FT%TZ)] Finished $JOB with exit \$EXIT_CODE" >> "\$LOG_FILE"

exit \$EXIT_CODE
EOF

# Prompt template
cat > "$PROMPT" << EOF
You are running scheduled job: $JOB.

Trigger: cron.
Approval channel: slack — no interactive caller.
HITL channel: the agent's function channel (e.g., gtm/<agent> → #gtm, design/<agent> → #design,
dreamer/chief-of-staff → #admin). See conventions.md § "HITL routing" for the resolution table.

Replace this prompt with the actual job-specific prompt. Be specific about:
- Which agent to invoke (e.g., gtm/sdr)
- Which project (e.g., _demo)
- What inputs to use (file path, criteria, batch size)
- HITL routing (always slack for cron-triggered; channel = #<function> or #admin)

Example for _demo-outreach-daily:
"You are the sdr. cd to gtm/sdr/projects/_demo/.
Read agent.md, config, and guidelines. Pull today's batch from
projects/_demo/inputs/queue.csv (max 3 per cap). Run the full pipeline.
Route HITL to Slack #gtm."
EOF

# Append to crontab template (commented)
{
  echo ""
  echo "# $JOB — added $(date -u +%F)"
  echo "# Edit schedule, then uncomment to enable. Reinstall: bash scripts/cron/install.sh"
  echo "# 0 9 * * * $WRAPPER"
} >> "$CRONTAB"

chmod +x "$WRAPPER"

echo ""
echo "✓ Cron job scaffolded: $JOB"
echo ""
echo "Files created:"
echo "  Wrapper: $WRAPPER"
echo "  Prompt:  $PROMPT"
echo "  Crontab entry appended (commented): $CRONTAB"
echo ""
echo "Next steps:"
echo "  1. Edit $PROMPT — write the actual prompt for this job"
echo "  2. Edit the crontab line in $CRONTAB — set the schedule, uncomment"
echo "  3. Test manually first: bash $WRAPPER"
echo "  4. Install: bash scripts/cron/install.sh"
echo ""
echo "Logs land in logs/cron/$JOB-<date>.log"
