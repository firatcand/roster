# Shared script libraries

Helper functions for use across scripts.

Conventions:
- Bash: `<n>.sh`, sourced via `source "$(dirname $0)/lib/<n>.sh"`
- Python: `<n>.py` if needed (use `pip install --break-system-packages`)
- Keep functions narrow

## Current inhabitants

- `functions.sh` — read/validate the function registry at `.config/functions.yaml`. Pure bash + falls back to `python3` + `pyyaml` when available for safer YAML parsing.
- `bindings-prompt.sh` — **disabled in v1.0**. Phase 2 will rebuild this around the env-merge loader (config.yaml `tools:` metadata + `/.env` values). Until then, invocation aborts with manual-configuration instructions (edit agent.md `## Tools and bindings` → mirror the YAML block into `<agent>/config.yaml` → add env-var values to `/.env`). The file remains in the tarball + executable so smoke continues to assert presence; the runtime behavior is the guard message.

Example future additions:
- `lib/lesson.sh` — read/write lesson files, validate schema
- `lib/run.sh` — append to run files, format frontmatter
- `lib/slack.sh` — HITL posting with retry
