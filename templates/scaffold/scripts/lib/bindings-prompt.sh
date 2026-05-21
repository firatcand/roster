#!/usr/bin/env bash
# bindings-prompt.sh — DISABLED in v1.0 (ROS-78).
#
# Pre-v1.0 behavior: read `## Tools and bindings` from agent.md (legacy
# two-level `tool: key: {required, description}` schema), prompt the user
# for binding values, and append a `tools:` block to a project-instance
# config at `projects/<inst>/config/default.yaml`.
#
# Both inputs change in v1.0:
#   1. The shipped `## Tools and bindings` block in agent.md is now a flat
#      schema (`tool: { env_var, required, description }` per
#      conventions.md). The legacy parser silently emits an empty
#      `tools.<tool>:` block when it encounters scalar values where it
#      expects a mapping.
#   2. The instance-config target is gone — agent config lives at
#      `<function>/<agent>/config.yaml`, and env-var values belong in
#      workspace `/.env` (overridable in `<agent>/.env`).
#
# The proper v1.0 flow (read agent.md flat schema → write metadata to
# config.yaml `tools:` block → prompt for required env-var values and
# append to `/.env`) requires the env-merge loader that ships in Phase 2.
# Rather than ship a script whose advertised behavior is broken against
# the new schema, this script aborts with manual-configuration instructions
# (edit agent.md schema → mirror to config.yaml → fill /.env).
#
# Tracking: re-enable as part of the Phase 2 cli-plumbing reshape
# (env-merge loader + doctor checks 13-15).

set -euo pipefail

cat >&2 <<'MSG'
bindings-prompt.sh is disabled in Roster v1.0.

The legacy two-level schema parser this script uses is incompatible with
the flat ## Tools and bindings schema documented in conventions.md
("Tool bindings" section). The Phase 2 reshape (env-merge loader +
config.yaml/.env split) will rebuild this flow.

Until Phase 2 lands, configure tool bindings by hand:

  1. Open <function>/<agent>/agent.md and confirm the ## Tools and
     bindings YAML block lists each tool with env_var, required, and
     description fields (see conventions.md § "Tool bindings").
  2. Mirror that block as the tools: mapping in
     <function>/<agent>/config.yaml.
  3. Add the corresponding env var values to workspace /.env (or, for
     agent-scoped overrides, <function>/<agent>/.env).

(The chief-of-staff guided create-agent flow shipped in v0.4 is also on
the pre-v1 shape; it will be updated alongside the env-merge loader.)
MSG

exit 2
