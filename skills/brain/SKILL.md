---
name: brain
description: "Front door to the roster brain — the workspace's shared, append-only Postgres + object-storage memory. Use when the user asks to remember/record/look up team knowledge (competitors, posts, metrics, accounts, people) or to set up the brain. Routes to `roster brain <verb>` (init/doctor/ingest/save/get/event/link/merge/fs/record) and follows the brain-first protocol. Triggers on /brain or when a request is about persistent team knowledge in a roster workspace."
version: "1.0.0"
trigger_conditions:
  - "User invokes /brain"
  - "User asks to remember, record, correct, or look up persistent team knowledge (competitors, posts, metrics, accounts, people, strategy)"
  - "User asks to look up team knowledge, ingest a source, or set up the brain"
---

# brain

The chat-native front door to the **roster brain** — a shared, append-only Postgres
store the whole agent team reads and writes instead of scattering knowledge across
files. Works identically in Claude Code and Codex. Stateless: every invocation re-checks
the brain's state.

## Is there a brain here?

A brain is configured when `roster.yaml` contains its tracked `brain` block. The
read/write verbs additionally require `ROSTER_BRAIN_URL` from the configured Infisical
path. If the block is absent, explain that no brain is configured. If the block exists
but the environment variable is missing, explain that runtime credentials are not
injected and follow *Setup* below; do not invent a local substitute. (`roster brain
doctor` is an admin-side diagnostic and needs `ROSTER_BRAIN_ADMIN_URL`, so don't rely on
it to detect a runtime brain.)

## Brain-first protocol

The brain is the team's source of truth. When a request is about persistent knowledge:

1. **Consult before answering.** For questions about competitors, posts, metrics,
   accounts, people, or strategy, read the entity first —
   `roster brain get --kind <k> --slug <s>` — before answering from memory or the open
   web. Cited retrieval across the whole brain is `roster context <function>/<agent>
   --query "…"`; `roster brain query` fails closed until #352 ships. Cite what came
   from the brain.
2. **Write back what you learn.** When you discover a durable fact, record it
   (`save`/`event`/`link`) so the next session benefits. Read `brain/RESOLVER.md` to
   decide where it goes.
3. **Correct immediately.** If you find the brain is wrong, write the correction now —
   a new write supersedes; nothing is deleted.
4. **Entities and facts, never new tables.** The custom-table broker is disabled;
   `brain/RESOLVER.md` maps every shape onto entities, facts, events, and edges.

## Organize, don't just dump

Knowledge written carelessly fragments into duplicates and orphaned facts. Whenever you
write, organize around the write — the pipeline is **extract → dedup-before-create → link →
tag**. `brain/RESOLVER.md` is the authoritative guideline (kind taxonomy, corpus-tag
taxonomy, tags-as-edges convention, dedup discipline, when-to-link branch); follow it.

**Inline (a fact or two learned mid-session):**

1. **Extract** the noun and map it to a `kind` from `RESOLVER.md`.
2. **Dedup before create** — `roster brain get --kind <k> --slug <s>` first. When
   `save` warns "possible duplicate of: …", evaluate it and
   `roster brain merge <from> <into>` if it is the same thing. Never leave a near-duplicate.
3. **Save with provenance** — `roster brain save --kind <k> --slug <s> --field key=value
   --source "<where it came from>"`. Every fact carries a `--source`.
4. **Link** asserted relationships, **kind-qualified** (bare slugs are ambiguous):
   `roster brain link <src> <rel> <dst> --kind-src <kind> --kind-dst <kind>`.
5. **Tag** for retrieval — a `tag` is a `tag` entity-kind + a `tagged` edge (no schema
   change): `roster brain save --kind tag --slug <kebab-tag>`, then
   `roster brain link <entity> tagged <kebab-tag> --kind-src <entity-kind> --kind-dst tag`.

**On-demand corpus pass (a notes dump, transcript, or page worth a dedicated pass):**
delegate to the `brain-organizer` subagent via the host tool's native subagent primitive
(see `roster-orchestrator` for the per-tool idiom). It runs the same extract → dedup → link
→ tag pipeline over the whole corpus, append-only, and returns a summary of what it wrote.
Everything stays on the host subscription and the `roster brain` verbs.

## Verb cheatsheet

| Goal | Command |
|------|---------|
| Provision / inspect | `roster brain init` · `roster brain doctor` |
| Mint an immutable source version | `roster brain ingest --manifest-file <ws path> [--bytes-file <ws path>]` |
| Save an entity + facts | `roster brain save --kind <k> --slug <s> --field key=value` |
| Read an entity (truth + timeline) | `roster brain get --kind <k> --slug <s>` |
| Record something that happened | `roster brain event --kind <event-kind> [--slug <entity-slug>] --data '{…}'` |
| Link two entities | `roster brain link <src> <rel> <dst>` |
| Merge a duplicate | `roster brain merge <from> <into>` |
| Cited retrieval | `roster context <function>/<agent> --query "<text>"` |
| Record portable work evidence | `roster brain record run\|artifact\|feedback\|decision --payload '{…}'` |
| Store a file | `roster brain fs put --kind <k> --slug <s> <file>` |
| Fetch a stored file | `roster brain fs get --kind <k> --slug <s> <filename> [--out <path>]` |
| List stored files | `roster brain fs ls [--kind <k> [--slug <s>]]` |
| Remove a stored file (tombstone) | `roster brain fs rm --kind <k> --slug <s> <filename>` |

Add `--json` to any verb for machine-readable output. The legacy `mount`, `table`,
`sql`, `config`, `reindex`, `gc`, `export`, and `import` spellings are recognized but
refuse with `BRAIN_LEGACY_COMMAND_DISABLED`; `query` refuses with
`BRAIN_RETRIEVAL_NOT_READY`. Never route a user to them.

## Setup

The brain is **bring-your-own Neon** (or any Postgres): connection strings live in
Infisical, never in `.env`. First run `roster brain init` with the admin URL injected.
When `ROSTER_BRAIN_URL` is absent, init reports only the expected derived runtime role
and tracked Infisical path, then stops before database access. The host must generate a
43-128 character unpadded base64url password (at least 32 random bytes), build the full
workspace-specific URL with that reported role, and store it at that Infisical path as
`ROSTER_BRAIN_URL`. Rerun init under ambient injection to provision the database.
Roster never mints, prints, returns, or stores the runtime password or URL. The brain
is indivisible: `roster.yaml` must declare both `brain.secrets_path` and
`brain.storage` (bucket + region), or every Brain verb fails closed with
`BRAIN_CONFIGURATION_INCOMPLETE` without contacting either store. Full walkthrough:
the **Set up the brain** section of the Roster HOWTO.

## Safety

- Append-only: you can never UPDATE or DELETE through the runtime role — corrections
  supersede. Don't try to work around it. Files are append-only too: the ledger never
  erases history, so `roster brain fs rm` writes a tombstone row and deletes the object
  rather than rewriting the past. File *bytes* are mutable, but only through the
  `roster brain fs` verbs.
- Never put secrets (API keys, tokens) into the brain. The object-storage namespace is
  tracked non-secret configuration in `roster.yaml` under `brain.storage`; the
  credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) are ambient-only and
  never stored in the brain. Roster never prints a bucket, endpoint, object key, or
  `s3://` URI.
