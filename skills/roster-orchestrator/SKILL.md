---
name: roster-orchestrator
description: "Bootstraps roster workspaces. On chat session start, surfaces pending HITL items as a single banner. On a scheduled fire, verifies the schedule is registered, resolves the agent's merged env, dispatches the named agent via the host tool's native subagent primitive, writes a run log + state.md entry, and exits. Reads roster/<function>/schedules.yaml plus pending items at both roster/<function>/pending/ (error class) and <function>/<agent>/pending/ (lesson class). Subscription-billed primitives only — never invokes claude -p, claude --prompt, claude api, or the Anthropic SDK."
version: "1.0.0"
trigger_conditions:
  - "Session start in a roster workspace (CLAUDE.md / AGENTS.md / CONTEXT.md present at cwd)"
  - "A scheduled fire prompt names a roster agent (e.g., 'Run sdr cold-outreach')"
  - "User invokes /roster-orchestrator"
---

# roster-orchestrator

The bootstrap entry point for every fresh CLI session in a roster workspace. Two modes:

1. **Chat-session bootstrap** — surface a single banner if any HITL surface has items.
2. **Scheduled fire** — verify the fire matches a registered schedule, resolve the agent's merged env, dispatch the named agent, log the run, exit.

The skill is **stateless**. It re-reads disk on every invocation so `/clear` and fresh fires both work identically.

## Working directory

Operate from the workspace root only — the directory containing `config/project.yaml` (the v1 workspace identity file) plus a `roster/` directory (scheduler namespace). If invoked elsewhere, abort with:

> Run roster-orchestrator from your roster workspace root (must contain config/project.yaml and roster/).

## Mode detection

Inspect the initial prompt:

- If it matches a scheduled-fire shape (`Run <agent> <plan>`, `Use the <agent> skill to <plan>`, etc.) → **scheduled-fire mode**.
- Otherwise → **chat-session-bootstrap mode**.

When ambiguous, default to chat-session-bootstrap (it is the safe no-op when no fire is happening).

## Mode 1 — Chat-session bootstrap

1. Walk both HITL surfaces:
   - **Error class** — `roster/<function>/pending/*.md` across all functions (synthesized by `roster pending sync` from non-zero cron exit codes / STALE detection).
   - **Lesson class** — `<function>/<agent>/pending/*.md` across all agents (drafted by the dreamer skill).
2. Count files matching `*.md` in each surface. Sum the counts (no dedupe — error and lesson namespaces are disjoint).
3. If sum == 0 → print nothing, exit silently.
4. If sum > 0 → print one banner line and stop:
   ```
   ⚠ N pending HITL items — run `roster review`
   ```
   (Single-line surface. The full review UI lives behind the `roster review` CLI.)

No other side effects. Do not read item bodies. Do not modify any file.

## Mode 2 — Scheduled fire

1. Parse the fire prompt for `<agent>` and `<plan>`.
   - Preferred shape: `<function>/<agent>` (e.g., `gtm/sdr`). Use this whenever the prompt provides it.
   - Bare-agent shape (e.g., `sdr`): resolve by scanning `<function>/<agent>/` for exactly one matching directory. If zero or more than one match, abort with the parsed fields and the candidate functions.
   - Refuse if `<agent>` or `<plan>` is missing — list which one.
2. Load `roster/<function>/schedules.yaml` using the resolved function from step 1.
3. Verify a matching entry exists (2-tuple lookup):
   ```
   match = none
   for entry in schedules_yaml.schedules:
     if entry.agent == "<function>/<agent>" and entry.plan == "<plan>":
       match = entry
       break
   if match is none:
     abort "Schedule not registered: <function>/<agent>/<plan>. Use `roster schedule list` to see registered schedules."
   ```
4. Resolve the agent's merged env via `resolveAgentEnv` (see "Env resolution" below). The dispatch primitive must see this merged env.
5. Dispatch the named agent via the host tool's subagent primitive (see "Subagent dispatch" below). Block until the subagent returns. The subagent runs in isolated context; nothing leaks back here.
6. Append a single line to `roster/<function>/state.md`. Exact format (one line, three fields, pipe-separated with surrounding single spaces):
   ```
   <utc-iso-8601> | <function>/<agent>/<plan> | <status>
   ```
   - `<utc-iso-8601>`: UTC, second precision, `Z` suffix. Example: `2026-05-16T14:09:00Z`.
   - `<status>`: exactly one of `success` or `failed`. No other values.
7. The subagent itself is responsible for the full run log at `<function>/<agent>/logs/runs/<YYYY-MM>/<ts>.md` (path flattened in v1). Do not write that file from here.
8. Exit cleanly. Do not start a new turn.

## Env resolution

The dispatched subagent needs workspace-wide secrets plus any agent-specific overrides. v1 ships a pure loader for this:

```ts
import { resolveAgentEnv } from '<roster-internal>';   // src/lib/env-merge.ts
const env = resolveAgentEnv(workspaceRoot, "<function>/<agent>");
```

Precedence (each key resolved independently):

1. `<function>/<agent>/.env` — if the key is defined, use that value. Empty string = explicit unset (does NOT fall through).
2. `/.env` (workspace) — if the key is defined, use that value.
3. Otherwise the key is unset.

The orchestrator must ensure the merged env is materialized in the dispatch primitive's environment before the subagent runs — apply via the host's env-application mechanism (Claude `Task` env hand-off, Codex agent env, Gemini equivalent). Subscription-safety: only `.env` values are loaded; never inherit API-key shell exports from the user's interactive session. For scheduled fires this is reinforced upstream by the cron wrap (`env -i`).

## Subagent dispatch

The skill body is tool-agnostic. Use the dispatch idiom that matches the host CLI:

### On Claude Code

Use the `Task` tool with `run_in_background: false`:

```
Task(
  subagent_type="<agent>",
  prompt="Run plan <plan>",
  run_in_background=false,
)
```

The subagent runs in isolated context. The return value is a short status string (~30 tokens). No other tools should be invoked in this turn.

### On Codex CLI

Invoke the subagent via natural language. Codex resolves the agent name against `~/.codex/agents/<agent>.toml`:

> Use the `<agent>` subagent to run plan `<plan>`.

Wait for the subagent to return its status, then proceed to the state.md write.

## Subscription-billing guarantee

This skill — and every subagent it dispatches — must run on the user's interactive Claude Pro/Max or ChatGPT Plus/Pro subscription. **Banned primitives** (any occurrence is a release blocker, enforced by `roster doctor` and CI audit):

- `claude -p` <!-- roster-audit-ok: claude-p-flag -->
- `claude --prompt` <!-- roster-audit-ok: claude-prompt-flag -->
- `claude api` <!-- roster-audit-ok: claude-api-cmd -->
- `@anthropic-ai/sdk` <!-- roster-audit-ok: anthropic-sdk-import -->
- `from anthropic` <!-- roster-audit-ok: python-anthropic-import -->
- Any wrapper that re-routes calls through the Agent SDK billing pool

**Scope of the guarantee.** The static audit blocks the above literals in roster's *shipped source* (skills/, src/) at build/install time. It is a source guard, not a runtime sandbox — nothing prevents a host LLM from inventing a banned invocation while following these instructions. Runtime compliance depends on the LLM honoring this section.

If you encounter a workflow that seems to require one of the above, stop and surface it as a HITL item. Do not attempt to bypass.

## What this skill does NOT do

- Execute business logic (SDR outreach, content drafts, design generation). That's the dispatched subagent's job.
- Read or modify HITL item bodies. That's `roster review`.
- Write the full run log. That's the dispatched subagent.
- Touch git. Roster never auto-commits.
- Invoke any model billing path other than the host tool's native subscription.

## Failure modes

- **Cwd not a roster workspace** → abort with the message above.
- **Fire prompt missing agent or plan** → abort, list the parsed fields.
- **Schedule not registered** → abort with the `roster schedule list` pointer.
- **Subagent dispatch fails** → write `status=failed` to state.md, do not retry. Failure-class HITL items are created by the next session-start (ROS-42 / failure observability).
- **`roster/` directory missing** → first run on a fresh init; treat as zero pending items, exit cleanly.
