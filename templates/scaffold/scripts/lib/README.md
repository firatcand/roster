# Shared script libraries

Helper functions for use across scripts.

Conventions:
- Bash: `<n>.sh`, sourced via `source "$(dirname $0)/lib/<n>.sh"`
- Python: `<n>.py` if needed (use `pip install --break-system-packages`)
- Keep functions narrow

## Current inhabitants

- `functions.sh` — read/validate the function registry at `.config/functions.yaml`. Pure bash + falls back to `python3` + `pyyaml` when available for safer YAML parsing.
- `bindings-prompt.sh` — interactive prompts for per-tool bindings during agent scaffolding (called by `new-agent.sh`). Requires `python3` + `pyyaml` for the YAML output rendering (falls back gracefully when unavailable).

Example future additions:
- `lib/lesson.sh` — read/write lesson files, validate schema
- `lib/run.sh` — append to run files, format frontmatter
- `lib/slack.sh` — HITL posting with retry
