---
name: tasks
description: "Conversational task driver for a roster workspace. Translates natural prompts — what's ready? / work on N / I'm blocked / send for review / mark done / status update — into `roster task` verbs against the user's own tracker board (Notion v1). Never writes the tracker directly; every mutation goes through the CLI's state machine. Triggers on /tasks or when the user asks to list, claim, advance, block, or get a status report on their tracker tasks in a roster workspace."
version: "1.0.0"
trigger_conditions:
  - "User invokes /tasks"
  - "User asks what's ready / to work on a task / to block, submit, finish, or cancel a task on their board in a roster workspace"
  - "User asks for a task status update / digest in a roster workspace"
---

# tasks

The chat-native front door for `roster task`. The CLI owns the state machine
(claim → start → submit → done, with block/unblock, revise, cancel); this skill only
translates plain language into those verbs and relays the outcomes. Works identically
in Claude Code and Codex.

The skill is **stateless** — it re-reads the board on every request. Notion is the
sole source of truth; there is no local task cache.

## Working directory

Operate from the workspace root only — the directory identified by `config/project.yaml`
(the v1 workspace identity file). Tasks additionally need `roster/tracker.yaml` (the
board mapping). If `config/project.yaml` is missing, stop and say:

> Run /tasks from your roster workspace root (must contain config/project.yaml).

If `roster/tracker.yaml` is missing, the board isn't connected yet — point the user to
`roster task setup --data-source <id>` and docs/HOWTO.md §13, then stop.

Use that root as `<root>` for every command below (pass it explicitly with `--cwd <root>`).
Commands need `NOTION_TOKEN` in the environment; if it's absent the CLI's error says so —
relay its remedy rather than inventing one.

## Routing

Always call with `--json` and parse the result. Map the user's intent to exactly one
verb chain:

| User says | Run |
|---|---|
| "what's ready?" / "what can I pick up?" | `roster task list --json --cwd <root>` |
| "give me a status update" / "where is everything?" | `roster task status --json --cwd <root>` |
| "where is task N?" | `roster task status <sel> --json --cwd <root>` |
| "work on <thing>" | `roster task claim <sel> --json --cwd <root>` then `roster task start <sel> --json --cwd <root>` |
| "I'm blocked on X" | `roster task block <sel> --reason "<X>" --json --cwd <root>` |
| "unblock it" / "I'm moving again" | `roster task unblock <sel> --json --cwd <root>` |
| "send it for review" | `roster task submit <sel> --json --cwd <root>` |
| "mark it done" / "ship it" | `roster task done <sel> --json --cwd <root>` |
| "it needs changes" (as reviewer) | `roster task revise <sel> --json --cwd <root>` |
| "cancel it" / "drop it" | `roster task cancel <sel> --json --cwd <root>` |

Notes on specific verbs:

- **"work on …" chains claim → start** (a claimed task isn't active yet; `submit` is only
  legal from active). Relay BOTH outcomes. If `claim` succeeds but `start` fails, say so
  plainly — the task is claimed but not started; do not retry silently.
- **block requires a reason.** If the user didn't give one, ask before running the verb.
  The reason is posted to the board as a comment before any status change, so it is never
  lost.
- Verbs are idempotent — "already claimed by you" style notes come back in `note`. Relay
  them as-is. On boards missing optional stages the CLI may return a guided no-op note
  (e.g. no review stage → "run roster task done when finished"); relay that too.

## Selection protocol

Tracker handles (`TASK-123`) are the only stable references; ordinals are conversation
sugar.

1. When listing tasks, present numbered rows but ALWAYS show the handle next to each.
2. When the user picks by number ("work on 2"), resolve the ordinal against the list you
   just showed **in this conversation**, echo the resolution back — "2 = TASK-17 ‘Wire
   the widget’" — and invoke the verb with the HANDLE, never the ordinal.
3. If you haven't shown a list this conversation (or the board may have changed since),
   re-run `roster task list --json` and re-present before acting on an ordinal.
4. Free-text picks ("work on the landing page") pass through as the selector — the CLI
   fuzzy-matches titles itself. If it reports ambiguity, it lists candidates: show them
   and ask the user to pick, then re-invoke with the exact handle.

## Status digest

`roster task status --json` returns the precomputed digest — `pool` (unassigned Ready),
`groups` (`claimed` / `active` / `blocked` / `review`), and `attention` (each row with a
`why`). Render those sections in order, handles first, and lead with `attention` when it
is non-empty. Do NOT regroup or reinterpret rows — the CLI already applied the state
machine's collapse rules (e.g. a row in `groups.claimed` whose `canonical` says `ready`
is an assigned-but-unclaimed task; its `why` explains that).

Caveat worth relaying when relevant: on boards with no Blocked status mapped, blocking
only posts a comment — the task stays Active and will not appear under `blocked` or
`attention`.

## Rules

- **Never write the tracker directly.** No Notion API calls, no Notion MCP writes, no
  hand-editing board pages. Every mutation goes through a `roster task` verb so identity
  scoping, the transition table, and collapse semantics stay in one tested code path.
- **Never guess a handle.** Resolve via the list or the CLI's fuzzy matcher; on
  ambiguity, ask.
- **One workspace at a time** — the root you detected above.
- **Relay outcomes honestly**, including no-ops, notes, and errors. A failed verb changed
  nothing on the board unless its output says otherwise.
- Do not invoke any model billing path other than the host tool's native subscription,
  and do not spawn subagents — `/tasks` only shells out to `roster` and converses.

## What this skill does NOT do

- Autonomous task pickup or scheduled runs (epic decision: interactive only — every
  claim is human-initiated).
- Board setup or remapping (that's `roster task setup`, run in a terminal).
- Cross-workspace or cross-board aggregation.
