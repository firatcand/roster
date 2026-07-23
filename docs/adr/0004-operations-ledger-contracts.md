# ADR-0004: Operations ledger — persistence backends, store contracts, and binding protocol

**Status:** Accepted
**Date:** 2026-07-23
**Deciders:** Firat (project owner)
**Relates to:** #317 (epic), #318 (this ticket), #319–#325 (consumers), ADR-0003 (brain file system)

## Context

The workspace's operational state — HITL requests and decisions, run events,
artifacts, and the counts the banner/inbox surface — lived only as Markdown
files under `roster/<function>/pending/`. That shape cannot survive multiple
machines, cannot express durable ordering or idempotent replay, and gives
approvals no tamper-evidence. #317 introduces an explicit **persistence
boundary**: every workspace chooses `local` (append-only JSONL ledger) or
`postgres-s3` (structured records in Postgres, immutable payload bytes in a
dedicated S3-compatible bucket) via `roster/persistence.yaml`, and every higher
layer depends on store interfaces — never on Markdown paths or SQL directly.

This ADR is the committed protocol reference for that boundary as shipped in
#318. Implementation lives under `src/lib/persistence/`; schemas under
`data/ops/schema/{hitl,roster_ops}/`.

## Owner decisions (locked)

1. **Shared persistence primitives** are extracted into `src/lib/persistence/`
   (`pool`, `migrate-core`, `s3-core`, `safe-path`); brain and ops both consume
   them. Brain's public behavior is pinned by characterization tests and its
   import paths are unchanged.
2. **Local backend = append-only JSONL ledger.** Markdown projections stay
   human-readable views (regeneration is #320).
3. **Credentials are env-only.** `database: brain` uses `ROSTER_BRAIN_URL` /
   `ROSTER_BRAIN_ADMIN_URL`; `database: dedicated` uses `ROSTER_OPS_URL` /
   `ROSTER_OPS_ADMIN_URL`. `persistence.yaml` never holds secrets — its schema
   rejects endpoint URLs carrying userinfo by construction.
4. **Workspace identity = UUID (authoritative) + display name.** Cloning a repo
   shares the identity by design; `roster ops setup --new-identity` forks.
5. **Strict 1:1 database binding.** One database = one workspace. Setup stamps
   the DB with the workspace UUID; every connection verifies the stamp and
   refuses on mismatch; claiming an already-stamped DB fails actionably. No
   RLS — isolation is physical. Nothing is ever unclaimed automatically.
6. **Dedicated object bucket per workspace.** No prefix-sharing across
   workspaces. The bucket is claimed at setup (marker object + DB stamp); ops
   keys use fixed internal prefixes (`hitl/`, `runs/`, `artifacts/`,
   `outbox/`).
7. **`.roster/ops/` is gitignored machine-local state.** Append-only is an API
   guarantee + hash-chain tamper-EVIDENCE, not OS tamper-proofing.
8. **Outage semantics = tri-state + fail-closed decisions.** Append-only event
   writes return `committed | queued` (never silent success); queued entries
   replay idempotently; reads/counts overlay queued items explicitly marked.
   HITL decisions and approval verification require the live store — no
   spooling, actionable error.

## Store contracts (`src/lib/persistence/contracts.ts`)

Three stores per backend — `HitlStore`, `RunStore`, `ArtifactStore` — bundled
as `OpsBackend`, plus interface-only `ActionAdapter` / `WakeAdapter`
declarations (#322/#324 implement). One contract test suite runs unchanged
against both backends.

- **Ids.** Deterministic full-length sha256, scoped `(workspace, namespace)`
  over a canonical-JSON identity (`computeRecordId`). The identity names the
  record, not its whole payload: an HITL request's identity is
  `(action, target, contentHash)`; a run event's is `(runId, dedupeKey)`; an
  artifact's is its byte digest. Same identity + identical payload hash ⇒
  idempotent-ok replay; same identity + different payload ⇒ `ConflictError`,
  never silent dedup.
- **Write outcomes.** Every write returns `{outcome: 'committed' | 'queued', id}`.
  `queued` means durably in the local outbox, not delivered. HITL decisions are
  the exception: they are never `queued` (owner decision 8) — a down store
  throws `BackendUnavailableError`.
- **Error taxonomy** (typed, all extending `PersistenceError`):
  `NotConfiguredError`, `BackendUnavailableError`, `WorkspaceMismatchError`,
  `ConflictError`, `VersionSkewError`, `InvalidRecordError`.
- **Cursor/watermark semantics.** Reads are ordered by store-assigned monotonic
  `seq`. The composite cursor is `{watermark, committed, overlay}`: `watermark`
  is the committed-seq high-water mark captured at page 1 — later pages only
  return committed rows at/below it, so an overlay record acked mid-pagination
  cannot reappear as committed (its committed seq lands above the watermark),
  and committed rows at/below the watermark are complete at capture time.
  `overlay` tracks position in the queued-overlay domain by
  `(producerId, producerSeq)`; queued entries order after committed rows within
  their namespace. A fresh listing observes the new state.
- **Counts.** `count()` on `HitlStore`/`RunStore` returns
  `{committed, queued, partial}` — queued overlay entries are counted
  explicitly, never folded into `committed`.
- **Artifacts are create-only content-addressed.** `putArtifact(meta, bytes)`
  is put-if-absent keyed by sha256 digest; replay verifies the existing digest.
  There is no delete anywhere in the interface.

## Strict 1:1 binding protocol (`postgres/binding.ts`)

Both schemas (`hitl`, `roster_ops`) carry a singleton `meta` row with the
binding: `workspace_id`, `workspace_name`, `state ∈ pending | finalized`,
`bound_at`, and the **canonical object-store tuple**
(`bucket`, `region`, `endpoint`, `force_path_style`, `marker_sha256`,
advisory `marker_etag`).

- **Two-state stamp, roll-forward only.** `stampPending` writes both schemas'
  rows in ONE transaction, tuple included. Refusal rules: `finalized` under a
  different UUID ⇒ "this database belongs to workspace <name> (<uuid>)";
  `pending` under a different UUID ⇒ stale-setup remedy (the owning workspace
  finishes its setup, or an admin clears the stamp manually — roster never
  auto-unclaims); same UUID with a different tuple ⇒ `ConflictError` **before
  any bucket claim** (one canonical tuple per workspace — no second bucket is
  ever claimed or stranded); same UUID with the exact tuple ⇒ resumable.
- **Per-connection verification.** `BoundPool` verifies the binding on **every
  new physical client** and gates first use: where `pg` supports
  `PoolConfig.onConnect` (feature-probed via `_promiseTry`) the pool itself
  gates; the checkout wrapper in `connect()` is kept in both modes as the
  version-independent guarantee — a client is never handed out unverified.
  Verification is cached per client object (WeakSet), never per process.
  Mismatch, unbound, or non-`finalized` state ⇒ `WorkspaceMismatchError`,
  fail closed.
- **Divergence check.** `hitl.meta` and `roster_ops.meta` are always written
  together; a divergence between them is an `InvalidRecordError` (out-of-band
  modification).
- **Belt-and-braces row stamps.** Every data row still carries `workspace_id`;
  `auditRowStamps` (doctor-callable) asserts no foreign rows exist.
- **Same-UUID tuple equality on resume.** A changed workspace name changes the
  marker sha256 and is therefore a tuple mismatch by design — resume requires
  exact equality of the whole tuple.

## Bucket claim, marker, and create-only object rules (`objects.ts`)

- The bucket is claimed by **setup with admin credentials**, never runtime
  creds. The marker object `roster-workspace.json` (deterministic body
  `{workspaceId, name}` + newline) is written with `If-None-Match: *`;
  concurrent claims arbitrate at the bucket (one winner). An existing marker
  with a different UUID ⇒ refuse; a root object that is not a roster marker ⇒
  refuse (dedicated buckets only).
- The DB records the marker's **sha256 body digest** as the trust anchor
  (`marker_sha256`, stamped in the initial pending transaction — computable
  before the claim because the body is deterministic). The etag is stored as
  advisory only: etags are not content digests for multipart uploads. **The
  1:1-bound database is the trust root; the marker is the cross-workspace
  accident tripwire.** `resolveOpsBackend()` re-verifies both on every
  resolution (config tuple = DB tuple AND marker body sha256 = recorded
  digest), not just at setup.
- `CreateOnlyObjectStore` is compile-time separated from brain's deletable
  `FileStore`: `putIfAbsent` / `get` / `head` / `getMarker` — no `del`, no
  overwrite. On a lost create race, the existing object's digest is verified:
  identical bytes ⇒ idempotent-ok, different bytes ⇒ `ConflictError`.
- Keys are built internally from the four fixed prefixes + safe-path-validated
  segments; callers never build full keys. The marker sits at the bucket root,
  outside the data prefixes, exposed only via `getMarker()`.
- Setup validates **bucket versioning is enabled** (hard requirement) and
  records **Object Lock** availability as a negotiated `objects` capability
  (absence is not an error — MinIO/R2 without lock still work).

## Outbox event model (`outbox.ts`)

The outbox is the `outbox` namespace of the workspace's local ledger tree —
immutable events `enqueued` / `attempt` / `acked` /
`failed{transient|permanent}`; per-entry state is derived by folding events,
never by mutation or tombstone-rewrite. `checkpoint.json` (last-acked
producerSeq per namespace, checksummed) is purely derived — a torn or invalid
file is discarded and recomputed from the segments.

- **Ordering domain (contractual).** Ordering is guaranteed per
  **(producer machine, namespace)** — the only domain implementable across
  independently-outaged clones. Every record carries
  `(producerId, producerSeq)`; cross-producer interleaving is by server
  arrival.
- **Backlog barrier.** While a namespace has queued entries, new writes to that
  namespace append behind them (`queued`) even if connectivity has returned —
  a live write can never overtake older queued records (`writeThrough`
  enqueues first, then drains in strict producerSeq order).
- **Poison / head-of-line.** Transient failures retry with backoff+jitter up to
  the attempt cap (default 5), then `failed{permanent}` **parks the namespace
  queue** (barrier holds, doctor-visible with the poison entry named) — order
  is never silently violated by skipping. Exception — **Conflict-advance**: a
  `duplicate` deliver result (server already holds the id with an identical
  payload hash) is acked-equivalent and advances; a different hash is a genuine
  `ConflictError` and parks.
- **Replay dedup.** Crash-after-commit-before-ack re-sends; the server-side
  `roster_ops.delivery_ledger` (unique on
  `(workspace_id, namespace, record_id)` with payload-hash equality) turns the
  replay into a no-op ack.
- **Overlay union.** Reads/counts union committed rows with queued entries **by
  record id with payload-hash equality**: an id already committed with an
  identical hash is excluded (no double-count); an id collision with a
  different hash is a conflict — surfaced, durably parked, still counted, never
  silently dropped. Strict mode surfaces remote failure as
  `BackendUnavailableError`; the explicit `allowPartial` opt-in returns the
  overlay only, flagged `partial: true`. Known mismatches
  (`WorkspaceMismatch`, `VersionSkew`) fail hard even in `allowPartial` mode.
- **Artifact spool.** Large payloads never enter JSONL: bytes stage to the
  content-addressed fsynced spool
  (`.roster/ops/<workspaceId>/spool/<sha256>`); the outbox event references the
  digest. Publication is **object-first, index-last**: S3 put confirmed
  (digest-verified) → PG artifact row → ack, so a committed index row always
  implies readable, digest-verified bytes. Spool bytes are quota'd
  (default 256 MB, typed `SpoolQuotaError`).
- The drain revalidates the DB binding AND the bucket marker before any remote
  I/O — a re-pointed URL or swapped bucket parks the drain instead of
  delivering into a foreign workspace.

## Setup journal and roll-forward recovery (`setup-journal.ts`, `setup.ts`)

`roster ops setup` is crash/race-complete and **roll-forward only** (nothing is
ever compensated or unclaimed, per decision 5).

- **Exclusive local lock** first: an OS-temp lockfile keyed by the canonical
  workspace path (O_EXCL, stale-pid reclaim). One winner; the loser errors
  immediately.
- **Journal** at the fixed path `.roster/ops/setup-journal.json` (outside the
  per-UUID tree, discoverable before `persistence.yaml` exists).
  `resolveOpsBackend` checks it FIRST: any non-`done` phase resolves to
  `setup-incomplete` with the re-run remedy.
- **Phases:** `intent → gitignore-ensured → db-stamped-pending(+canonical
  bucket tuple) → bucket-claimed → db-finalized → config-written → done`.
  All journal/gitignore/config writes are atomic
  (temp → fsync → rename → dir-fsync). The gitignore side effect runs before
  the journal lands, so no `.roster/ops/` file ever exists unignored.
- **The journal records intent; remote state is truth.** Re-entry re-runs every
  phase's idempotent operation, which also discovers a remote commit the
  journal never saw (crash after remote commit, before journal update) and
  rolls forward — never refusing the rightful owner. Remote races arbitrate at
  the remote: DB stamp transaction (one winner), marker If-None-Match (one
  winner).
- **Mandatory pre-finalization role gate.** Before `db-finalized`, setup runs
  the role invariant checker and refuses to finalize while the runtime role
  has unsafe attributes (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION,
  BYPASSRLS), owns the database/schemas/objects, or holds destructive
  effective privileges (direct or inherited, incl. PUBLIC and default ACLs) on
  the ops schemas. The error names each surplus privilege with the exact
  `REVOKE`/`ALTER ROLE` — setup never silently strips an operator-supplied
  role.
- `--new-identity` refuses when the current identity has stamped remote
  resources unless `--yes` (prints what it will orphan); the old identity's
  tree stays archived under its old UUID — never deleted, never replayed into
  the fork.

## Capability negotiation (`capabilities.ts`)

`backendInfo()` reports per-component versions + capabilities —
`{roster_ops, hitl, objects}` version independently because the schemas
migrate independently. The metadata is **admin-authored, runtime-read-only**
(setup/migrations write the PG meta tables and the local `meta.json` mirror;
nothing in the runtime path mutates it).

- The CLI declares supported ranges (`SUPPORTED_COMPONENT_RANGES`) and required
  capabilities per operation (`OPERATION_REQUIREMENTS`); every store write is
  gated by `assertOperationSupported` **before any I/O**. A future component
  version refuses with "upgrade the CLI"; a below-floor version with "migrate
  the backend". Unknown *extra* capabilities are ignored (forward-compat);
  only missing required ones refuse.
- The local mirror is checked first (offline) during postgres-s3 resolution: a
  future version in `meta.json` refuses before any remote traffic.
- `persistence.yaml` itself is versioned separately: a future `version` errors
  with the upgrade remedy before schema validation and before any backend I/O.

## Degraded mode and fail-closed decision rules (`resolve.ts`)

`resolveOpsBackend(cwd)` is the single factory (#320/#321 consume it). Five
states: `legacy` (no config — read-only adapter over today's pending files),
`setup-incomplete`, `local`, `postgres-s3`, `degraded`.

- A **transport** failure during postgres-s3 resolution must not defeat durable
  spooling: the factory returns a degraded backend where spoolable writes
  (HITL requests, run events, artifacts) queue to the outbox and reads/counts
  throw `BackendUnavailableError`.
- A **known mismatch** — `WorkspaceMismatch`, marker digest mismatch,
  `VersionSkew`, config-vs-DB tuple mismatch, `NotConfigured` — fails hard
  **without queuing**: spooling toward a wrong-workspace target is never
  allowed.
- Object-store transport down with the database up is still degraded: artifact
  publication is object-first, so no remote write can proceed safely.
- HITL decisions fail closed in every degraded path (`BackendUnavailableError`,
  never spooled) — an approval must be verifiable against the live store at
  decision time.

## Rejected alternatives

- **RLS / shared database multi-tenancy.** A policy bug away from cross-
  workspace reads; the 1:1 physical binding makes isolation a connection-time
  invariant instead of a per-query one, and keeps the runtime grant surface
  auditable (owner decision 5).
- **Prefix-sharing one bucket across workspaces.** Key-construction bugs become
  cross-workspace writes; IAM prefix conditions are easy to get subtly wrong.
  A dedicated bucket + root marker turns "wrong bucket" into a refusal.
- **Mutable outbox state file (rewrite-on-ack).** A crash mid-rewrite loses the
  queue; the fold-over-immutable-events model reuses the ledger's durability
  protocol and keeps every transition auditable.
- **Compensating (unclaim) setup recovery.** Conflicts with locked decision 5
  and creates a window where two setups each believe they own the resources;
  roll-forward + remote arbitration has one winner by construction.
- **Global cross-machine ordering.** Impossible during independent outages;
  per-(producer, namespace) is the strongest honest contract.

## Consequences

- #319–#324 compile against these interfaces (`HitlStore`, `RunStore`,
  `ArtifactStore`, `ActionAdapter`, `WakeAdapter`) and swap implementations,
  not seams. The HITL state machine (#319) adds transition validation on top
  of the append plumbing shipped here.
- The runtime role cannot delete or rewrite operational history on either
  backend (grants + create-only store + versioning); an admin with bucket
  delete rights still can — versioning (and Object Lock where available) is
  the operator hardening against that.
- Local mode is a first-class supported mode, not a fallback; legacy
  workspaces without `persistence.yaml` behave exactly as before
  (regression-tested).
- Outbox segment compaction/retirement is deferred (v1 ships the fold +
  checkpoint only); quotas apply to the active spool.
- `.roster/ops/` grows unboundedly append-only until a future compaction
  ticket; it is machine-local and gitignored, so the repo does not.
