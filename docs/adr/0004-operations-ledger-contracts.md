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
- **Local create-once publication fails closed.** The shared local writer
  (blobs, outbox spool bytes, per-fire sidecars, the pending-sync acknowledged
  marker) stages a same-dir `O_EXCL` tmp, fsyncs it, and publishes with
  `link(2)` — atomic create-if-absent, so a concurrent writer loses with
  `EEXIST` instead of being clobbered. On a filesystem that cannot hard-link it
  re-publishes with an `O_CREAT|O_EXCL` create at the final name (still
  exclusive) and, if even that is impossible, **refuses** with an error naming
  the limitation. It never degrades to a replacing `rename(2)`: rename would let
  two writers both "create" one name, silently rebinding a fire id to another
  run so the exit signal closes the wrong one.
- **Local reads apply one integrity standard.** `getArtifact` *and* `head` read
  the digest path through its descriptor (`O_NOFOLLOW` + `fstat` regular-file
  check) and verify `sha256 == digest`. `head` is what run reconstruction uses,
  so `run show` can never report an artifact `resolved` that `getArtifact`
  would reject — corrupt bytes, a directory, or a symlink at the blob path fail
  both identically.

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
- The gate covers operations that bypass the store wrappers too. `run doctor`
  and `run repair --fill-version-ids` issue v2-only declaration/version SQL on
  the runtime pool and enumerate the bucket through the admin object store, so
  they carry their own requirements (`runs.doctor` / `runs.repair` →
  `roster_ops: run-ledger` + `objects: content-addressed, version-id,
  list-prefix`), asserted **before any admin credential is resolved and before
  any SQL is issued**. A supported v1 postgres-s3 backend therefore gets the
  same actionable `VersionSkewError` as every other run-ledger operation rather
  than a raw missing-relation database error.
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

## Run + artifact ledger (#323)

The run + artifact ledger (`roster run`; migration `roster_ops/002`, schema v2)
builds the queryable, cross-machine-reconstructable run record on top of the v1
`RunStore`/`ArtifactStore` contracts. It is opt-in — legacy workspaces without
`persistence.yaml` never see it.

- **Event kinds (closed set).** `run-start`, `run-end`, `tool-call`,
  `tool-result`, `error`, `retry`, `resumed`, `approval-ref`, `report`,
  `artifact-declared`. The generic `roster run event` verb emits ONLY
  `error`/`retry`/`resumed`/`approval-ref`; lifecycle + `tool-*` come from the
  dedicated verbs (or the #322 hook), `report`/`artifact-declared` from their own
  verbs. Every repeatable kind requires a caller `--correlation-id`; singletons
  (`run-start`/`run-end`/`report`) carry a fixed dedupe key.
- **Trust taxonomy (a LEVEL, not a caller claim).** `source ∈
  {host-attested, cli, agent, unverified}`, stamped by the write **path**, never
  from caller `--data`. `host-attested` is #322's hook channel only (#323 never
  mints it); the `roster run` CLI stamps `cli`; agent `report` prose is `agent`;
  a missing/legacy value reads `unverified`. The composer promotes a **lifecycle
  fact** (start/end/exit) from `cli` or `host-attested`, but a **"successful
  external action"** ONLY from `host-attested` + a correlated tool result — a
  `cli`/`agent` claim renders *declared, unverified*. Agent prose is never parsed
  for success. Provenance is sealed OUTSIDE the payload hash, so a retry with a
  new pid/timestamp is idempotent (same id + hash) and duration is derived at
  read (`ended_at − started_at`).
- **Artifact identity split.** A **content blob** (bytes, keyed by digest, dedup
  once) is distinct from an **artifact declaration** (a run declares it
  produced/used a reference). Declaration id =
  `sha256(workspace_id, run_id, declaring_agent, role, ref)` where `ref` = digest
  (internal) or `provider:external_id` (external) — `role` is in the id, so a
  produced + a used declaration of the same reference by the same run/agent are
  two rows. External declarations carry no digest and stay `verified=false` until
  a #322 host-attested correlation (never caller-supplied, never runtime-mutated).
- **Blob identity is content-only.** The blob record's hashed payload is
  `{digest, size}` — run/provenance/filename/contentType metadata lives on the
  DECLARATION, never the blob — so two runs declaring identical bytes derive the
  SAME id AND hash (one blob row, dedup) and never `ConflictError`. `meta` rides
  as a store observation (first-write-wins).
- **Trust is unforgeable at the DB.** `source` is NOT a caller field — the store
  stamps it from the write path (`report`→`agent`, else `cli`). `host-attested`
  is #322's channel, produced by NO #323 path and REJECTED by a run_events CHECK,
  so a raw runtime INSERT cannot forge a trusted lifecycle or host-attested
  success. External declarations are CHECK-constrained to `verified=false`. The
  composer promotes an external SUCCESS only from a host-attested result carrying
  an explicit structured `{ok:true}`/`success:true` and no error — it fails closed
  on `{ok:false}` and on any unknown shape.
- **objectVersionId is a store observation.** `put`/`get`/`head`/`listPrefix`
  surface the S3 `x-amz-version-id`; it is never in any payload hash or
  delivery-ledger dedup key, so a queued write survives delivery with its
  recorded version unchanged — the drain threads the delivered version onto the
  artifact row, and reads fetch that EXACT recorded version (not "latest"). The
  runtime object IAM has no bucket-wide list; repair/doctor's `listPrefix` +
  version reads go through a DISTINCT admin/read credential provider
  (`resolveObjectAdmin` → `ROSTER_OPS_ADMIN_AWS_*`), and the least-privilege
  matrix grants runtime `s3:GetObjectVersion` (exact-version reads) and admin
  `s3:ListBucketVersions`/`s3:GetObjectVersion` (repair listing + hash-verify).
  Filling a missing/legacy `object_version_id` is an explicit admin verb
  (`roster run repair --fill-version-ids`) — the SOLE updater of
  `object_version_id`/`version_state`; it hash-verifies the candidate version's
  bytes against the digest BEFORE blessing and updates the blob + its declarations
  in ONE transaction (re-repairable if interrupted). A read never mutates.
- **The report cap is the PORTABLE raw limit (128 KiB).** `roster run report`
  advertises a raw input cap of `131072` bytes and enforces it BY THE READ (an
  over-cap file is refused from its stat; an over-cap pipe is abandoned one byte
  past the cap, never buffered whole just to be rejected). The number is derived,
  not chosen: the local JSONL backend applies a 1 MiB limit to the ENTIRE
  serialized record, and that record carries the report JSON-escaped (worst case
  6 bytes per input byte — a control byte becomes `\u00XX`), plus the sanitized
  index projection (≤ `MAX_INDEX_TEXT`, escaped by the same factor), plus the
  sealed envelope + hash chain. `6·131072 + 6·16384 + envelope < 1048576`, so a
  report at exactly the advertised cap is storable on EVERY backend for ANY byte
  sequence — the advertised limit is achievable end-to-end rather than a reader
  cap that a downstream record limit silently overrides. Larger output has its
  own path: `declare-artifact` (deliberately uncapped, digest-verified).
- **Workspace-tree reads are realpath-confined.** `O_NOFOLLOW` protects only a
  path's FINAL component, so every walker over `roster/<fn>/…` and
  `logs/cron/<fn>/…` resolves its DIRECTORIES through the shared workspace
  boundary (`workspace-path.ts`) before reading or mutating: a symlinked
  `roster/gtm/pending` can no longer make `roster review --reject` unlink a file
  in another repository, and a symlinked `roster/gtm` can no longer make
  `schedule install`/`remove` read and rewrite a foreign `schedules.yaml`. A
  refused path keeps its caller's contract — an actionable error where one
  exists, skip-with-report where the contract is skip-malformed.
- **Index policy (safe inputs only).** A shared TypeScript sanitizer redacts
  secret shapes (env/key-token/bearer/userinfo-URL/JWT/PEM/GitHub/Slack/AWS) at
  **write time**; only its output lands in `run_events.sanitized_report` /
  `artifact_declarations.sanitized_text`. A defensive admin-owned BEFORE INSERT
  trigger re-scrubs those DB-owned columns so even a raw runtime INSERT cannot
  land unredacted secret text (the runtime has no TRIGGER privilege to bypass it).
  The SQL views `run_index` / `artifact_index` expose ONLY validated identifiers +
  those internally-produced sanitized columns (never raw payload/provenance/
  digest/full URL) — projected `run_id`/`agent` failing the strict charset OR
  matching a secret SHAPE (ghp_/AKIA/xox/sk-/JWT/long-hex, even when charset-valid)
  normalize to a `legacy-<sha12>` sentinel, at write/backfill time and again
  defensively in the views. This delivers safe **index inputs**; **semantic-search
  retrieval (embedding + brain wiring) is deferred** (owner decision 2) as a
  tracked follow-up to #323.
- **Reliability.** Deterministic ids give idempotent replay; `diagnoseRunLedger`
  detects declaration-without-blob, orphan blob (via `listPrefix`), digest
  mismatch (bounded deep re-hash), object-version mismatch, run-end-without-start,
  dangling `parent_run_id`, missing legacy version ids, and a residual
  `declaration-version-unverified` — read-only. Outages spool run events through
  the #318 outbox (run events ARE spoolable, unlike HITL decisions) and converge
  on drain: a declaration spooled while its blob was queued carries a
  version-PENDING marker, and ordered materialization (blob first in the same
  namespace) derives `version_state='verified'` from the committed blob row, so a
  healed outage needs no operator repair. A declaration written on the direct
  path is never re-derived — there the committed ROW is the authority.

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
