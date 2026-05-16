---
name: roster-orchestrator
description: "Bootstraps roster workspaces. On chat session start, surfaces pending HITL items as a single banner. On a scheduled fire, verifies the schedule is registered, dispatches the named agent via the host tool's native subagent primitive, writes a run log + state.md entry, and exits. Reads roster/<function>/schedules.yaml and roster/<function>/pending/. Subscription-billed primitives only — never invokes claude -p, claude --prompt, claude api, or the Anthropic SDK."
version: "0.1.0"
trigger_conditions:
  - "Session start in a roster workspace (CONTEXT.md / CLAUDE.md / AGENTS.md present at cwd)"
  - "A scheduled fire prompt names a roster agent (e.g., 'Run sdr cold-outreach for _demo')"
  - "User invokes /roster-orchestrator"
---

# roster-orchestrator

The bootstrap entry point for every fresh CLI session in a roster workspace. Two modes:

1. **Chat-session bootstrap** — surface a single banner if `roster/*/pending/` has items.
2. **Scheduled fire** — verify the fire matches a registered schedule, dispatch the named agent, log the run, exit.

The skill is **stateless**. It re-reads disk on every invocation so `/clear` and fresh fires both work identically.

## Working directory

Operate from the workspace root only — the directory containing `CONTEXT.md` (or the `CLAUDE.md` / `AGENTS.md` symlink that points to it) plus a `roster/` directory. If invoked elsewhere, abort with:

> Run roster-orchestrator from your roster workspace root (must contain CONTEXT.md and roster/).

## Mode detection

Inspect the initial prompt:

- If it matches a scheduled-fire shape (`Run <agent> <plan> for <project>`, `Use the <agent> skill to <plan> for <project>`, etc.) → **scheduled-fire mode**.
- Otherwise → **chat-session-bootstrap mode**.

When ambiguous, default to chat-session-bootstrap (it is the safe no-op when no fire is happening).

## Mode 1 — Chat-session bootstrap

1. Walk `roster/*/pending/` across all functions (`gtm`, `product`, `design`, `ops`, `marketing`, …).
2. Count files matching `*.md` (one HITL item per file).
3. If count == 0 → print nothing, exit silently.
4. If count > 0 → print one banner line and stop:
   ```
   ⚠ N pending HITL items — run `roster review`
   ```
   (Single-line surface. The full review UI lives behind the `roster review` CLI.)

No other side effects. Do not read item bodies. Do not modify any file.

## Mode 2 — Scheduled fire

1. Parse the fire prompt for `<agent>`, `<plan>`, `<project>`. Refuse if any of those are missing.
2. Load `roster/<function>/schedules.yaml`. The `<function>` is the directory the named agent lives in (`gtm/sdr` → function = `gtm`).
3. Verify an entry exists in `schedules.yaml` with matching `agent` + `plan` + `project`. If not, abort with:
   > Schedule not registered: <agent>/<plan> for <project>. Use `roster schedule list` to see registered schedules.
4. Dispatch the named agent via the host tool's subagent primitive (see "Subagent dispatch" below). Block until the subagent returns. The subagent runs in isolated context; nothing leaks back here.
5. Append a single line to `roster/<function>/state.md`:
   ```
   <ISO-timestamp> | <agent>/<plan>/<project> | <status>
   ```
6. The subagent itself is responsible for the full run log at `<agent>/projects/<project>/log/runs/<ts>.md`. Do not write that file from here.
7. Exit cleanly. Do not start a new turn.

## Subagent dispatch

The skill body is tool-agnostic. Use the dispatch idiom that matches the host CLI:

### On Claude Code

Use the `Task` tool with `run_in_background: false`:

```
Task(
  subagent_type="<agent>",
  prompt="Run plan <plan> for project <project>",
  run_in_background=false,
)
```

The subagent runs in isolated context. The return value is a short status string (~30 tokens). No other tools should be invoked in this turn.

### On Codex CLI

Invoke the subagent via natural language. Codex resolves the agent name against `~/.codex/agents/<agent>.toml`:

> Use the `<agent>` subagent to run plan `<plan>` for project `<project>`.

Wait for the subagent to return its status, then proceed to the state.md write.

## Subscription-billing guarantee

This skill — and every subagent it dispatches — must run on the user's interactive Claude Pro/Max or ChatGPT Plus/Pro subscription. **Banned primitives** (any occurrence is a release blocker, enforced by `roster doctor` and CI audit):

- `claude -p` <!-- roster-audit-ok: documentation -->
- `claude --prompt` <!-- roster-audit-ok: documentation -->
- `claude api` <!-- roster-audit-ok: documentation -->
- `@anthropic-ai/sdk` <!-- roster-audit-ok: documentation -->
- `from anthropic` <!-- roster-audit-ok: documentation -->
- Any wrapper that re-routes calls through the Agent SDK billing pool

If you encounter a workflow that seems to require one of the above, stop and surface it as a HITL item. Do not attempt to bypass.

## What this skill does NOT do

- Execute business logic (SDR outreach, content drafts, design generation). That's the dispatched subagent's job.
- Read or modify HITL item bodies. That's `roster review`.
- Write the full run log. That's the dispatched subagent.
- Touch git. Roster never auto-commits.
- Invoke any model billing path other than the host tool's native subscription.

## Failure modes

- **Cwd not a roster workspace** → abort with the message above.
- **Fire prompt missing agent/plan/project** → abort, list the parsed fields.
- **Schedule not registered** → abort with the `roster schedule list` pointer.
- **Subagent dispatch fails** → write `status=failed` to state.md, do not retry. Failure-class HITL items are created by the next session-start (ROS-42 / failure observability).
- **`roster/` directory missing** → first run on a fresh init; treat as zero pending items, exit cleanly.
