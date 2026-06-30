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

## Organizing a corpus — extract → dedup → link → tag

When you take a raw idea, a notes dump, a transcript, or a page and fold it into the brain,
run this pipeline (the `brain-organizer` subagent does exactly this for the on-demand pass):

### 1. Extract

Break the corpus into the **nouns** it mentions and the **attributes / relationships**
asserted about each:

- Each distinct real thing → one entity, mapped to a `kind` from the taxonomy above. Reuse
  the closest existing kind before inventing one.
- Each attribute ("HQ is Berlin", "MRR is 40k") → a fact on that entity, with provenance.
- Each "X relates to Y" statement → an edge (see *When to link*).
- Long source text → `roster brain mount <file>`; don't paste it into a fact.

### 2. Dedup before you create

The brain fragments the moment two entities describe the same thing. So **before every
create**:

- Run `roster brain query "<name>"` (and/or `roster brain get --kind <k> --slug <s>`).
- `save` self-checks too: when it warns `possible duplicate of: …`, evaluate it. If it is
  the same real thing, `roster brain merge <from-slug> <into-slug>` instead of leaving two.
- Prefer a stable, predictable slug so the same thing always lands on the same entity.

Never skip the check to avoid friction — a near-duplicate costs more later than the query now.

### 3. When to link

Create an edge **only when the corpus asserts a relationship between two entities that both
exist** (save both first). Don't link a thing to a free-floating string — model the other
end as an entity, then connect them. Links are **kind-qualified**, because a bare slug can
match more than one kind and the command will refuse an ambiguous slug:

```
roster brain link <src-slug> <rel> <dst-slug> --kind-src <kind> --kind-dst <kind>
```

Use a verb-ish `rel` in snake_case (`competes_with`, `authored`, `works_at`, `tagged`).

### 4. Tags — a `tag` kind + a `tagged` edge (no schema change)

Tags are not a new column — they are modeled in the graph you already have:

- the tag itself is an **entity** of `kind: tag`, slug = the kebab-case tag
- applying it is an **edge** `(<entity>) -[tagged]-> (tag:<name>)`

```
roster brain save --kind tag --slug competitor
roster brain link acme tagged competitor --kind-src company --kind-dst tag
```

Tags are then queryable through the normal graph (`get` / `query`, 1-hop). Corpus-tag
taxonomy — reuse these before coining new tags:

| tag | apply to | meaning |
|-----|----------|---------|
| `competitor` | company | a company you compete with |
| `customer` | company / account | a current paying customer |
| `prospect` | company / account / person | an open opportunity |
| `partner` | company | a partner / integration |
| `watchlist` | any | worth monitoring over time |
| `champion` | person | an internal advocate at an account |
| `source` | post / channel | where a piece of knowledge came from |
| `inbound` / `outbound` | campaign | acquisition motion |

Coin a new tag only when nothing above fits; keep it kebab-case and reusable across entities.

## Conventions

- **slugs** are lowercase kebab-case, stable, and unique within a kind.
- **Never delete.** The brain is append-only; corrections supersede, they don't erase.
- **Provenance always.** Every fact carries `--source "<where it came from>"` — a URL, a
  filename, or `user, <date>`. If you can't cite it, don't write it.
- **Dedup before create.** Consult the brain before every `save`; heed the dup-warning.
- **Tags are edges.** Reach for the `tag` kind + `tagged` edge, never a new table or column.
- **Mount, don't paste.** Long source docs → `roster brain mount <file>` (chunked +
  searchable), not pasted into a fact.
- **Search before you ask.** `roster brain query "<question>"` before answering from
  memory or the open web — the team may already know.
