# roster brain — workspace knowledge brain (design)

Date: 2026-06-23
Status: proposed (awaiting review)
Topic: a Neon-Postgres "brain" the agent team reads/writes instead of (or alongside) markdown files.

## 1. Problem

A `roster init` workspace stores everything as filesystem markdown — each agent
(`chief-of-staff`, `dreamer`, `gtm`, `product`, `ops`) has `logs/`, `plans/`,
`playbook/`, `pending/`. There is no shared, queryable, durable memory. Knowledge
about competitors, posts, campaigns, and metrics lives in scattered files that
don't join, don't version cleanly, and rot the moment a human stops maintaining
them.

We want an **append-only, agent-maintained knowledge brain** backed by Neon
Postgres: agents save competitors and post metrics, link posts to outcomes
("what's working"), ingest files, and query by meaning — without ever being able
to delete or overwrite history.

Prior art reviewed: [gbrain](https://github.com/garrytan/gbrain) (Garry Tan's
agent brain). We copy its **patterns and operational discipline**, not its
machinery. gbrain is a Bun runtime with 43 skills, an embedding+reranker stack,
and an overnight "dream" daemon. Roster's ethos is a tiny near-zero-dep CLI, so
we lift the data model and the brain-first discipline and leave the daemon and
heavy stack behind.

## 2. Decisions (locked with user)

| Decision | Choice |
|---|---|
| Where the brain lives | Workspace-scoped (per `roster init` project, its own Neon DB) |
| Neon connection | Bring-your-own connection string (via Infisical, never `.env`) |
| Access interface | `roster brain` CLI verbs (works across Claude/Codex/Gemini) |
| Schema-less meaning | Opinionated starter tables + agents may create more tables |
| Mutation policy | **Insert-only, versioned** — no UPDATE, no DELETE, no DROP |
| Enforcement | DB-role privileges (restricted runtime role) |
| DDL | **Brokered** via `SECURITY DEFINER` function — agents never own tables |
| Init behavior | Opt-in: `roster init` unchanged; `roster brain init` sets up the DB |
| File mount | Ingest file content into the brain as append-only rows |
| Semantic search | **In v1** — pgvector hybrid search, behind a cost-confirmation gate |
| Embeddings default | OpenAI `text-embedding-3-small` (1536-dim); Voyage/ZeroEntropy configurable |

## 3. Best practices adopted from gbrain

1. **Two-layer model — Compiled Truth + Timeline.** An always-current synthesis
   generated from an append-only evidence log. Maps directly onto insert-only
   versioning: raw inserts are the timeline; "latest wins" reads are a generated
   view.
2. **Four DB primitives** — entity registry, event ledger, fact store (with
   provenance), relationship graph. These cover competitors/posts/metrics/links
   natively and are the opinionated starter tables.
3. **Provenance on every fact** (`source`, `confidence`, `observed_at`).
   Contradictions become data (two facts, same field, different values), not
   silent overwrites — free under append-only.
4. **Typed knowledge graph, zero-LLM edge extraction.** `post —promotes→ campaign`,
   `post —about→ competitor`. This is "link metrics to what's working." gbrain's
   benchmark shows the graph is load-bearing (+31 P@5 pts), not optional.
5. **Brain-first protocol as a HARD RULE** in agent config: query the brain
   before answering about competitors/posts/strategy; write corrections
   immediately. Must be wiring, not a suggestion.
6. **Resolver + dedup ("create_safety").** Check existence before creating an
   entity or a new table — prevents schema/entity sprawl now that agents can
   create tables.
7. **`doctor` health check** and **cost-confirmation discipline** — never enable
   anything that costs money (embeddings) without confirming.

**Deliberately skipped:** Bun, PGLite, the reranker, the dream daemon,
embeddings-on-by-default. Driver is `pg` + hand-written SQL.

## 4. Architecture

### 4.1 Connection & secrets

Two Neon roles, both stored in Infisical under `/roster`, never written to a file:

- **Admin URL** (`ROSTER_BRAIN_ADMIN_URL`) — DB owner. Used **only** by
  `roster brain init` and migrations. Run rarely, by a human.
- **Runtime URL** (`ROSTER_BRAIN_URL`) — restricted role used by agents for all
  day-to-day reads/writes.

All brain commands run under `infisical run --path /roster -- ...` so the URLs
resolve from the vault. `roster brain` reads them from the environment; it never
prints or persists a resolved secret.

### 4.2 Append-only enforcement (DB-level, raw-SQL-proof)

The runtime role (`roster_brain_rw`) is granted **only** `SELECT`, `INSERT`,
and schema `USAGE` — explicitly **no** `UPDATE`, `DELETE`, `TRUNCATE`, or `DROP`.
Even with the runtime connection string, an agent cannot mutate or remove data.

Table creation is **brokered**, not raw. If the runtime role ran
`CREATE TABLE`, it would *own* the table and could then drop it. Instead:

- `roster brain table create <name> --columns ...` calls
  `brain.create_table(...)`, a `SECURITY DEFINER` function owned by admin.
- The function creates the table **owned by admin**, then `GRANT SELECT, INSERT`
  to `roster_brain_rw`.
- `ALTER DEFAULT PRIVILEGES` ensures any future table also defaults to
  SELECT/INSERT-only for the runtime role.

Result: append-only holds for starter tables **and** agent-created tables, even
against a leaked runtime credential.

### 4.3 Starter schema (`brain` namespace)

```
brain.entities          -- canonical registry
  id            uuid pk
  kind          text     -- competitor | post | campaign | company | person | idea | ...
  slug          text     -- unique per kind
  name          text
  aliases       text[]
  external_ids  jsonb    -- {x_id, linkedin_id, url, ...}
  created_at    timestamptz default now()

brain.facts             -- structured claims, versioned
  id            uuid pk
  entity_id     uuid -> entities
  field         text
  value         jsonb
  source        text
  confidence    text     -- high | medium | low
  observed_at   timestamptz
  created_at    timestamptz default now()
  -- read view: brain.current_facts = DISTINCT ON (entity_id, field)
  --            ORDER BY confidence_rank, observed_at DESC

brain.events            -- append-only ledger / timeline
  id            uuid pk
  entity_id     uuid -> entities null
  type          text     -- metric_snapshot | ingest | correction | note | ...
  payload       jsonb    -- post metrics land here: {likes, reposts, impressions, ...}
  source        text
  occurred_at   timestamptz
  created_at    timestamptz default now()

brain.edges             -- typed knowledge graph
  id            uuid pk
  src_entity_id uuid -> entities
  type          text     -- promotes | about | competes_with | posted_to | drove | ...
  dst_entity_id uuid -> entities
  data          jsonb
  created_at    timestamptz default now()

brain.documents         -- file mount target
  id            uuid pk
  source_path   text
  chunk_index   int
  content       text
  content_hash  text     -- dedup; re-running mount is idempotent
  frontmatter   jsonb
  embedding     vector(1536) null   -- pgvector; populated when embeddings enabled
  tsv           tsvector            -- generated, for keyword search
  ingested_at   timestamptz default now()
```

Metrics-over-time falls out for free: each metric pull is an `events` row with
`type=metric_snapshot`. "What's working" is a query joining `current_facts` +
recent metric events + `edges`.

### 4.4 Retrieval (hybrid, lightweight)

Copying gbrain's stack minus the expensive parts:

1. **Vector** — pgvector HNSW over `documents.embedding` (and optionally
   fact/entity summaries).
2. **Keyword** — Postgres `tsvector` / `ts_rank` over `documents.tsv`.
3. **RRF fusion** — merge vector + keyword rankings, equal vote.
4. **Graph traversal** — follow `edges` for relational queries
   ("which posts promoted the campaign that beat competitor X?").

Reranker (gbrain's ZeroEntropy `zerank-2`) is **deferred** — it's the expensive
marginal piece. Intent classification and multi-query expansion are deferred.

### 4.5 Embeddings & cost gate

`roster brain init` presents an embedding cost note and asks before enabling
embeddings (gbrain's cost-confirmation lesson). Default model OpenAI
`text-embedding-3-small`; key from Infisical (`OPENAI_API_KEY`). Without an
embedding key, keyword + graph search still work; vector search is simply off.
Provider/model overridable via `roster brain config`.

## 5. CLI surface (`roster brain <verb>`)

| Verb | Purpose |
|---|---|
| `init` | Verify env URLs, run idempotent setup (extensions, schema, starter tables, restricted role, definer fns), cost-gate embeddings. Uses **admin** URL. |
| `doctor` | Connectivity; assert runtime role has **no** UPDATE/DELETE grant; pending migrations; table inventory; embedding status. |
| `save <kind> <slug> [--name] [--field k=v ...] [--data '{json}'] [--source] [--confidence]` | Upsert entity (insert if new) + append facts. |
| `event <type> [--entity slug] --data '{json}' [--at]` | Append a ledger event (metric snapshots, notes, corrections). |
| `link <src-slug> <type> <dst-slug> [--data '{json}']` | Add a typed edge. |
| `get <slug> [--json]` | Compiled truth (current facts) + recent timeline for one entity. |
| `query "<text>" [--kind] [--limit] [--json]` | Hybrid search (vector+keyword+RRF+graph). |
| `mount <file> [--source]` | Ingest file content as append-only `documents` rows (chunked, content-hash dedup, re-runnable). |
| `table create <name> --columns "..."` | Brokered DDL via `SECURITY DEFINER`. |
| `table list` | Inventory of brain tables (starter + agent-created). |
| `sql "<SELECT ...>"` | Read-only escape hatch. Rejects any non-SELECT statement. |
| `config <get|set> <key> [value]` | Embedding provider/model, search knobs. |

All verbs support `--json` for agent consumption.

## 6. Workspace wiring (the discipline layer)

Shipped in the scaffold so agents actually use the brain:

- `templates/scaffold/brain/RESOLVER.md` — the kinds, conventions, and a
  decision tree for "where does this go / do I need a new table?" Agents read it
  before creating entities or tables.
- `skills/brain/SKILL.md` — cross-tool front door (like `/inbox`): the verb
  cheatsheet and the brain-first protocol, routed through chat.
- Brain-first **hard rules** appended to the scaffolded workspace CLAUDE.md:
  1. Before answering about competitors / posts / strategy → `roster brain query` first.
  2. Corrections write to the brain immediately (`save` / `event type=correction`).
  3. Before creating a new table → check `table list` + RESOLVER (avoid sprawl).

## 7. Implementation notes (Roster conventions)

- New dependency: `pg` (one dep). Everything else hand-rolled. No ORM, no query
  builder — hand-written SQL in `src/lib/brain/`.
- Migrations reuse existing `src/commands/migrate.ts` + `src/lib/migrate`
  infrastructure; brain DDL ships as ordered `.sql` files.
- New files (sketch):
  - `src/commands/brain.ts` — verb dispatch.
  - `src/lib/brain/connect.ts` — pool, env URL resolution, no-secret-print guard.
  - `src/lib/brain/schema.sql` — starter tables, views, restricted role, definer fns.
  - `src/lib/brain/save.ts`, `event.ts`, `link.ts`, `query.ts`, `mount.ts`,
    `table.ts`, `doctor.ts`.
  - `src/lib/brain/search.ts` — hybrid retrieval (vector + tsvector + RRF + graph).
  - `src/lib/brain/embed.ts` — embedding provider abstraction.
  - `src/lib/brain-args.ts` — argv parsing.
- `package.json` `files` allowlist + `bin/roster.ts` dispatch updated.
- Tarball impact called out in PR (target stays lean; `pg` is the only add).

## 8. Testing

- Unit: arg parsing, SQL builders, RRF fusion, chunking/dedup, current-facts view
  logic.
- Integration: against a disposable Neon branch (or local Postgres in CI) —
  assert the runtime role **cannot** UPDATE/DELETE/DROP (negative tests are the
  core guarantee); assert brokered `table create` produces an admin-owned,
  insert-only table; assert `mount` dedups; assert hybrid `query` returns
  expected ordering.
- `roster brain doctor` exercised end-to-end.

## 9. Out of scope (v1)

- **Synthesis layer** — `query` retrieves ranked rows/chunks; it does not yet
  read them and write a cited answer with gap analysis (gbrain's differentiator).
  Deliberate post-v1 follow-up.
- **Scheduled feeders / automated ingestion** — wiring `dreamer`/`chief-of-staff`
  cron runs to write metrics/notes into the brain, and updating existing agent
  playbooks. v1 ships the store + verbs + brain-first rules only; without a feeder
  the brain stays empty until an agent writes to it.
- Reranker, intent classification, multi-query expansion.
- Overnight enrichment daemon ("dream cycle").
- Roster-provisioned Neon (BYO only).
- Global / cross-project brain (workspace-scoped only).
- Live file↔brain two-way sync (mount is one-way ingest).
- Multi-tenant per-user scoping within one brain.

## 10. Open questions

- Embedding provider default — OpenAI assumed; confirm or swap.
- Chunking strategy for `mount` (fixed-size vs heading-aware) — propose
  heading-aware for markdown, fixed-size fallback for other types.
- Whether `entities.slug` uniqueness is per-kind or global — proposed per-kind.
