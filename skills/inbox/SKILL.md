---
name: inbox
description: "Conversational review of unread decisions in a roster workspace. Lists pending HITL items (roster/<function>/pending/), shows each in chat, collects approve/reject/defer by reply, and applies each via `roster review --approve/--reject <id>`. No TTY needed — this is the chat-native front door for `roster review`. Triggers on /inbox or when the user asks to review their inbox / pending decisions / HITL items."
version: "1.0.0"
trigger_conditions:
  - "User invokes /inbox"
  - "User asks to review unread decisions / pending HITL items / their inbox in a roster workspace"
---

# inbox

The chat-native way to clear your roster decision queue. `roster review`'s interactive TUI needs a real terminal; `/inbox` does the same job **conversationally** — it lists the decisions, you reply in plain language, and it applies each through the non-interactive `roster review` backend. Works identically in Claude Code and Codex.

The skill is **stateless** — it re-reads the queue on every invocation.

## Working directory

Operate from the workspace root only — the directory containing `config/project.yaml` and a `roster/` directory. If invoked elsewhere, stop and say:

> Run /inbox from your roster workspace root (must contain config/project.yaml and roster/).

Use that root as `<root>` for every command below (pass it explicitly with `--cwd <root>`).

## Procedure

1. **List.** Run:
   ```
   roster review --json --cwd <root>
   ```
   Parse the JSON array. Each entry has `id`, `function`, `filename`, `path` (workspace-relative), and `frontMatter`. If the `roster` CLI is not on PATH, tell the user to install it (`npm i -g @firatcand/roster`) or run `roster review` in a terminal, and stop.

2. **Empty queue.** If the array is empty, reply `Inbox zero — no unread decisions.` and stop.

3. **Present.** For each item, show a compact, numbered block:
   - `N. [<function>] <filename>`  ·  id `<id>`
   - `on approve → <frontMatter.target_on_approve>` (or warn `⚠ no target_on_approve — can't be approved, only rejected/deferred`)
   - the first ~6 lines of the body — read it yourself from `<path>` (you have Read access; `--json` returns front-matter only).

4. **Collect decisions.** Ask the user what to do, accepting free-form replies like "approve 1 and 3, reject 2, leave the rest." Map each to approve / reject / defer. If the user is unsure, summarize what approve (moves the item to its `target_on_approve`) vs reject (deletes it) vs defer (leaves it for later) does.

5. **Apply**, one item at a time, using its `id`:
   - approve → `roster review --approve <id> --cwd <root> --json`
   - reject → `roster review --reject <id> --cwd <root> --json`
   - defer → do nothing (leave the file).

   Parse each result. On `ok: true`, note the outcome. On `ok: false` (e.g. `missing target_on_approve`, target exists, escapes workspace), tell the user the reason and treat the item as still pending (a failed approve changes nothing on disk).

6. **Summarize.** Report `X approved, Y rejected, Z deferred`, and list any that couldn't be applied and why. If anything is still pending, remind the user they can re-run `/inbox` later.

## Rules

- **Never move or delete decision files by hand.** Always go through `roster review --approve/--reject` so the path-safety checks (target must stay inside the workspace, no clobber) are enforced in one place.
- **Never edit a decision's body.** `/inbox` reviews and routes; it does not author.
- **One workspace at a time** — the root you detected in the working-directory step.
- **Identify by `id`, fall back to `path`.** The `id` is `roster review`'s stable handle; if it ever reports an ambiguous id, re-run the apply with the exact workspace-relative `path` instead.
- Do not invoke any model billing path other than the host tool's native subscription, and do not spawn subagents — `/inbox` only shells out to `roster` and converses.

## What this skill does NOT do

- Synthesize new decisions (that's `roster pending sync`, run by the session-start banner hook).
- Change the count logic or introduce read/seen state — "unread" simply means "still in the queue."
- Run the interactive `roster review` TUI (it needs a terminal; this skill is its headless, conversational equivalent).
