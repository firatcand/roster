# ADR-0003: Brain file system — Neon ledger + S3 object store

**Status:** Accepted
**Date:** 2026-07-08
**Deciders:** Firat (project owner)
**Relates to:** ROS-156 (epic), ROS-157/158/159/160, the roster-brain decision (2026-06-23)

## Context

The brain (a Neon/Postgres append-only knowledge store, ROS-134) needed a way to
hold *files* — a great blog post to refer back to, a deck, meeting-note corpora,
and eventually media — not just structured entities/facts/events and inline
markdown mounts. The driving question: **where do the bytes live, and how does
the brain stay the librarian that can find them again?**

Two shipped in-house patterns informed the choice. Roster's brain is Neon-only.
The athena agent uses **HydraDB + S3** — HydraDB as a managed semantic index over
documents whose bytes live in S3.

## Decision

**Neon stays the brain's librarian and source of truth; S3 becomes the brain's
file system.** Bytes live in an S3-compatible bucket; a new append-only
`brain.files` ledger in Neon records every file event and ties each file to the
brain's existing entity taxonomy.

Concretely:

- **Append-only ledger.** Every `fs put`/`fs rm` is an INSERT into `brain.files`
  (`op` ∈ `put|rm`). Latest-id-wins per `(kind, slug, filename)` defines current
  state; a delete is a **tombstone row**, so history is never erased. The runtime
  DB role stays INSERT+SELECT only.
- **Entity-attached addressing.** `brain fs put --kind <k> --slug <s> <file>`
  derives the S3 key `<prefix>files/<kind>/<slug>/<filename>`. Files hang off the
  same kind/slug taxonomy as entities, so a stored file is reachable through
  everything the brain already exposes.
- **Text is indexed; binaries are pointers.** Text/markdown flows through the
  existing mount chunk+embed pipeline (`mountBytesTx`) and is searchable via
  `brain query`; the `s3://` URI is its `source_path`. Binaries get a
  metadata-only ledger row. (Media transcription is a follow-up, not this epic.)
- **Tombstones live in the view layer.** `current_documents` decides a chunk's
  visibility on `file_head.mount_id = latest.mount_id` — the address head's mount
  must be the shown mount. This makes search, `reindex`, `gc`, and `brain sql`
  all ledger-aware with **zero application changes**, and self-corrects an
  `rm`, an overwrite, a bucket/prefix change, and a non-indexable overwrite.
- **Non-secret config; env-only credentials.** `files.bucket|region|endpoint|
  prefix|force_path_style` live in `brain_meta.config` (never secret); AWS
  credentials come from the environment only. Works with AWS S3, Cloudflare R2,
  Backblaze B2, and MinIO via a custom endpoint + path-style.
- **Conditional writes + per-address serialization.** `put`/`get`/`rm` serialize
  on a per-address advisory lock held across their S3 op; `put` uses conditional
  writes (create-only / ETag CAS); `rm` is two-phase (durable tombstone, then a
  re-checked delete). So the ledger head can never point at bytes that aren't in
  S3, even under concurrency or a crash.
- **Client.** `@aws-sdk/client-s3`, lazy-imported so non-`fs` commands pay
  nothing; `tsdown` externalizes it, so the npm tarball is unchanged.

## Rejected alternatives

- **HydraDB + S3 (the athena pattern).** HydraDB is a managed *recall* service
  with no SQL surface. It cannot host the brain's structured half (`brain sql`,
  agent-created tables, export/import/merge), so adopting it would mean **Neon +
  HydraDB + S3** — three vendors and three credentials per user, not two. Its
  derived index/graph has no documented export path (vendor lock-in on the
  knowledge you paid to build), and its ingestion is asynchronous, which breaks
  the save→immediately-recall loop agents rely on. Fit for athena (recall-only);
  wrong foundation for roster's brain.
- **Bytes in Postgres (`bytea` / large objects).** Bloats Neon storage and the
  backup path, which has no `bytea` cast; large media is untenable.
- **S3-only with a derived `_index.json` (athena's vault shape).** No SQL search
  integration and index CAS contention; loses the "one database you own" story.

## Consequences

- **Backups carry pointers, not bytes.** `brain export`/`import` round-trips the
  `files` ledger rows; the S3 objects are outside the backup. A restore
  reproduces the ledger and needs the bucket to still exist. For byte-level
  durability, enable S3 bucket versioning / replication (operator hardening,
  documented in HOWTO §12 — not code).
- **A new drift surface.** `brain doctor` gains an async `s3-file-drift` check
  (missing object, ETag drift, orphan-after-rm). It is skip-safe: an
  unconfigured brain never fails on it.
- **The `files` ledger is permanent.** `gc` never prunes it (it is the file audit
  log); a tombstoned file's chunks stay retained-but-hidden.
- **Install footprint grows** (~10–20 MB for the AWS SDK); the tarball does not.
- Media transcription (making audio/video searchable) is deliberately deferred.
