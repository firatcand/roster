# Shared script libraries

Helper functions for use across scripts. Empty for now — add as scripts grow.

Conventions:
- Bash: `<n>.sh`, sourced via `source "$(dirname $0)/lib/<n>.sh"`
- Python: `<n>.py` if needed (use `pip install --break-system-packages`)
- Keep functions narrow

Example future additions:
- `lib/lesson.sh` — read/write lesson files, validate schema
- `lib/run.sh` — append to run files, format frontmatter
- `lib/slack.sh` — HITL posting with retry
