---
name: stub-agent
description: "stub-fn agent — TODO: fill in description"
---

# /stub-agent

You are operating the `stub-fn/stub-agent` agent. Load `stub-fn/stub-agent/agent.md` and the workspace's relevant context.

The user request is: $ARGUMENTS

## Routing logic

Parse the user request:

1. **If it matches `run <plan-name>`**:
   - Load `stub-fn/stub-agent/plans/<plan-name>.yaml`. If it doesn't exist, list available plans and ask user to pick.
   - Load `stub-fn/stub-agent/config.yaml` and resolve env via `resolveAgentEnv` (`stub-fn/stub-agent/.env` overrides workspace `/.env`).
   - Load workspace guidelines referenced under `config.yaml` `guideline_refs:` (e.g., `/guidelines/voice.md`, `/guidelines/icps/`, `/guidelines/messaging.md`).
   - Validate that all required tool bindings have non-empty env vars. Abort with a clear message if not.
   - Execute the plan steps. Substitute `${tools.X.env_var}`, `${inputs.X}`, `${config.X}`.
   - Log to `stub-fn/stub-agent/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.
   - Surface HITL approvals per the plan's `approval_channel`.

2. **If no plan is named**:
   - List available plans from `stub-fn/stub-agent/plans/` with descriptions. Ask user to pick.

3. **For ad-hoc strategic work**: suggest invoking `stub-fn/EXPERT.md` instead.

## Constraints

- Only run plans that exist as files in `stub-fn/stub-agent/plans/`.
- Don't bypass approval gates.
- File writes go to `stub-fn/stub-agent/logs/runs/` unless the plan explicitly writes elsewhere.
