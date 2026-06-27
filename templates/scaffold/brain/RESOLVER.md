# Brain RESOLVER — where does this go?

The **brain** is this workspace's shared, append-only memory (a Postgres database
reached via `roster brain …`). Read this file before you write to it, so the team's
knowledge stays consistent instead of fragmenting into duplicates and ad-hoc tables.

> No brain configured? If the runtime connection `ROSTER_BRAIN_URL` is not set in the
> environment, this workspace has no brain yet — skip the brain and use normal files.
> Set one up with the **Set up the brain** section of the Roster HOWTO (bring-your-own
> Neon connection, stored in Infisical, never in `.env`).

## The model in one minute

- **entities** — the nouns you track: a company, a person, a post, a campaign. One
  per real thing, identified by `kind` + `slug`.
- **facts** — current attributes of an entity (append-only; latest write wins per key).
- **events** — things that happened over time (metric snapshots, notes, corrections).
- **edges** — typed relationships between two entities ("acme competes_with globex").
- **documents** — chunks of mounted files, searchable by keyword + meaning.

## Kind taxonomy (use these before inventing new ones)

| kind | what it is | example slug |
|------|------------|--------------|
| `company` | an org you sell to, partner with, or watch | `acme` |
| `person` | an individual (prospect, champion, author) | `jane-doe` |
| `post` | a published piece (yours or a competitor's) | `2026-06-q2-launch` |
| `campaign` | an outbound/marketing campaign | `cold-outbound-jun` |
| `channel` | a distribution surface (X, LinkedIn, blog) | `x` |
| `account` | a target account in your pipeline | `acme-enterprise` |
| `metric` | a named measure tracked over time | `mrr` |

Need a kind that isn't here? Use the closest fit first. Only add a new kind when the
thing genuinely doesn't model as any of the above.

## Decision tree

1. **Is this a new attribute of something that already exists?**
   → `roster brain save --kind <k> --slug <s> --field key=value` (upserts the entity,
   appends the fact). Run `roster brain get --kind <k> --slug <s>` first to confirm it
   exists and avoid a near-duplicate (save will warn you if it looks like one).
2. **Is this a relationship between two entities?**
   → `roster brain link <src-slug> <rel> <dst-slug>`.
3. **Is this something that happened (a metric reading, a note, a correction)?**
   → `roster brain event --kind <event-kind> [--slug <entity-slug>] --data '{…}'` (`--slug` optionally ties the event to an entity).
4. **Did you learn the team was wrong about something?**
   → write the correction immediately (a new `save`/`event` supersedes — nothing is
   deleted; history stays).
5. **Do you genuinely need a new shape that entities/facts/events/edges can't hold?**
   → **STOP.** Run `roster brain table list` and re-read this file. Only if nothing fits,
   `roster brain table create <name> --col name:type …` (allowed types: text, int,
   bigint, numeric, boolean, timestamptz, jsonb, uuid). Prefer entities+facts over new
   tables — tables are for genuinely tabular, high-volume data.

## Conventions

- **slugs** are lowercase kebab-case, stable, and unique within a kind.
- **Never delete.** The brain is append-only; corrections supersede, they don't erase.
- **Mount, don't paste.** Long source docs → `roster brain mount <file>` (chunked +
  searchable), not pasted into a fact.
- **Search before you ask.** `roster brain query "<question>"` before answering from
  memory or the open web — the team may already know.
