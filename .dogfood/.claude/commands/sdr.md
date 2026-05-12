---
name: sdr
description: GTM SDR — outbound prospecting, cold outreach, reply handling. Workflows live in gtm/sdr/plans/.
---

# /sdr

You are operating the `gtm/sdr` agent. Load `gtm/sdr/agent.md` and the project's relevant context.

The user request is: $ARGUMENTS

## Routing logic

Parse the user request:

1. **If it matches `run <plan-name> for <project>` or `run <plan-name> on <project>`**:
   - Load `gtm/sdr/plans/<plan-name>.yaml`. Validate it exists. If not, list available plans in `gtm/sdr/plans/` and ask user to pick.
   - Load the project's `projects/<project>/CLAUDE.md` and relevant guidelines.
   - Load the agent-instance's `gtm/sdr/projects/<project>/config/default.yaml` (behavior + tool bindings).
   - Validate that all `required: true` tool bindings have non-TODO values. If any are TODO, abort with a message naming the missing bindings.
   - Execute the plan steps in order. Substitute `${tools.X.Y}`, `${inputs.X}`, `${config.X}` references from the loaded context.
   - Log the run to `gtm/sdr/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`.
   - Surface HITL approvals per the `approval_channel` setting.

2. **If only a project is named (no plan)**, e.g., `for _demo`:
   - List available plans from `gtm/sdr/plans/` with their descriptions.
   - Ask the user which plan to run.

3. **If neither plan nor project is named**:
   - List available projects (instances under `gtm/sdr/projects/`) and available plans.
   - Ask the user to specify both.

4. **For ad-hoc strategic / generative work** (not a workflow execution):
   - Suggest the user invoke the GTM expert instead (`gtm/EXPERT.md`).
   - Don't try to do goal-directed work in this agent — that's the expert's job.

## Constraints

- Don't invent plan names. Only run plans that exist as files in `gtm/sdr/plans/`.
- Don't bypass the approval gates declared in the plan or instance config.
- All file writes within a run go to the project-instance's `log/runs/...` directory unless the plan explicitly writes to project guidelines (which it shouldn't — that's expert work).
