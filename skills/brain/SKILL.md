---
name: brain
description: "Front door to the roster brain — the workspace's shared, append-only Postgres memory. Use when the user asks to remember/record/look up team knowledge (competitors, posts, metrics, accounts, people), to search the brain, or to set up/configure it. Routes to `roster brain <verb>` (save/get/event/link/merge/query/table/mount/config/export/import) and follows the brain-first protocol. Triggers on /brain or when a request is about persistent team knowledge in a roster workspace."
version: "1.0.0"
trigger_conditions:
  - "User invokes /brain"
  - "User asks to remember, record, correct, or look up persistent team knowledge (competitors, posts, metrics, accounts, people, strategy)"
  - "User asks to search/query the brain or to set up / configure / back up the brain"
---

# brain

The chat-native front door to the **roster brain** — a shared, append-only Postgres
store the whole agent team reads and writes instead of scattering knowledge across
files. Works identically in Claude Code and Codex. Stateless: every invocation re-checks
the brain's state.

## Is there a brain here?

A brain is configured when the runtime connection `ROSTER_BRAIN_URL` is set in the
environment (that's what the read/write verbs use). If it's unset — or any `roster
brain` verb reports the connection env var is missing — this workspace has **no brain
configured**: tell the user how to set one up (see *Setup* below) and stop; do not
invent a local substitute. (`roster brain doctor` is an admin-side diagnostic and needs
`ROSTER_BRAIN_ADMIN_URL`, so don't rely on it to detect a runtime brain.)

## Brain-first protocol

The brain is the team's source of truth. When a request is about persistent knowledge:

1. **Consult before answering.** For questions about competitors, posts, metrics,
   accounts, people, or strategy, run `roster brain query "<question>"` first — the
   team may already know. Blend brain hits with your own reasoning; cite what came
   from the brain.
2. **Write back what you learn.** When you discover a durable fact, record it
   (`save`/`event`/`link`) so the next session benefits. Read `brain/RESOLVER.md` to
   decide where it goes.
3. **Correct immediately.** If you find the brain is wrong, write the correction now —
   a new write supersedes; nothing is deleted.
4. **Check before creating a table.** Run `roster brain table list` and re-read
   `brain/RESOLVER.md` before `brain table create` — prefer entities + facts.

## Verb cheatsheet

| Goal | Command |
|------|---------|
| Provision / inspect | `roster brain init` · `roster brain doctor` |
| Save an entity + facts | `roster brain save --kind <k> --slug <s> --field key=value` |
| Read an entity (truth + timeline) | `roster brain get --kind <k> --slug <s>` |
| Record something that happened | `roster brain event --kind <event-kind> [--slug <entity-slug>] --data '{…}'` |
| Link two entities | `roster brain link <src> <rel> <dst>` |
| Merge a duplicate | `roster brain merge <from> <into>` |
| Hybrid search (meaning + keyword + graph) | `roster brain query "<text>" [--kind k] [--limit n]` |
| Custom table | `roster brain table list` · `roster brain table create <name> --col name:type` |
| Read-only SQL | `roster brain sql "SELECT …"` |
| Ingest a file | `roster brain mount <file>` |
| Settings | `roster brain config get` · `roster brain config set <key> <value>` |
| Backup / restore | `roster brain export [--out <dir>]` · `roster brain import <dir>` |

Add `--json` to any verb for machine-readable output.

## Setup

The brain is **bring-your-own Neon** (or any Postgres): the connection string lives in
Infisical, never in `.env`. Provision with `roster brain init` (admin URL), which prints
a restricted runtime connection string once. Semantic search embeddings are **off** by
default (no paid API calls) — enable with
`roster brain config set embeddings.enabled true` (needs `OPENAI_API_KEY`). Full
walkthrough: the **Set up the brain** section of the Roster HOWTO.

## Safety

- Append-only: you can never UPDATE or DELETE through the runtime role — corrections
  supersede. Don't try to work around it.
- Never put secrets (API keys, tokens) into the brain; config stores non-secret
  settings only.
