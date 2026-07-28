import { InvalidRecordError, sha256Hex } from './contracts.ts';
import type { PgQueryable } from './postgres/binding.ts';
import type { CreateOnlyObjectStore } from './objects.ts';

// Run + artifact ledger reliability/repair (#323 section G + Rev4 should-fix).
// diagnoseRunLedger is STRICTLY read-only — it discovers drift and never writes.
// The ONLY mutation is fillVersionIds, driven by an explicit admin verb (`roster
// run repair --fill-version-ids`), which is the SOLE updater of
// object_version_id / version_state (the runtime role holds no UPDATE grant).
// Both operate over a portable RunLedgerSource so the pure detector logic is
// tested against an in-memory fake AND the real Postgres/S3 pair.

const DIGEST_RE = /^[0-9a-f]{64}$/;

export type LedgerFindingKind =
  | 'declaration-without-blob'
  | 'declaration-without-blob-row'
  | 'blob-without-declaration'
  | 'blob-without-object'
  | 'digest-mismatch'
  | 'object-version-mismatch'
  | 'run-end-without-start'
  | 'dangling-parent-run'
  | 'missing-object-version'
  | 'declaration-version-unverified';

export type LedgerFinding = {
  kind: LedgerFindingKind;
  // The primary subject (digest / runId) the finding is about.
  ref: string;
  detail: string;
};

export type RunLifecycle = { runId: string; hasStart: boolean; hasEnd: boolean };
export type ParentEdge = { runId: string; parentRunId: string };
export type BlobRow = { digest: string; objectVersionId: string | null };
export type ObjectEntry = { digest: string; versionId: string | null };
// versionState mirrors the stored artifact_declarations.version_state column:
// 'verified' once the declaration is pinned to the blob's immutable object
// version, 'unverified' until then (NULL only for pre-column rows).
export type InternalDeclaration = { id: string; digest: string; versionState: string | null };

// The read-only surface the diagnostics fold over. A PG implementation runs
// SELECTs on the runtime pool + listPrefix/get on the ADMIN object store; a fake
// backs the hermetic detector tests.
export interface RunLedgerSource {
  runLifecycles(): Promise<RunLifecycle[]>;
  parentEdges(): Promise<ParentEdge[]>;
  runIds(): Promise<Set<string>>;
  internalDeclarations(): Promise<InternalDeclaration[]>;
  blobRows(): Promise<BlobRow[]>;
  // (key, versionId) pairs from the object store's artifacts/ prefix — via the
  // list-capable admin/read resolver (runtime IAM has no bucket-wide list).
  objectEntries(): Promise<ObjectEntry[]>;
  // Deep check: re-read an object's bytes to recompute its digest. Optional —
  // absent (or returning null) skips the bounded digest re-verification.
  readObjectBytes?(digest: string): Promise<Buffer | null>;
}

export type DiagnoseOptions = {
  // Re-hash object bytes to catch a digest mismatch (bounded by deepLimit).
  deep?: boolean;
  deepLimit?: number;
};

export type RunLedgerDiagnosis = {
  findings: LedgerFinding[];
  counts: {
    runs: number;
    declarations: number;
    blobs: number;
    objects: number;
  };
  deep: { performed: boolean; checked: number; limited: boolean };
};

const DEFAULT_DEEP_LIMIT = 256;

export async function diagnoseRunLedger(
  source: RunLedgerSource,
  options: DiagnoseOptions = {},
): Promise<RunLedgerDiagnosis> {
  const [lifecycles, parents, runIds, declarations, blobRows, objects] = await Promise.all([
    source.runLifecycles(),
    source.parentEdges(),
    source.runIds(),
    source.internalDeclarations(),
    source.blobRows(),
    source.objectEntries(),
  ]);

  const findings: LedgerFinding[] = [];
  const objectByDigest = new Map<string, ObjectEntry>();
  for (const o of objects) objectByDigest.set(o.digest, o);
  const declaredDigests = new Set(declarations.map((d) => d.digest));
  const blobRowDigests = new Set(blobRows.map((b) => b.digest));

  // run-end without a run-start.
  for (const lc of lifecycles) {
    if (lc.hasEnd && !lc.hasStart) {
      findings.push({
        kind: 'run-end-without-start',
        ref: lc.runId,
        detail: `run '${lc.runId}' has a run-end event but no run-start`,
      });
    }
  }

  // dangling parent_run_id (references a run with no events).
  const seenDangling = new Set<string>();
  for (const edge of parents) {
    if (!runIds.has(edge.parentRunId) && !seenDangling.has(edge.parentRunId)) {
      seenDangling.add(edge.parentRunId);
      findings.push({
        kind: 'dangling-parent-run',
        ref: edge.parentRunId,
        detail: `run '${edge.runId}' names parent_run_id '${edge.parentRunId}' which has no events`,
      });
    }
  }

  // declaration referencing a blob whose bytes are missing from the object store.
  for (const d of declarations) {
    if (!objectByDigest.has(d.digest)) {
      findings.push({
        kind: 'declaration-without-blob',
        ref: d.digest,
        detail: `declaration ${d.id} references digest ${d.digest} but no object exists at artifacts/${d.digest}`,
      });
    }
    // declaration referencing a digest with NO backing artifacts blob ROW —
    // composition cannot resolve the declaration to a blob record even when the
    // object bytes exist (finding: the declaration check verified only S3 object
    // existence; a declaration + object without an artifacts row went unreported).
    if (!blobRowDigests.has(d.digest)) {
      findings.push({
        kind: 'declaration-without-blob-row',
        ref: d.digest,
        detail: `declaration ${d.id} references digest ${d.digest} but roster_ops.artifacts has no blob row for it`,
      });
    }
  }

  // A declaration still 'unverified' whose blob row DOES record an immutable
  // object version (round-7 finding 5). Drain-time derivation converges the
  // normal offline case, so anything left here is residue — a pre-fix spool, a
  // legacy backfill, or a partially-applied repair. Report it so it is visible
  // and fixable (`roster run repair --fill-version-ids`) instead of silently
  // sitting unverified forever. A declaration whose blob has NO version is
  // already covered by missing-object-version, so it is not double-reported.
  const blobVersionByDigest = new Map(blobRows.map((b) => [b.digest, b.objectVersionId]));
  for (const d of declarations) {
    if (d.versionState !== 'unverified') continue;
    const version = blobVersionByDigest.get(d.digest);
    if (version === undefined || version === null) continue;
    findings.push({
      kind: 'declaration-version-unverified',
      ref: d.digest,
      detail: `declaration ${d.id} is still version_state='unverified' although its blob records object version ${version} (repair with --fill-version-ids)`,
    });
  }

  // blob object with no internal declaration (orphaned bytes).
  for (const o of objects) {
    if (!declaredDigests.has(o.digest)) {
      findings.push({
        kind: 'blob-without-declaration',
        ref: o.digest,
        detail: `object artifacts/${o.digest} has no artifact_declaration referencing it`,
      });
    }
  }

  // stranded blob (object AND declaration both absent) + version drift + missing
  // legacy version. Iterating blob rows catches a blob whose object is gone
  // regardless of declarations (finding: a blob row with a non-null
  // object_version_id whose object is missing and which has NO declaration was
  // missed — declaration-without-blob checks only via declarations, orphan only
  // via listed objects). This is checked FIRST so a stranded blob is reported as
  // a missing OBJECT, not merely a missing version.
  for (const b of blobRows) {
    const obj = objectByDigest.get(b.digest);
    if (obj === undefined) {
      findings.push({
        kind: 'blob-without-object',
        ref: b.digest,
        detail: `artifacts row for ${b.digest} references bytes that are absent from the object store (no object at artifacts/${b.digest})`,
      });
      continue;
    }
    if (b.objectVersionId === null) {
      findings.push({
        kind: 'missing-object-version',
        ref: b.digest,
        detail: `artifacts row for ${b.digest} has no object_version_id (repair with --fill-version-ids)`,
      });
      continue;
    }
    if (obj.versionId !== null && obj.versionId !== b.objectVersionId) {
      findings.push({
        kind: 'object-version-mismatch',
        ref: b.digest,
        detail: `artifacts row records object_version_id ${b.objectVersionId} but the store's current version is ${obj.versionId}`,
      });
    }
  }

  // deep digest re-verification (bounded).
  let deepChecked = 0;
  let deepLimited = false;
  const wantsDeep = options.deep === true && typeof source.readObjectBytes === 'function';
  if (wantsDeep) {
    const limit = options.deepLimit ?? DEFAULT_DEEP_LIMIT;
    for (const o of objects) {
      if (deepChecked >= limit) {
        deepLimited = true;
        break;
      }
      deepChecked += 1;
      const bytes = await source.readObjectBytes!(o.digest);
      if (bytes !== null && sha256Hex(bytes) !== o.digest) {
        findings.push({
          kind: 'digest-mismatch',
          ref: o.digest,
          detail: `object artifacts/${o.digest} bytes hash to ${sha256Hex(bytes)}, not its key digest`,
        });
      }
    }
  }

  return {
    findings,
    counts: {
      runs: runIds.size,
      declarations: declarations.length,
      blobs: blobRows.length,
      objects: objects.length,
    },
    deep: { performed: wantsDeep, checked: deepChecked, limited: deepLimited },
  };
}

// ---------- fill-version-ids: the single explicit admin mutation ----------

export type BlobRepairCandidate = { digest: string; objectVersionId: string | null };

export interface VersionIdFiller {
  // Blobs needing repair: object_version_id IS NULL, OR an internal declaration
  // referencing the digest is still version_state='unverified' (re-repairable —
  // finding: a mid-repair failure must leave a state a later run re-attempts).
  repairableBlobs(): Promise<BlobRepairCandidate[]>;
  // Read the candidate version's BYTES so they can be hash-verified before the
  // version is blessed (finding: repair must not bless wrong bytes). If a
  // version is already recorded, that EXACT immutable version is read; otherwise
  // the store's current version. undefined = the object is absent.
  readCandidate(digest: string, recordedVersionId: string | null): Promise<{ versionId: string | null; bytes: Buffer } | undefined>;
  // ONE transaction: set artifacts.object_version_id (when still null) AND flip
  // the internal declarations' version_state to 'verified' — a partial failure
  // rolls back BOTH, never leaving declarations permanently unverified (admin
  // creds only — the SOLE updater; the runtime holds no UPDATE grant).
  bless(digest: string, versionId: string): Promise<void>;
}

export type FillVersionResult = {
  filled: Array<{ digest: string; versionId: string }>;
  skippedNoObject: string[];
  skippedNoVersion: string[];
  // Candidate bytes did not hash to the digest — NEVER blessed (fail closed).
  skippedDigestMismatch: string[];
};

export async function fillVersionIds(filler: VersionIdFiller): Promise<FillVersionResult> {
  const out: FillVersionResult = { filled: [], skippedNoObject: [], skippedNoVersion: [], skippedDigestMismatch: [] };
  for (const blob of await filler.repairableBlobs()) {
    const cand = await filler.readCandidate(blob.digest, blob.objectVersionId);
    if (cand === undefined) {
      out.skippedNoObject.push(blob.digest);
      continue;
    }
    if (cand.versionId === null) {
      out.skippedNoVersion.push(blob.digest);
      continue;
    }
    // Hash-verify the candidate bytes BEFORE blessing — a version whose bytes do
    // not match the digest is never recorded as the artifact's immutable version.
    if (sha256Hex(cand.bytes) !== blob.digest) {
      out.skippedDigestMismatch.push(blob.digest);
      continue;
    }
    await filler.bless(blob.digest, cand.versionId);
    out.filled.push({ digest: blob.digest, versionId: cand.versionId });
  }
  return out;
}

// ---------- Postgres/S3 implementation ----------

function digestFromKey(key: string): string | null {
  const m = /^artifacts\/([0-9a-f]{64})$/.exec(key);
  return m === null ? m : m[1]!;
}

// Reads run over the given queryable (the runtime pool's SELECT grant suffices);
// object enumeration runs over the ADMIN/read object store (listPrefix); the
// UPDATE runs over the admin queryable (object_version_id/version_state are
// never runtime-mutable). Same class implements the read source + the filler.
export class PgRunLedgerSource implements RunLedgerSource, VersionIdFiller {
  private readonly db: PgQueryable;
  private readonly workspaceId: string;
  private readonly objects: CreateOnlyObjectStore;
  private readonly admin: PgQueryable;

  constructor(deps: { db: PgQueryable; workspaceId: string; objects: CreateOnlyObjectStore; admin: PgQueryable }) {
    this.db = deps.db;
    this.workspaceId = deps.workspaceId;
    this.objects = deps.objects;
    this.admin = deps.admin;
  }

  async runLifecycles(): Promise<RunLifecycle[]> {
    const res = await this.db.query(
      `SELECT run_id,
              bool_or(type = 'run-start') AS has_start,
              bool_or(type = 'run-end')   AS has_end
         FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid
        GROUP BY run_id`,
      [this.workspaceId],
    );
    return (res.rows as { run_id: string; has_start: boolean; has_end: boolean }[]).map((r) => ({
      runId: r.run_id,
      hasStart: r.has_start === true,
      hasEnd: r.has_end === true,
    }));
  }

  async parentEdges(): Promise<ParentEdge[]> {
    const res = await this.db.query(
      `SELECT DISTINCT run_id, parent_run_id
         FROM roster_ops.run_events
        WHERE workspace_id = $1::uuid AND parent_run_id IS NOT NULL`,
      [this.workspaceId],
    );
    return (res.rows as { run_id: string; parent_run_id: string }[]).map((r) => ({
      runId: r.run_id,
      parentRunId: r.parent_run_id,
    }));
  }

  async runIds(): Promise<Set<string>> {
    const res = await this.db.query(
      `SELECT DISTINCT run_id FROM roster_ops.run_events WHERE workspace_id = $1::uuid`,
      [this.workspaceId],
    );
    return new Set((res.rows as { run_id: string }[]).map((r) => r.run_id));
  }

  async internalDeclarations(): Promise<InternalDeclaration[]> {
    const res = await this.db.query(
      `SELECT id, digest, version_state FROM roster_ops.artifact_declarations
        WHERE workspace_id = $1::uuid AND kind = 'internal' AND digest IS NOT NULL`,
      [this.workspaceId],
    );
    return (res.rows as { id: string; digest: string; version_state: string | null }[]).map((r) => ({
      id: r.id,
      digest: r.digest,
      versionState: r.version_state ?? null,
    }));
  }

  async blobRows(): Promise<BlobRow[]> {
    const res = await this.db.query(
      `SELECT digest, object_version_id FROM roster_ops.artifacts WHERE workspace_id = $1::uuid`,
      [this.workspaceId],
    );
    return (res.rows as { digest: string; object_version_id: string | null }[]).map((r) => ({
      digest: r.digest,
      objectVersionId: r.object_version_id ?? null,
    }));
  }

  async objectEntries(): Promise<ObjectEntry[]> {
    const out: ObjectEntry[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.objects.listPrefix('artifacts', cursor);
      for (const entry of page.items) {
        const digest = digestFromKey(entry.key);
        if (digest !== null) out.push({ digest, versionId: entry.versionId });
      }
      cursor = page.cursor;
    } while (cursor !== null);
    return out;
  }

  async readObjectBytes(digest: string): Promise<Buffer | null> {
    const res = await this.objects.get({ prefix: 'artifacts', segments: [digest] });
    return res === null ? null : res.body;
  }

  async repairableBlobs(): Promise<BlobRepairCandidate[]> {
    // A blob is repairable when its version is missing OR any internal
    // declaration referencing it is still unverified — so a mid-repair failure
    // (blob updated, declarations not) is re-attempted by a later run.
    const res = await this.db.query(
      `SELECT a.digest, a.object_version_id
         FROM roster_ops.artifacts a
        WHERE a.workspace_id = $1::uuid
          AND (a.object_version_id IS NULL
            OR EXISTS (
              SELECT 1 FROM roster_ops.artifact_declarations d
               WHERE d.workspace_id = a.workspace_id AND d.digest = a.digest
                 AND d.kind = 'internal' AND d.version_state = 'unverified'))`,
      [this.workspaceId],
    );
    return (res.rows as { digest: string; object_version_id: string | null }[]).map((r) => ({
      digest: r.digest,
      objectVersionId: r.object_version_id ?? null,
    }));
  }

  async readCandidate(
    digest: string,
    recordedVersionId: string | null,
  ): Promise<{ versionId: string | null; bytes: Buffer } | undefined> {
    if (!DIGEST_RE.test(digest)) return undefined;
    // Read the EXACT recorded version when one exists (re-repair path), else the
    // store's current version — and return its bytes for hash verification.
    const obj = await this.objects.get({ prefix: 'artifacts', segments: [digest] }, recordedVersionId);
    if (obj === null) return undefined;
    return { versionId: recordedVersionId ?? obj.objectVersionId, bytes: obj.body };
  }

  async bless(digest: string, versionId: string): Promise<void> {
    // Both updates in ONE statement (data-modifying CTEs) — a single SQL
    // statement is atomic, so the blob version + the declaration verification
    // commit or roll back TOGETHER, never leaving declarations permanently
    // unverified (finding: non-atomic repair). Using one statement also stays
    // correct over a connection POOL (a manual BEGIN/COMMIT would land on
    // different pooled connections and NOT be a transaction). The trailing SELECT
    // returns the TOTAL rows changed across BOTH updates — positive confirmation
    // that this database actually held the blob/declarations (finding: bless
    // ignored zero affected rows, so a swapped admin URL — or a blob absent from
    // the intended DB — was reported as 'filled' while nothing changed).
    const res = await this.admin.query(
      `WITH blob AS (
         UPDATE roster_ops.artifacts SET object_version_id = $3
          WHERE workspace_id = $1::uuid AND digest = $2 AND object_version_id IS NULL
          RETURNING 1
       ), decls AS (
         UPDATE roster_ops.artifact_declarations d SET version_state = 'verified'
          WHERE d.workspace_id = $1::uuid AND d.digest = $2
            AND d.kind = 'internal' AND d.version_state = 'unverified'
          RETURNING 1
       )
       SELECT (SELECT count(*) FROM blob) + (SELECT count(*) FROM decls) AS affected`,
      [this.workspaceId, digest, versionId],
    );
    const affected = Number((res.rows[0] as { affected: string | number } | undefined)?.affected ?? 0);
    if (affected === 0) {
      throw new InvalidRecordError(
        `repair bless changed 0 rows for digest ${digest} — the blob row / declarations are absent (or already filled) on this database; ` +
          `refusing to report a false success (check the admin URL points at the configured workspace's database)`,
      );
    }
  }
}
