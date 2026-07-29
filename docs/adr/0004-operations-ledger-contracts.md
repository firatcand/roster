# ADR-0004: Operations ledger — persistence backends, store contracts, and binding protocol

**Status:** Accepted
**Date:** 2026-07-23
**Deciders:** Firat (project owner)
**Relates to:** #317 (epic), #318 (this ticket), #319 (HITL state machine — appended below), #320–#325 (consumers), ADR-0003 (brain file system)

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
  record, not its whole payload: a v1 HITL request's identity is
  `(action, target, contentHash)` (#319 re-keys it to the request group — see
  below); a run event's is `(runId, dedupeKey)`; an artifact's is its byte
  digest. Same identity + identical payload hash ⇒ idempotent-ok replay; same
  identity + different payload ⇒ `ConflictError`, never silent dedup.
- **Write outcomes.** Every write returns `{outcome: 'committed' | 'queued', id}`.
  `queued` means durably in the local outbox, not delivered. HITL decisions are
  the exception: they are never `queued` (owner decision 8) — a down store
  throws `BackendUnavailableError`. #319 widens that exception to the whole
  `hitl` namespace and gives HITL writes their own version-bearing
  `HitlWriteOutcome` (see *HITL state machine*).
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
  decision time. #319 extends fail-closed to every HITL verb, reads included:
  the degraded HITL store throws on every call and honors no `allowPartial`.

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

## HITL state machine (#319)

The HITL half of the ledger gets its state machine in #319: migration
`hitl/002_state_machine.sql` (component version 2, capability `state-machine`),
the shared pure machine `hitl-machine.ts`, the store-side derivation/policy layer
`hitl-store.ts`, the bookkeeping sweep `hitl-sweep.ts`, and the local v1→v2
conversion `hitl-local-migrate.ts`. This ticket ships the schema, the machine and
both stores — the `roster hitl *` verbs are #320, hook enforcement of
`validateApproval` is #322.

- **Identity is the request GROUP, not its content.**
  `request_key = sha256(functionName, action, normalized target)` and
  `request_id = sha256(workspace_id, request_key)` — content is deliberately
  *out* of the key, so a revised packet lands as the next version of the same
  group instead of a stranded new row, and the id is known before the write
  (it satisfies the contract's `WriteOutcome.id`). `generation` and `version` are
  allocated synchronously under the per-group lock (Postgres
  `pg_advisory_xact_lock(hashtext(request_key) # 1212765260)` — the mask is
  `0x4849544C` ('HITL'), deliberately NOT a schema-migration key, since the mask
  IS the resulting lock id whenever `hashtext()` returns 0; local: the ledger's
  `hitl` namespace lock) and returned in the outcome. Decision and FK identity is
  `(request_id, generation, version)`; a group's whole history lives under the one
  `request_id`. Every digest is sha256 over **length-prefixed framing**
  (`"<utf8 byte length>:<field>"`, optional fields as a presence pair, targets
  ASCII-trimmed only) so core SQL (`sha256(bytea)`, PG ≥ 11 — no pgcrypto, no
  PG ≥ 13 `normalize()`) reproduces byte-identical values; Node↔SQL test vectors
  pin the two implementations together.
- **Sealed generations.** A group is *open* only while its current version's
  status is `awaiting` or `deferred`. A same-key submission revises the open
  version (v+1); the first terminal decision seals the generation, and a later
  same-key submission opens generation G+1 at version 1 — an independent
  approval, never a reopening. `deferred` is the only non-terminal decision (it
  stays in the actionable queue); `approved`, `changes-requested`, `rejected`,
  `expired`, `cancelled` are all terminal sinks. `planSubmission` returns
  `idempotent | revise | open-generation | conflict`: an identical packet on an
  open head is idempotent, an identical packet after a terminal decision is a
  *fresh ask*, never a silent no-op.
- **Sealing ≠ authority.** Sealing governs generation ALLOCATION. Authority is
  `canAuthorizeExecution(head, now)`: the head of the **highest** generation, its
  current version, unsuperseded, effective status `approved`, unexpired, and
  `canonicalization_version > 0`. An approved head is terminal — and terminal is
  exactly what the normal approve-then-execute path looks like — so being sealed
  is *not* a reason to refuse, and authority never falls back to an older
  generation. `validateApproval` adds exact binding of action, action kind,
  target + target hash, packet hash, canonicalization version, and the exact
  stored expiry. The caller's optimistic `expectedHead` is **required** and binds
  the **highest observed generation's** head as
  `{generation, version, packetHash, sealed}`; `null` means "no history for this
  key at all". `sealed` is a mandatory member, not decoration: a terminal
  decision (or an elapsed expiry) changes NOTHING else about a head, so a
  fingerprint without it cannot distinguish "the open head I read" from "the
  approval that landed while I composed my packet", and a stale submission would
  open the next generation behind a fresh approval. Under the lock, any mismatch
  is a synchronous `ConflictError` — so a caller that observed G1 cannot silently
  mint G3 after an intervening G2 it never saw, and a caller that observed an
  OPEN head cannot open G2 behind an approval it never saw. There is no
  "adopt whatever head is there" mode for callers; the one exemption is the
  pre-#319 spool drain, whose "observation" is the store's own read inside the
  same advisory-lock section (no read-to-write window exists there). A `null`
  expectation is additionally honored idempotently when the head turns out to be
  an OPEN, byte-identical packet — an at-least-once retry of the same ask, which
  by construction cannot cross a terminal boundary.
- **Insert-only; supersession is derived from row existence.** There is no
  UPDATE grant anywhere in the runtime role. A revision inserts version N+1; a
  cross-group edit (`replaces`) inserts the destination version carrying
  `supersedes_{request_id, generation, version}`, and an anti-join over that
  partial index makes the source head non-authoritative *and* undecidable —
  nothing is ever rewritten. `replaces` validates BOTH expected heads and its
  idempotency is over the (packet, supersession link) pair, not the packet
  alone: if the destination already holds the requested packet but does NOT
  already record this supersession, the replace still writes the version that
  does. A replace never reports success while the source approval is still
  authoritative; a genuine replay (the link is already recorded) is the only
  idempotent case.
- **A superseded group is permanently closed.** The supersession pointer lives on
  the DESTINATION row, so being replaced changes NOTHING about the source head's
  own fingerprint — same generation, same version, same packet hash, same
  `sealed`. An `expectedHead` observed before the replace therefore still matches
  afterwards, and without a second rule a stale caller could submit a same-key
  revision (or, on a sealed head, open G+1) that no supersession row points at:
  a NEW head, authoritative alongside the destination — two live approvals for
  one decision that was meant to be replaced. So the SAME anti-join that makes a
  superseded head non-authoritative and undecidable is read INSIDE the group lock
  during submission planning and closes the group: any plan that would WRITE
  (`revise`, `open-generation`) against a superseded head is a `ConflictError`
  (`superseded-head`), on both backends and on the pre-#319 spool-drain path, and
  the source side of `replaces` is refused the same way so two destinations can
  never each claim to cancel one head. There is no reopen intent — the caller
  re-reads and targets the group that replaced it. Only a byte-identical packet
  against an open head stays idempotent, because it writes nothing at all and is
  therefore an at-least-once retry rather than a resurrection. That exemption is
  exactly why closure is evaluated against the FINAL plan and not the derived
  one: a `replaces` still owes its supersession link, so a no-write `idempotent`
  destination plan is UPGRADED to a writing revision when the destination head
  does not already record that link — and an upgraded plan is a write. `A→B`,
  then `B→C`, then `X→B` with B's own fingerprint and packet took that door and
  committed B v2, which C's pointer at B v1 does not cover: B v2 came back
  unsuperseded and approvable alongside C. The upgrade and the re-check now live
  in ONE function (`finalizeSubmissionPlan`), which is the only place any plan's
  kind may change after `planSubmission` returned. Consequences of
  the same closure: a superseded head is dropped from the DEFAULT actionable
  list/count workset on both backends (an explicit `status` filter still reaches
  it — that query is history, not the queue), and it is never an expiry
  candidate; `insertSystemExpiry` reports `conflict` for one rather than writing
  (local) or raising (postgres, where the decision trigger refuses every decision
  on a superseded version, system expiry included). The admin-owned, plain
  (never `SECURITY DEFINER`)
  BEFORE INSERT trigger on `hitl.decisions` takes the per-group advisory lock
  FIRST and then refuses a prior terminal decision, a non-head version, a sealed
  generation, a superseded head, and a wrong-direction expiry — the invariants
  hold even against a raw runtime INSERT. Lock-then-read is sound only under
  READ COMMITTED (a higher isolation's snapshot predates the lock and cannot see
  a concurrent terminal), so the trigger reads
  `current_setting('transaction_isolation')` and RAISEs otherwise; the store
  opens every HITL transaction with an explicit
  `BEGIN ISOLATION LEVEL READ COMMITTED` and takes multiple group locks in sorted
  key order, so two opposite-direction `replaces` cannot deadlock. Expiry
  comparisons use `clock_timestamp()`, never `now()` (statement time would let a
  long transaction decide a request that expired while it waited). Concurrency
  arbitrates deterministically at the database: a partial unique index
  `(workspace_id, request_id, generation, request_version) WHERE terminal` gives
  one terminal decision per version, a second unique index adds `status` to block
  a duplicate `deferred`, and the loser's `23505`/`23514` surfaces synchronously
  as `ConflictError`.
- **Expiry is enforced twice, on purpose.** `effective_status` (the
  `hitl.request_state` view and the mirrored `deriveRequestState`) reports
  `expired` the moment the clock passes `expires_at` with no terminal decision,
  so **authority and the actionable count are sweep-INDEPENDENT**: an un-swept
  expired request is never authorizable and never counted. The sweep only
  MATERIALIZES the durable system `expired` decision, whose id is
  `sha256(workspace, 'expired', request_id, generation, version)` — no clock, no
  decider — so two concurrent sweeps converge (`ON CONFLICT DO NOTHING` plus the
  trigger's identical-expiry exemption) instead of one failing. It is bounded and
  paginated (default 200 candidates), throttled (60 s) off every mutating verb and
  every actionable listing, and swallows its own failures because nothing depends
  on it. Before a new generation opens for an effective-expired key, generation
  N's expiry is materialized in the SAME lock/transaction — a new generation can
  never hide the previous one's expiry, and neither can a cross-group
  supersession: `replaces` materializes the SOURCE head's owed expiry in the same
  transaction/batch too, before the destination row that closes it. Policy lives in `persistence.yaml` under
  `hitl.expiry` (`default_ttl_ms` 24 h, `min_ttl_ms` 1 h, `max_ttl_ms` 7 d): a
  per-request expiry outside the bounds is **clamped with a warning** (surfaced in
  `HitlWriteOutcome.warnings`), never refused — the request still has to reach a
  human. An execution request always carries an expiry (DB CHECK); an editorial
  one may be open-ended, and the `now < expires_at` guard simply does not apply
  to it. On postgres the policy is resolved against the **database** clock, read
  under the group lock, and the packet is re-sealed around the result before the
  insert — `expires_at` is packet-visible, so the stored expiry is always the
  expiry that was hashed, and `hitl.fill_request_derived()` leaves a supplied
  `packet_hash` untouched. Resolving it on the application clock made the policy
  and every expiry CONSUMER (`effective_status`, the decision trigger, the
  sweep's stamp — all `hitl.now_ms()`) disagree: an app clock two days behind the
  database minted a 24 h request that was BORN expired, and one ten days ahead
  minted an expiry past the DB-relative 7-day maximum the bounds promise.
- **Packet identity: any approval-visible change is a new version.**
  `packet_hash` covers the action, the action kind, the normalized target and its
  hash, the content channel (the inline content hash, or the canonical
  `payload_ref` including its immutable `objectVersionId`), `expires_at`,
  `canonicalization_version`, the **title**, `summary`, `warnings`,
  `side_effects`, `choices`, and the attribution rendered beside the ask —
  `origin_run_id`, `origin_task_id`, `requesting_agent`. Presentation and
  attribution are approval-visible, so they are identity: re-submitting the same
  body under a different title or requesting agent is a different approval
  question, and returning the OLD row idempotently would silently keep the old
  presentation. `title` is framed as a plain (never-absent) field — a legacy row
  without one normalizes to `''` in the TS conversion, the SQL backfill and the
  fill trigger alike — while the origin/agent trio uses the presence-pair
  encoding. Audit-only observations (`created_at`, `seq`, the *allocated*
  generation/version) are excluded so an idempotent replay hashes identically.
  The canonicalization version stays `1`: no shipped code has ever persisted a
  `packet_hash`, so there is exactly one v1 framing, and the migration backfill
  computes the same bytes as the TypeScript for the same converted row (pinned by
  the Node↔SQL vector suite, which covers the newly-included fields).
  Changing anything a human would read on the approval card — including the
  expiry or the summary — is version N+1, never a silent edit under an existing
  approval. Content is verified server-side at write (`sha256(body)` must equal
  the caller's `contentHash`); a body over 8 KiB offloads to the object store and
  the row carries the reference instead, in which case `hitl.requests.content_hash`
  holds that object's digest — the same digest the packet binds and the read path
  re-verifies (postgres-s3 fetches the exact recorded object version, never
  "latest"; local reads the digest-named blob) before returning a body.
- **`canonicalization_version = 0` is categorically non-authoritative.** The
  migration exempts a legacy row whose stored hash does not cover its stored body
  from write-time verification, so an old workspace can still upgrade. That
  exemption grants no authority: such a head fails `canAuthorizeExecution` and
  `validateApproval` unconditionally, and `hitl.request_state.authoritative`
  requires `canonicalization_version > 0`. An approval whose content hash was
  never validated can never authorize execution.
- **Editorial vs execution is a closed allowlist, execution by default.**
  `EDITORIAL_ACTIONS` (`approve-draft`, `approve-lesson`, `select-candidate`,
  `acknowledge-error`) choose or bless content; **everything else, including any
  unknown or attacker-chosen action name, classifies as `execution`** — fail-safe,
  so no action can downgrade itself into the weaker expiry-optional regime. An
  editorial approval can never satisfy an execution request (`validateApproval`
  compares the action kind exactly). The allowlist is duplicated in SQL
  (`hitl.classify_action`) and pinned byte-for-byte against the TypeScript set by
  test.
- **Live-store-only (owner decision 6) — structural, not conventional.**
  `createRequest`, `replaces` and `appendDecision` all require the authoritative
  store. #318's kind-level `hitl-decision` guard becomes a NAMESPACE guard: the
  entire `hitl` namespace is refused at `LocalOutbox.enqueue`, so a hand-rolled
  enqueue throws instead of the guarantee resting on every store politely
  choosing the direct path. There is consequently no queued HITL overlay at all —
  degraded HITL reads throw `BackendUnavailableError` and `allowPartial` is
  deliberately not honored, because an approval system that answers "nothing
  awaiting" from a partial view is worse than one that admits it cannot answer.
  For a workspace with no database **the local JSONL ledger IS the authoritative
  live store** (writes are synchronous to disk under the namespace lock, and
  either commit or throw). Because HITL never spools, its write path bypasses the
  outbox and the generic delivery-ledger dedup entirely and returns a
  version-bearing `HitlWriteOutcome`
  (`{outcome:'committed', id, requestId, generation, version, idempotent,
  warnings}`) rather than the spoolable `WriteOutcome`; the local *physical*
  record id is composite `(request_id, generation, version)`, since reusing the
  stable logical id would make every revision collide with its base version. The
  namespace stays a valid outbox *target* so a spool a pre-#319 CLI created still
  drains — those legacy entries allocate v2 identity server-side under the same
  per-group lock, landing as coherent v2 rows or not at all.
- **Migration — Postgres.** One transaction under the `hitl` migration advisory
  lock, ledgered by filename + sha256 (it runs exactly once; an edited file is
  refused), with no blanket `IF NOT EXISTS` so the destructive steps either
  complete or roll back. A **preflight refuses an unreadable legacy history**
  with a per-row report rather than guessing an approval scope: orphan decision,
  unknown decision status, two terminal decisions on one request, duplicate
  same-status decisions, a decision stamped before its request, and the real
  ambiguity — a same-key request created *before* the previous one's terminal
  decision landed (revision inside the open generation, or a fresh one?). Then:
  additive nullable columns → compute the identity/generation map into a temp
  table → DROP the v1 `UNIQUE (workspace_id, id, version)` (generation 2 version 1
  would collide with generation 1 version 1) → apply the map (decisions first,
  then the re-keyed requests) → constraints, composite FK, indexes, triggers,
  views → `SET NOT NULL` → `meta` component version 2. The **re-key** is what
  makes legacy history usable: v1's `requests.id` hashed the CONTENT, so two
  revisions of one proposal landed under different ids; the backfill re-derives
  `id` from `request_key` and preserves the old value in `requests.legacy_id`
  (nothing is lost, and the queued-decision drain resolves either id).
  **Generation partitioning** orders same-key rows by `(created_at, seq)` and
  cuts a new generation after every row carrying a terminal decision; a legacy
  execution row with no recorded expiry gets `created_at + default TTL` (history
  at rest is allowed to land already-expired, unlike a live insert). Every
  preflight check, the terminal partition and the decision remap are keyed by the
  FULL v1 identity `(workspace_id, id, request_version)` — v1's unique is
  `(workspace_id, id, version)`, so one legacy id can carry several versions and
  an id-only join would map a decision onto an arbitrary generated version and
  let a decision naming a nonexistent version attach to version 1 instead of
  being refused.
- **Every derived column is derived by the database, never asserted by the
  writer.** The BEFORE INSERT fill trigger RECOMPUTES `action_kind =
  classify_action(action)`, `request_key = request_key(functionName, action,
  target)` (functionName read from whichever content channel is live: `payload`
  or `payload_ref.meta`, empty normalizing to the same `unknown` sentinel the TS
  side uses) and `target_hash = target_hash(target)` on every insert. A writer
  that omitted them gets them filled; a writer that ASSERTED a different value is
  REFUSED, never silently corrected — claiming a derivation you did not compute
  is a bug or an attack. Trusting them was a hole with real consequences: with
  plain INSERT alone one could store `action='publish-post'` as
  `action_kind='editorial'` with NO expiry (editorial may be open-ended) and,
  once approved, hold an expiry-free EXECUTION approval that both
  `hitl.request_state.authoritative` and `canAuthorizeExecution()` accepted;
  naming an arbitrary `request_key` likewise opened a rival group for one real
  (function, action, target). `canonicalization_version` is derived and verified
  the same way, and in BOTH directions — the stored value must EQUAL the derived
  one — because the version is the row's own assertion that its `content_hash`
  covers its content, the assertion D8, `authoritative` and `validateApproval`
  all rest on. This schema derives exactly two values, `1` when the content is
  verified and `0` when it is not, so a `0` asserted over verified content and a
  "forward-compatible" positive version the schema cannot verify are refused just
  like an overstated `1`; the TS side ships exactly one canonicalization version,
  and introducing a second is a schema change that teaches the trigger to derive
  it, never a value a writer asserts past it. What "covers" means is per CHANNEL: an inline
  row needs `payload->'body'` to be a JSON **string** whose sha256 equals
  `content_hash` (an empty body that hashes to `sha256('')` qualifies — the same
  rule the TS conversion applies, so one legacy row can never convert as verified
  on one backend and exempt on the other); a `payload_ref` row carries no bytes,
  so what it binds is the REFERENCE — `payload_ref->>'digest'` must equal
  `content_hash`, and the bytes themselves are re-hashed against that digest by
  every reader that materializes them. Version 0 stays the legacy exemption.
  Without this, a plain INSERT stored `payload.body = 'benign text'` beside
  `content_hash = sha256('something executable')` with
  `canonicalization_version = 1`, and once approved that head was `authoritative`
  and `validateApproval` authorized the packet the approver never saw.
  `packet_hash` is the one derivation the DB does not
  recompute — it covers jsonb fields whose JS canonical form SQL cannot reproduce
  — so a row that carries packet-visible fields WITHOUT a packet hash is refused
  rather than hashed with those fields silently absent.
- **The database validates ALLOCATION, not only derivation.** Deriving a row's
  identity says nothing about WHERE in its group's history the row may land, and
  the runtime keeps INSERT on `hitl.requests`, so that half was
  application-enforced only: a raw runtime INSERT could add generation 2 version
  1 to a group whose head another group had already superseded — the existing
  pointer names generation 1 version 1, so the new head read as unsuperseded,
  actionable, and approvable. The fill trigger now takes the SAME per-group
  advisory lock the store and the decision trigger take (re-entrant, so a store
  transaction that already holds it pays nothing; a `replaces` row locks both
  groups in the same sorted key order `inGroupTxn` uses, so a raw INSERT can
  queue behind a store transaction but never cycle with one) and refuses an
  insert that (a) extends a group whose current head is superseded — permanent
  closure, enforced by the database; (b) claims a `(generation, version)` that is
  not the legal next step: no gaps, no reuse, no revision inside a sealed
  generation, no generation G+1 while generation G is still open; or (c) names a
  supersession target that is not the current, not-already-superseded head of the
  group it replaces (nor its own group), or one that is EFFECTIVELY expired with
  no durable terminal decision; or (d) revises a head that is
  EFFECTIVELY expired. (b) and the clock-judged halves of (c)/(d) are a set, and
  they are deliberately judged by different things. A generation counts as SEALED for (b) by its DURABLE
  terminal decision alone, never by the clock — every store path that opens G+1
  over an expired head materializes that head's `expired` decision in the same
  transaction FIRST, so the decision-only test accepts every legal allocation
  while staying immune to a clock that crosses the deadline between the store's
  plan and the trigger. That left the in-place revision door open: a raw `G1/V2`
  landed on an expired-but-unswept head, became the group's awaiting, actionable
  head, and HID `V1` from every future sweep, so the expiry the model requires
  was never recorded at all. (d) closes it by the CLOCK — `expires_at <=
  clock_timestamp()` with no terminal decision — and costs no legal allocation,
  because `sealed` in the projection the store plans against already counts the
  clock, so no store path ever plans a revision of an expired head. (c)'s expiry
  half closes the same door from the OTHER group: a supersession pointer closes
  the source head permanently — a superseded version is skipped by both
  backends' expiry-candidate scans and refused by the decision trigger — so
  pointing at an expired-but-unmaterialized head lost its transition rather than
  deferring it. `replaces` now materializes BOTH closed heads' owed expiries
  (the destination's generation boundary and the source's) inside the same
  two-lock transaction/batch, in sorted `request_key` order, BEFORE the
  destination version row that closes them. Together an
  expired head accepts nothing until its expiry is durable, and only G+1
  afterwards; both rules are monotone in the same direction (a decision is never
  un-recorded, a deadline never un-passes), so neither flips from refuse back to
  accept, and the one window either leaves — a deadline crossed between the
  store's plan and its insert — surfaces as the same synchronous `ConflictError`
  the decision trigger's expiry-direction check raises, which the caller re-plans
  as G+1. The supersession anti-join itself is
  now written once (`hitl.head_superseded`) and called by all three consumers —
  the `request_state` projection, the decision trigger, and this gate. Because
  this gate lock-then-reads exactly as the decision trigger does, it carries the
  SAME isolation contract and RAISEs above `READ COMMITTED`: a writer whose
  snapshot predates the lock would read the group as it was before a concurrent
  supersession or terminal decision and allocate a head beside it.
  What remains APPLICATION-enforced, deliberately: (1) `expectedHead` optimistic
  concurrency and `intent` — the database has no notion of what a caller
  observed, so a raw INSERT that allocates a LEGAL next version is accepted; it
  cannot resurrect, skip, or fork a group, only append to one legally; and (2)
  `packet_hash`, which the DB cannot recompute (above) — a raw INSERT that
  supplies a hash not covering its own packet is stored as given, so for such a
  row the fingerprint and `validateApproval`'s packet binding rest on an
  unverified digest. Everything else the state machine relies on — identity,
  derivation, content verification, allocation, supersession targeting,
  decidability, and expiry direction — holds against a direct runtime INSERT.
- **One functionName rule, on every read, filter and projection.** functionName
  is the only `request_key` input with no column of its own, so a single
  normalization — anything that is not a NON-EMPTY string (absent, null, empty, a
  number, an object) is the `unknown` sentinel, inline channel first then
  `payload_ref.meta` — is applied by `hitl.function_name()` (the fill trigger,
  the backfill AND the postgres list/count filter), by `functionNameOf()` /
  `identityFieldsOf()` (the postgres projection), by the local projection at read
  and by the local v1→v2 conversion. Comparing the RAW payload value in the
  postgres filter while projecting the normalized one meant a migrated row
  carrying `functionName: 5` (or `''`, or no key) reported `unknown` in its
  envelope and then answered to neither `unknown` nor `5` — an actionable
  approval invisible to every query a caller can make, and present on local but
  missing on postgres.
- **Canonical request identity is enforced by the database.** `requests.id` is
  not a free-form label: the fill trigger derives `sha256(workspace_id,
  request_key)` and either RE-KEYS the row onto it (the v1-shaped / legacy-drain
  insert path, old value preserved in `legacy_id`) or REFUSES the insert (a
  writer that supplied its own `request_key`, i.e. the v2 store — an id that
  disagrees with its own key is a bug, not a legacy shape). Because the key it
  derives from is now itself derived, deterministic canonical ids are sufficient
  and no separate `UNIQUE (request_key)` is needed; a second id holding an
  existing `request_key` is refused outright anyway. Without this, inserting the
  same function/action/target under an arbitrary id created a SECOND group that
  the head lookup, the projection and the decision trigger all treated as
  independent — two rows for one request, each able to be authoritative.
- **Every postgres decision runs on the DB clock.** Expiry eligibility is
  evaluated by the database (`clock_timestamp()` in `hitl.request_state` and in
  the decision trigger), so BOTH the durable `expired` decision and the store's
  own prevalidation of a USER decision read `hitl.now_ms()` inside the locked
  transaction, after the group lock — never the caller's `now`. A skewed
  application clock would otherwise write "expired at T" for a T at which the
  request had not yet expired (an audit record contradicting the decision that
  produced it), and — with the app clock ahead of the DB — refuse as expired a
  decision the database considered perfectly decidable. The system-expiry id
  stays deterministic in (workspace, request, generation, version), so concurrent
  sweeps still converge on one row.
- **Migration — local.** The v1→v2 conversion appends v2-kind records *alongside*
  the untouched v1 lines (the ledger is append-only; readers project only the v2
  kinds) and applies the same partition rule and the same preflight refusals. The
  barrier has three parts, and needs all three. (1) **The lock**: the conversion
  holds the `hitl/.lock` namespace lock — the primitive v1 writers already
  respect — EXCLUSIVELY from the marker check through every conversion chunk and
  the DONE marker, so no v1 append can interleave. (2) **The format fence**: the
  lock only covers the conversion's own window, so a shipped v1 writer that
  resolved BEFORE the migration and blocked on the lock would append a v1-format
  record the instant it is released — after which every migration check
  short-circuits on the DONE marker and the v2 projection ignores that record
  forever. The ledger's APPEND PRIMITIVE therefore refuses a v1-format HITL
  record once the marker exists (`local/format-fence.ts`; the marker is written
  before the first chunk, so a half-converted tree is fenced too). (3) **The
  epoch**: every mutation revalidates the marker under its own lock and refuses a
  write from a backend that resolved *before* the conversion completed. The
  conversion is written in BOUNDED CHUNKS under that one lock acquisition — the
  whole history as a single compound record would exceed the ledger's 1 MiB
  per-record limit and make a large-but-valid history unmigratable — and a
  durable `CONVERTING` marker plus deterministic record ids make a re-run a
  replay: a crash between chunks, or between the last chunk and the DONE marker,
  rolls forward and the ledger dedups the re-derived records. Each converted
  version carries its legacy creation time as a store OBSERVATION (out of the
  checksum, so a roll-forward still dedups), so the projection reports when the
  REQUEST was created rather than when the conversion ran — the same timestamp
  the postgres backfill preserves in `created_at`, which is what makes converted
  history auditable and the two backends agree. A `roster ops setup` re-run
  performs the conversion and refreshes the local `meta.json` component versions
  explicitly, so the workspace is capability-correct the moment setup returns.
- **Local pagination is ordered by `(seq, pos)`, never `seq` alone.** A compound
  envelope's children are ONE physical ledger line, so they share a seq; `pos` is
  each child's index within its envelope (0 for a record written alone) and is
  assigned at expansion, never stored. `Cursor.committedPos` carries it, and a
  cursor without it means "the whole seq was consumed" (postgres, whose bigserial
  is unique per row, never sets it). With a scalar seq cursor every sibling but
  the one that ended a page was unreachable — two requests converted in one batch
  paged as one request and an empty second page.
- **HITL pagination is anchored on the GROUP, not on its head.** Both backends
  page over the request group's CREATION position — the lowest ledger seq /
  `hitl.requests.seq` any of its versions holds — never over the current head's,
  which moves on every revision. The watermark keeps its meaning (a group created
  after page one stays out of the traversal), and because the anchor is immutable
  for the life of the group, a request that exists throughout the traversal is
  visited exactly once. Projecting the latest head and THEN applying
  `seq <= watermark` meant revising a request mid-pagination pushed it past the
  watermark and dropped it from the whole listing, while a fresh listing found
  it — the actionable queue silently short by one.
- **Projections and vestigial columns.** `hitl.requests.status` is v1's
  projection column and is now vestigial: v2 derives state from versions ⋈
  decisions (`hitl.request_state` and the pure `deriveRequestState`,
  property-tested equal), and every insert writes the literal `'awaiting'` that
  nothing reads. The sanitized `hitl.request_index` view exposes only
  internally-derived digests, closed enums, numbers, and the DB-owned
  `sanitized_summary` (written at insert from the shared `sanitizeForIndex`,
  re-scrubbed and byte-capped by a BEFORE INSERT trigger) — never the raw target,
  summary, payload, or feedback. Semantic indexing over it stays deferred with
  the #323 follow-up.

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
  not seams. The HITL state machine (#319) is the one contract that grew rather
  than swapped: it adds generation/version identity, the `replaces` and sweep
  verbs, and a version-bearing write outcome on top of the append plumbing
  shipped here.
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
