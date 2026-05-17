---
name: stub-agent
description: stub-fn agent — TODO: fill in description
---

# /stub-agent

You are operating the `stub-fn/stub-agent` agent. Load `stub-fn/stub-agent/agent.md` and the project's relevant context.

The user request is: $ARGUMENTS

## Routing logic

Parse the user request:

1. **If it matches `run <plan-name> for <project>` or `run <plan-name> on <project>`**:
   - Load `stub-fn/stub-agent/plans/<plan-name>.yaml`. If it doesn't exist, list available plans and ask user to pick.
   - Load `projects/<project>/CLAUDE.md` and relevant guidelines.
   - Load `stub-fn/stub-agent/projects/<project>/config/default.yaml`.
   - Validate that all required tool bindings are non-TODO. Abort if not.
   - Execute the plan steps. Substitute `${tools.X.Y}`, `${inputs.X}`, `${config.X}`.
   - Log to `stub-fn/stub-agent/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.
   - Surface HITL approvals per the plan's approval_channel.

2. **If only a project is named (no plan)**:
   - List available plans from `stub-fn/stub-agent/plans/` with descriptions. Ask user to pick.

3. **If neither plan nor project is named**:
   - List available projects and plans. Ask user to specify both.

4. **For ad-hoc strategic work**: suggest invoking `stub-fn/EXPERT.md` instead.

## Constraints

- Only run plans that exist as files in `stub-fn/stub-agent/plans/`.
- Don't bypass approval gates.
- File writes go to the instance's `log/runs/` unless the plan explicitly writes elsewhere.
