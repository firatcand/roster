---
name: roster-orchestrator
description: "Bootstraps roster workspaces. On chat session start, surfaces unread decisions (HITL) as a single banner pointing at /inbox. On a scheduled fire, verifies the schedule is registered, resolves the agent's merged env, dispatches the named agent via the host tool's native subagent primitive, writes a run log + state.md entry, and exits. Reads roster/<function>/schedules.yaml plus pending items at both roster/<function>/pending/ (error class) and <function>/<agent>/pending/ (lesson class). Subscription-billed primitives only — never invokes the Claude CLI in headless print or API modes, nor the Anthropic SDK."
version: "1.3.0"
trigger_conditions:
  - "Session start in a roster workspace (identified by config/project.yaml at cwd; CLAUDE.md / AGENTS.md / CONTEXT.md typically also present)"
  - "A scheduled fire prompt names a roster agent (e.g., 'Run sdr cold-outreach')"
  - "User invokes /roster-orchestrator"
---

# roster-orchestrator

The bootstrap entry point for every fresh CLI session in a roster workspace. Two modes:

1. **Chat-session bootstrap** — surface a single banner if there are any unread decisions (HITL items).
2. **Scheduled fire** — verify the fire matches a registered schedule, resolve the agent's merged env, dispatch the named agent, log the run, exit.

The skill is **stateless**. It re-reads disk on every invocation so `/clear` and fresh fires both work identically.

## Working directory

Operate from the workspace root only — the directory identified by `config/project.yaml` (the v1 workspace identity file). **That file alone marks a roster workspace.** The `roster/` directory (the scheduler/queue namespace) is created lazily by `roster schedule install` / `roster pending sync`, so it is **absent on a fresh init and that is normal** — do not require it for chat-session bootstrap. If `config/project.yaml` is missing, abort with:

> Run roster-orchestrator from your roster workspace root (must contain config/project.yaml).

A missing `roster/` simply means zero error-class pending items (see Mode 1). The stricter requirement on `roster/<function>/schedules.yaml` applies only to scheduled-fire mode (Mode 2).

> **`.roster/` is not `roster/`.** `.roster/` (dotted) holds scaffold/schedule-spec metadata written by `roster init` / `roster schedule install`; `roster/` (undotted) is the runtime queue + state tree. They are different directories — never treat the presence of `.roster/` as the runtime `roster/`, or vice-versa.

## Mode detection

Inspect the initial prompt:

- If it matches a scheduled-fire shape (`Run <agent> <plan>`, `Use the <agent> skill to <plan>`, etc.) → **scheduled-fire mode**.
- Otherwise → **chat-session-bootstrap mode**.

When ambiguous, default to chat-session-bootstrap (it is the safe no-op when no fire is happening).

## Mode 1 — Chat-session bootstrap

1. Walk both decision surfaces:
   - **Error class** — `roster/<function>/pending/*.md` across all functions (synthesized by `roster pending sync` from non-zero cron exit codes / STALE detection). If `roster/` does not exist yet (fresh init), this surface is simply empty — count it as zero and continue; never abort.
   - **Lesson class** — `<function>/<agent>/pending/*.md` across all agents (drafted by the dreamer skill).
2. Count files matching `*.md` in each surface. Sum the counts (no dedupe — error and lesson namespaces are disjoint).
3. If sum == 0 → print nothing, exit silently.
4. If sum > 0 → print one banner line and stop (pluralize `decision`):
   ```
   ⚠ You have N unread decision(s) awaiting — run /inbox
   ```
   (Single-line surface. `/inbox` reviews them conversationally; `roster review` is the CLI backend.)

No other side effects. Do not read item bodies. Do not modify any file.

## Mode 2 — Scheduled fire

1. Parse the fire prompt for `<function>`, `<agent>`, `<plan>`, and — when present — the schedule name.
   - Installed prompts carry a function-qualified agent AND a `(schedule <name>)` suffix (e.g., `Use the roster-orchestrator skill to run plan cold-outreach for agent gtm/sdr (schedule sdr-cold-outreach)`). Parse `<schedule>` from the suffix whenever present.
   - Preferred agent shape: `<function>/<agent>` (e.g., `gtm/sdr`) — every current install renders it. Split it ONCE into `<function>` and the **bare** `<agent>` (e.g., `gtm` + `sdr`) and use those consistently below: the function names which registry file to load; the bare agent is what the registry stores.
   - Bare-agent shape (e.g., `sdr` — a legacy installed prompt): resolve the function by scanning `<function>/<agent>/` for exactly one matching directory. If zero or more than one match (the same bare agent exists under two functions), abort with the parsed fields and the candidate functions — that is true ambiguity; a current install avoids it by qualifying the agent in the prompt.
   - Refuse if `<agent>` or `<plan>` is missing — list which one. A missing `(schedule …)` suffix is NOT an error — it means a legacy install (see step 3's fallback).
2. Load `roster/<function>/schedules.yaml` using the resolved function from step 1. **Scheduled-fire is strict about this file** — if `roster/` or `roster/<function>/schedules.yaml` is missing or unreadable, abort immediately (the Mode 1 tolerance of a missing `roster/` does NOT apply here):

   > Schedule registry not found: roster/<function>/schedules.yaml. Install the schedule first with `roster schedule install`, or run `roster schedule list` to see what is registered.
3. Verify a matching entry exists — **by schedule name first**; two schedules in one function may legitimately share the same (agent, plan), so the name is the only unambiguous key. **The registry stores the BARE agent** (`agent: sdr`, kebab — the file is already function-scoped by its path, so entries never embed the function): always compare the registry's bare agent against the prompt's bare `<agent>` (function prefix stripped in step 1) — never against `<function>/<agent>`:
   ```
   if <schedule> parsed from the prompt:
     match = the entry with entry.name == "<schedule>"
     if match is none:
       abort "Schedule not registered: <schedule>. Use `roster schedule list` to see registered schedules."
     if match.agent != "<agent>" or match.plan != "<plan>":     # bare-to-bare
       abort "Schedule '<schedule>' is registered for agent <match.agent> plan <match.plan> in function <function>, but the fire prompt says <agent>/<plan> — the prompt and the registry disagree; re-run `roster schedule install`."
   else:                                # legacy install — prompt carries no name
     # (agent, plan) fallback, scoped to the named function's registry only —
     # the file loaded in step 2 IS that scope; entries hold bare agents.
     matches = every entry with entry.agent == "<agent>" and entry.plan == "<plan>"
     if matches is empty:
       abort "Schedule not registered: <function>/<agent>/<plan>. Use `roster schedule list` to see registered schedules."
     if len(matches) > 1:
       abort "Ambiguous fire: N schedules match <function>/<agent>/<plan> (<names>). This legacy fire prompt carries no schedule name — re-run `roster schedule install` for each so the prompt names its schedule; refusing to guess."
     match = matches[0]
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
8. If — and ONLY if — this workspace has an ops backend configured, also record the fire into the run + artifact ledger (see "Run-ledger correlation" below). This is opt-in and wraps the dispatch in step 5; skip it silently otherwise. The `state.md` line above and the run log are unchanged either way (they are the human artifacts).
9. Exit cleanly. Do not start a new turn.

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

When an ops backend is configured (see "Run-ledger correlation"), the parent has
already emitted `roster run start --run <run-id> …` BEFORE dispatch — with the
`--schedule <schedule-name> --function <function>` clause ONLY when
`ROSTER_FIRE_ID` is present in the environment (a cron-wrapper-hosted fire; the
flag also stamps the fire sidecar) — and passes `<run-id>` into the subagent
prompt so the subagent records its own outputs against it. When no backend is
configured, drop the `<run-id>` clause — the dispatch idiom is otherwise
identical.

### On Claude Code

Use the `Task` tool with `run_in_background: false`:

```
Task(
  subagent_type="<agent>",
  prompt="Run plan <plan>. Record your work to the run ledger under run id <run-id>: pipe your final report to `roster run report --run <run-id> --stdin`, and for each produced/used artifact call `roster run declare-artifact --run <run-id> --agent <function>.<agent> …`.",
  run_in_background=false,
)
```

The subagent runs in isolated context. The return value is a short status string (~30 tokens). No other tools should be invoked in this turn. After it returns, close the run: `roster run end --run <run-id>` (success) — see "Run-ledger correlation".

### On Codex CLI

Invoke the subagent via natural language. Codex resolves the agent name against `~/.codex/agents/<agent>.toml`:

> Use the `<agent>` subagent to run plan `<plan>`. Record your work to the run ledger under run id `<run-id>`: pipe your final report to `roster run report --run <run-id> --stdin`, and call `roster run declare-artifact --run <run-id> --agent <function>.<agent> …` for each artifact.

Wait for the subagent to return its status, then close the run (`roster run end --run <run-id>`) and proceed to the state.md write.

### On Gemini CLI

Dispatch by prefixing the prompt with `@<agent>` — Gemini resolves it against `~/.gemini/agents/<agent>.md` and forces that subagent (an in-session prompt prefix, not a shell command, so it stays on the user's subscription):

> @<agent> run plan <plan>. Record your work to the run ledger under run id `<run-id>`: pipe your final report to `roster run report --run <run-id> --stdin`, and call `roster run declare-artifact --run <run-id> --agent <function>.<agent> …` for each artifact.

Wait for the subagent to return its status, then close the run (`roster run end --run <run-id>`) and proceed to the state.md write.

### Delegated helper subagents (non-scheduled)

Some subagents are dispatched on demand by a skill rather than by a scheduled fire — e.g. the `brain` skill delegates the **`brain-organizer`** subagent for its on-demand corpus pass. Same primitives, same subscription guarantee:

| Subagent | Claude Code | Codex CLI | Gemini CLI |
|----------|-------------|-----------|------------|
| `brain-organizer` | `Task(subagent_type="brain-organizer", prompt="Organize this corpus into the brain", run_in_background=false)` | "Use the `brain-organizer` subagent to organize this corpus into the brain." | `@brain-organizer organize this corpus into the brain` |

## Run-ledger correlation

**Opt-in — no-op unless an ops backend is configured.** When (and only when) the
workspace has an ops backend, wrap the scheduled dispatch with `roster run`
lifecycle events so the run is queryable and reconstructable from any machine
sharing the backend. Detect this first and skip silently on `not-configured`:

```
state = `roster run list --json` exits 0? (or resolveOpsBackend state ≠ not-configured)
if not configured → do nothing; legacy workspaces are unaffected
```

The correlation is **parent-authoritative** — the parent (this skill) owns the
run id and the lifecycle boundary; the subagent owns its own outputs. The parent
never reads the subagent's markdown (it only ever holds the short status string):

1. **Before dispatch (step 5),** the parent generates a run id and emits the
   run-start event. **Check the environment first: pass `--schedule` ONLY when
   `ROSTER_FIRE_ID` is set.** `roster run start --schedule` REQUIRES a fire id,
   and only the codex cron wrapper mints one — a UI-hosted fire (Claude Desktop
   Scheduled Task, Codex app Automation) has no `ROSTER_FIRE_ID`, and passing
   `--schedule` there fails the run-start and leaves NO ledger record at all.
   - `ROSTER_FIRE_ID` present (cron-wrapper fire):
     ```
     roster run start --run <run-id> --agent <function>.<agent> --trigger schedule --origin-task <plan> --schedule <schedule-name> --function <function>
     ```
     That single call both records the run-start AND stamps a PER-FIRE, function-
     scoped run-id sidecar (`logs/cron/<function>/<schedule-name>/<fireId>.run-id`,
     JSON `{runId, firedAt, fireId}`), so a LATER session can correlate a crashed
     fire back to THIS exact run — even when fires overlap and even when two
     functions own a same-named schedule.
   - `ROSTER_FIRE_ID` absent (UI-hosted fire, manual invocation):
     ```
     roster run start --run <run-id> --agent <function>.<agent> --trigger schedule --origin-task <plan>
     ```
     The run is fully recorded in the ledger, but there is no sidecar and no
     fire correlation — **crash correlation is cron-wrapper-only**; a UI-hosted
     fire that dies before `run end` surfaces via stale detection instead.
   The fire id comes from `ROSTER_FIRE_ID`, which the cron wrapper minted and
   exported to this process (pass `--fire-id` only for manual/test invocation). The
   wrapper writes the matching `<fireId>.exit` in the SAME dir, so the two pair by
   an EXACT token — never a timestamp guess. Do NOT hand-write the sidecar
   (`printf … > …run-id`): the per-fire pairing is what makes overlapping fires
   correlate correctly. Use a `.` (or `:`) between function and agent — e.g.
   `gtm.sdr` — NOT `/`: the agent handle is projected into the safe `run_index`
   view (charset `[A-Za-z0-9._:-]`), so a slash is rejected.
2. **Pass the run id into the dispatched subagent** (shown in the dispatch idioms
   above). The subagent — which owns its run log — records its own outputs against
   that id:
   ```
   roster run report --run <run-id> --stdin        # its final report (source=agent, unverified)
   roster run declare-artifact --run <run-id> …     # each produced/used artifact
   ```
3. **In a guaranteed finally / failure path,** the parent closes the run:
   - success → `roster run end --run <run-id>`
   - failure → emit a correlated error event, then close. The subagent status is
     UNTRUSTED free text (it may contain quotes, braces, or newlines), so serialize
     it as JSON and pipe it via STDIN inside a **quoted heredoc** — the shell then
     never re-parses the JSON, and a quote in the status can neither corrupt the
     JSON nor become shell syntax:
     ```
     roster run event --run <run-id> --kind error --correlation-id <run-id> --stdin <<'JSON'
     {"detail": "<short status — JSON-escaped>"}
     JSON
     roster run end --run <run-id>
     ```
     NEVER string-interpolate the status into a single-quoted `--data '{"detail":"…"}'`
     argument — a `'` or `"` in the status breaks the shell quoting.
   The parent stamps only from the short subagent status it already has — it never
   parses the subagent markdown for success (agent prose is always unverified).
4. **Delayed-failure correlation.** A scheduled process that is killed before its
   `finally` leaves the run `running` forever. Because step 1 wrote the per-fire
   `<fireId>.run-id` sidecar and the wrapper wrote the matching `<fireId>.exit`,
   the next session's `roster pending sync` pairs them by EXACT fire id and emits
   the closure the crashed process never wrote — a correlated
   `roster run event --kind error` (describing the non-zero `.exit` / STALE signal)
   followed by `roster run end` — against that exact run id, with no markdown
   discovery. Overlapping fires each carry their own fire id, so one fire's crash
   never closes another's still-running run. Idempotent: the error uses the fire id
   as its deterministic correlation id and `run-end` a fixed dedupe key, so
   repeated syncs dedup at the store.

`roster run` is a subscription-safe local CLI (it only writes to the configured
Postgres/S3 ops backend — no model calls), so it is exempt from the banned-list
below.

## Subscription-billing guarantee

This skill — and every subagent it dispatches — must run on the user's interactive Claude Pro/Max or ChatGPT Plus/Pro subscription. **Banned primitives** (any occurrence is a release blocker, enforced by `roster doctor` and CI audit):

- `claude -p` <!-- roster-audit-ok: claude-p-flag -->
- `claude --prompt` <!-- roster-audit-ok: claude-prompt-flag -->
- `claude api` <!-- roster-audit-ok: claude-api-cmd -->
- `@anthropic-ai/sdk` <!-- roster-audit-ok: anthropic-sdk-import -->
- `from anthropic` <!-- roster-audit-ok: python-anthropic-import -->
- Any wrapper that re-routes calls through the Agent SDK billing pool

**Scope of the guarantee.** The static audit blocks the above literals in roster's *shipped source* (skills/, src/) at build/install time. It is a source guard, not a runtime sandbox — nothing prevents a host LLM from inventing a banned invocation while following these instructions. Runtime compliance depends on the LLM honoring this section.

**One sanctioned exception (ADR-0002, ROS-155).** The `second-opinion` claude adapter (`src/lib/second-opinion/adapters.ts`) may spawn claude print mode — human-invoked only, never from a schedule or this orchestrator — because a fail-closed preflight refuses to spawn unless the child is provably on the user's subscription (no API keys, no apiKeyHelper, no Bedrock/Vertex, OAuth credential present). That single marked line does not weaken this list: any other occurrence anywhere in shipped source is still a release blocker.

If you encounter a workflow that seems to require one of the above, stop and surface it as a HITL item. Do not attempt to bypass.

## What this skill does NOT do

- Execute business logic (SDR outreach, content drafts, design generation). That's the dispatched subagent's job.
- Read or modify HITL item bodies. That's `roster review`.
- Write the full run log. That's the dispatched subagent.
- Touch git. Roster never auto-commits.
- Invoke any model billing path other than the host tool's native subscription.

## Failure modes

- **No `config/project.yaml` at cwd** → not a roster workspace; abort with the Working-directory message.
- **Fire prompt missing agent or plan** → abort, list the parsed fields.
- **`roster/<function>/schedules.yaml` missing or unreadable (scheduled fire)** → abort with the registry-not-found message; the missing-`roster/` tolerance does NOT apply to Mode 2.
- **Schedule registered file present but no matching entry** → abort with the `roster schedule list` pointer.
- **Subagent dispatch fails** → write `status=failed` to state.md, do not retry. Failure-class HITL items are created by the next session-start (ROS-42 / failure observability).
- **`roster/` directory missing (chat-session bootstrap)** → first run on a fresh init; treat error-class pending as zero, continue to lesson-class checks, exit cleanly. Never abort for this in Mode 1.
