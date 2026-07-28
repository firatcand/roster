import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  diagnoseRunLedger,
  fillVersionIds,
  PgRunLedgerSource,
  type BlobRepairCandidate,
  type BlobRow,
  type InternalDeclaration,
  type ObjectEntry,
  type ParentEdge,
  type RunLedgerSource,
  type RunLifecycle,
  type VersionIdFiller,
} from '../src/lib/persistence/run-repair.ts';
import { CreateOnlyFileStore } from '../src/lib/persistence/objects.ts';
import { MemoryFileStore } from '../src/lib/persistence/s3-core.ts';
import { sha256Hex } from '../src/lib/persistence/contracts.ts';
import { runOpsMigrations } from '../src/lib/persistence/postgres/migrate.ts';

// #323 section G: the read-only ledger diagnostics + the single explicit
// admin-repair mutation (fill-version-ids). Pure detector logic runs against an
// in-memory fake; the PgRunLedgerSource + fill path is ROSTER_OPS_TEST_ADMIN_URL-
// gated over a real Postgres + a MemoryFileStore standing in for MinIO/S3.

// ---------- in-memory fake (both source + filler) ----------

type FakeData = {
  lifecycles?: RunLifecycle[];
  parents?: ParentEdge[];
  runIds?: string[];
  declarations?: InternalDeclaration[];
  blobs?: BlobRow[];
  objects?: ObjectEntry[];
  bytes?: Record<string, Buffer>;
};

class FakeLedger implements RunLedgerSource, VersionIdFiller {
  blessCalls: Array<{ digest: string; versionId: string }> = [];
  // digests whose declarations are still unverified (re-repairable even with a
  // version present) — the fake's stand-in for the SQL version_state column.
  unverifiedDeclDigests = new Set<string>();
  private readonly d: Required<Omit<FakeData, 'bytes'>> & { bytes: Record<string, Buffer> };

  constructor(data: FakeData) {
    this.d = {
      lifecycles: data.lifecycles ?? [],
      parents: data.parents ?? [],
      runIds: data.runIds ?? [],
      declarations: data.declarations ?? [],
      blobs: data.blobs ?? [],
      objects: data.objects ?? [],
      bytes: data.bytes ?? {},
    };
  }

  async runLifecycles(): Promise<RunLifecycle[]> {
    return this.d.lifecycles;
  }
  async parentEdges(): Promise<ParentEdge[]> {
    return this.d.parents;
  }
  async runIds(): Promise<Set<string>> {
    return new Set(this.d.runIds);
  }
  async internalDeclarations(): Promise<InternalDeclaration[]> {
    return this.d.declarations;
  }
  async blobRows(): Promise<BlobRow[]> {
    return this.d.blobs;
  }
  async objectEntries(): Promise<ObjectEntry[]> {
    return this.d.objects;
  }
  async readObjectBytes(digest: string): Promise<Buffer | null> {
    return this.d.bytes[digest] ?? null;
  }
  async repairableBlobs(): Promise<BlobRepairCandidate[]> {
    return this.d.blobs
      .filter((b) => b.objectVersionId === null || this.unverifiedDeclDigests.has(b.digest))
      .map((b) => ({ digest: b.digest, objectVersionId: b.objectVersionId }));
  }
  async readCandidate(
    digest: string,
    recordedVersionId: string | null,
  ): Promise<{ versionId: string | null; bytes: Buffer } | undefined> {
    const obj = this.d.objects.find((o) => o.digest === digest);
    if (obj === undefined) return undefined;
    const bytes = this.d.bytes[digest];
    if (bytes === undefined) return undefined;
    return { versionId: recordedVersionId ?? obj.versionId, bytes };
  }
  async bless(digest: string, versionId: string): Promise<void> {
    this.blessCalls.push({ digest, versionId });
    this.unverifiedDeclDigests.delete(digest);
  }
}

const A = 'a'.repeat(64);

function kinds(findings: { kind: string }[]): string[] {
  return findings.map((f) => f.kind).sort();
}

// ---------- clean negative ----------

test('diagnose: a consistent ledger yields zero findings', async () => {
  const src = new FakeLedger({
    lifecycles: [{ runId: 'r1', hasStart: true, hasEnd: true }],
    runIds: ['r1'],
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: 'v1' }],
    objects: [{ digest: A, versionId: 'v1' }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(diag.findings, []);
  assert.deepEqual(diag.counts, { runs: 1, declarations: 1, blobs: 1, objects: 1 });
});

// ---------- each detector positive ----------

test('diagnose: declaration referencing a blob with no object', async () => {
  // A declaration whose digest has neither an object NOR a blob row is BOTH
  // missing-bytes and missing-row (finding: the declaration check verified only
  // object existence, so a missing blob row went unreported).
  const src = new FakeLedger({ declarations: [{ id: 'd1', digest: A, versionState: 'verified' }], objects: [], blobs: [] });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['declaration-without-blob', 'declaration-without-blob-row']);
  assert.ok(diag.findings.every((f) => f.ref === A));
});

test('diagnose (finding 7): a declaration + object with NO backing blob row is flagged', async () => {
  // The object bytes exist and the declaration exists, but roster_ops.artifacts
  // has no row — composition cannot resolve the declaration. Before the fix this
  // reported no drift (the declaration check saw the object and the blob-row
  // checks iterate only existing rows).
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    objects: [{ digest: A, versionId: 'v1' }],
    blobs: [],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['declaration-without-blob-row']);
  assert.equal(diag.findings[0]!.ref, A);
});

test('diagnose (round-7 finding 5): a declaration left version_state=unverified whose blob HAS a version id is reported', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'unverified' }],
    blobs: [{ digest: A, objectVersionId: 'v1' }],
    objects: [{ digest: A, versionId: 'v1' }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['declaration-version-unverified']);
  assert.equal(diag.findings[0]!.ref, A);
  assert.match(diag.findings[0]!.detail, /--fill-version-ids/, 'the finding names its repair');
});

test('diagnose (round-7 finding 5): unverified WITHOUT a blob version is only missing-object-version (no double report)', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'unverified' }],
    blobs: [{ digest: A, objectVersionId: null }],
    objects: [{ digest: A, versionId: null }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['missing-object-version']);
});

test('diagnose (round-7 finding 5): a verified declaration over a versioned blob is clean', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: 'v1' }],
    objects: [{ digest: A, versionId: 'v1' }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(diag.findings, []);
});

test('diagnose: object with no declaration is an orphan', async () => {
  const src = new FakeLedger({ objects: [{ digest: A, versionId: 'v1' }], declarations: [], blobs: [] });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['blob-without-declaration']);
});

test('diagnose: object_version_id mismatch between the row and the store', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: 'v-OLD' }],
    objects: [{ digest: A, versionId: 'v-NEW' }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['object-version-mismatch']);
});

test('diagnose: run-end without a run-start', async () => {
  const src = new FakeLedger({
    lifecycles: [{ runId: 'r1', hasStart: false, hasEnd: true }],
    runIds: ['r1'],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['run-end-without-start']);
});

test('diagnose: dangling parent_run_id', async () => {
  const src = new FakeLedger({
    parents: [{ runId: 'child', parentRunId: 'ghost' }],
    runIds: ['child'],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['dangling-parent-run']);
  assert.equal(diag.findings[0]!.ref, 'ghost');
});

test('diagnose: missing object_version_id is reported (report-only)', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: null }],
    objects: [{ digest: A, versionId: 'v1' }],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['missing-object-version']);
});

test('diagnose (finding 15): a blob whose object AND declaration are both absent is flagged', async () => {
  // A blob row with a non-null object_version_id whose object is gone and which
  // has NO declaration — missed before (declaration-without-blob checks only via
  // declarations; orphan only via listed objects).
  const src = new FakeLedger({
    blobs: [{ digest: A, objectVersionId: 'v-recorded' }],
    objects: [],
    declarations: [],
  });
  const diag = await diagnoseRunLedger(src);
  assert.deepEqual(kinds(diag.findings), ['blob-without-object']);
  assert.equal(diag.findings[0]!.ref, A);
});

test('diagnose: deep check catches a digest mismatch (bounded + flagged)', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: 'v1' }],
    objects: [{ digest: A, versionId: 'v1' }],
    bytes: { [A]: Buffer.from('not-matching-the-digest') },
  });
  const shallow = await diagnoseRunLedger(src);
  assert.deepEqual(shallow.findings, [], 'shallow diagnose does not re-hash bytes');
  const deep = await diagnoseRunLedger(src, { deep: true });
  assert.deepEqual(kinds(deep.findings), ['digest-mismatch']);
  assert.equal(deep.deep.performed, true);
  assert.equal(deep.deep.checked, 1);
});

// ---------- read-only proof ----------

test('diagnose: is strictly read-only — never invokes the version-fill mutation', async () => {
  const src = new FakeLedger({
    declarations: [{ id: 'd1', digest: A, versionState: 'verified' }],
    blobs: [{ digest: A, objectVersionId: null }],
    objects: [{ digest: A, versionId: 'v1' }],
    bytes: { [A]: Buffer.from('x') },
  });
  await diagnoseRunLedger(src, { deep: true });
  assert.deepEqual(src.blessCalls, [], 'diagnose must not mutate anything');
});

// ---------- fill-version-ids (pure) ----------

test('fillVersionIds: fills present objects (hash-verified), classifies missing object vs missing version', async () => {
  // Real byte→digest pairs so the hash-verify gate passes for the fillable one.
  const bA = Buffer.from('alpha');
  const dA = sha256Hex(bA);
  const bB = Buffer.from('beta');
  const dB = sha256Hex(bB);
  const dC = 'c'.repeat(64);
  const filler = new FakeLedger({
    blobs: [
      { digest: dA, objectVersionId: null },
      { digest: dB, objectVersionId: null },
      { digest: dC, objectVersionId: null },
    ],
    objects: [
      { digest: dA, versionId: 'v-A' }, // fillable
      { digest: dB, versionId: null }, // present but store has no version id
      // dC absent entirely
    ],
    bytes: { [dA]: bA, [dB]: bB },
  });
  const res = await fillVersionIds(filler);
  assert.deepEqual(res.filled, [{ digest: dA, versionId: 'v-A' }]);
  assert.deepEqual(res.skippedNoVersion, [dB]);
  assert.deepEqual(res.skippedNoObject, [dC]);
  assert.deepEqual(res.skippedDigestMismatch, []);
  assert.deepEqual(filler.blessCalls, [{ digest: dA, versionId: 'v-A' }]);
});

// Finding 9 repro: a candidate version whose BYTES do not hash to the digest is
// NEVER blessed (fail closed). Fails-before: the old fillVersionIds recorded the
// head version id without any hash check.
test('fillVersionIds: a version whose bytes do NOT match the digest is not blessed', async () => {
  const realBytes = Buffer.from('the real payload');
  const digest = sha256Hex(realBytes);
  const wrongBytes = Buffer.from('SOMEONE OVERWROTE THIS');
  const filler = new FakeLedger({
    blobs: [{ digest, objectVersionId: null }],
    objects: [{ digest, versionId: 'v-tampered' }],
    bytes: { [digest]: wrongBytes }, // the store's current version has WRONG bytes
  });
  const res = await fillVersionIds(filler);
  assert.deepEqual(res.filled, [], 'a digest-mismatched version must not be filled');
  assert.deepEqual(res.skippedDigestMismatch, [digest]);
  assert.deepEqual(filler.blessCalls, [], 'bless must never run for mismatched bytes');
});

// Finding 9 repro: a blob whose version is present but whose declarations are
// still unverified (a prior mid-repair failure) is RE-repairable — the next run
// re-attempts it and blesses the declarations. Fails-before: blobsMissingVersion
// only returned null-version blobs, so a half-repaired blob was skipped forever.
test('fillVersionIds: a blob with a version but unverified declarations is re-repairable', async () => {
  const bytes = Buffer.from('half-repaired');
  const digest = sha256Hex(bytes);
  const filler = new FakeLedger({
    blobs: [{ digest, objectVersionId: 'v-existing' }],
    objects: [{ digest, versionId: 'v-existing' }],
    bytes: { [digest]: bytes },
  });
  filler.unverifiedDeclDigests.add(digest); // declarations left unverified by a prior partial failure
  const res = await fillVersionIds(filler);
  assert.deepEqual(res.filled, [{ digest, versionId: 'v-existing' }]);
  assert.deepEqual(filler.blessCalls, [{ digest, versionId: 'v-existing' }], 'the half-repaired blob is re-attempted');
});

// ---------- PG + MemoryFileStore integration (gated) ----------

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const pgOpts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };
const WS = '22222222-2222-4222-8222-222222222222';

async function makeDb(): Promise<{ pool: pg.Pool; close: () => Promise<void> }> {
  const db = `repair_test_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const url = new URL(ADMIN);
  url.pathname = '/' + db;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await runOpsMigrations(pool);
  return {
    pool,
    close: async () => {
      await pool.end().catch(() => {});
      const r = new pg.Client({ connectionString: ADMIN });
      await r.connect();
      try {
        await r.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
        await r.query(`DROP DATABASE IF EXISTS ${db}`);
      } finally {
        await r.end();
      }
    },
  };
}

async function seedBlob(pool: pg.Pool, digest: string, versionId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO roster_ops.artifacts (id, workspace_id, digest, size, meta, object_version_id, created_at)
     VALUES ($1, $2::uuid, $3, 3, $4::jsonb, $5, 100)`,
    [sha256Hex(digest), WS, digest, JSON.stringify({ filename: 'x', contentType: 'text/plain', runId: 'r1' }), versionId],
  );
}

async function seedDeclaration(pool: pg.Pool, digest: string, versionState: string): Promise<void> {
  await pool.query(
    `INSERT INTO roster_ops.artifact_declarations
       (id, workspace_id, run_id, declaring_agent, role, kind, digest, provenance, verified, version_state, created_at)
     VALUES ($1, $2::uuid, 'r1', 'a1', 'produced', 'internal', $3, '{}'::jsonb, false, $4, 100)`,
    [`decl-${digest.slice(0, 8)}`, WS, digest, versionState],
  );
}

async function seedEvent(pool: pg.Pool, runId: string, type: string, parentRunId: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO roster_ops.run_events (id, workspace_id, run_id, dedupe_key, type, payload, source, parent_run_id, created_at)
     VALUES ($1, $2::uuid, $3, $4, $5, '{}'::jsonb, 'cli', $6, 100)`,
    [`ev-${runId}-${type}`, WS, runId, type, type, parentRunId],
  );
}

test('PgRunLedgerSource: diagnose detects real drift; fill-version-ids is the only mutation', pgOpts, async () => {
  const h = await makeDb();
  const store = new CreateOnlyFileStore(new MemoryFileStore());
  try {
    const bytesA = randomBytes(20);
    const digestA = sha256Hex(bytesA);
    const digestOrphan = sha256Hex(randomBytes(20));

    // digestA: object present (with a version), blob row missing its version, declaration present.
    const putA = await store.putIfAbsent({ prefix: 'artifacts', segments: [digestA] }, bytesA);
    assert.ok(putA.objectVersionId, 'MemoryFileStore assigns a version id');
    await seedBlob(h.pool, digestA, null); // missing-object-version
    await seedDeclaration(h.pool, digestA, 'unverified');

    // an orphan object with no declaration/blob row.
    await store.putIfAbsent({ prefix: 'artifacts', segments: [digestOrphan] }, randomBytes(20));

    // run-end without start + a dangling parent.
    await seedEvent(h.pool, 'r-endonly', 'run-end', null);
    await seedEvent(h.pool, 'r-child', 'run-start', 'r-ghost');

    const source = new PgRunLedgerSource({ db: h.pool, workspaceId: WS, objects: store, admin: h.pool });
    const diag = await diagnoseRunLedger(source);
    const found = new Set(diag.findings.map((f) => f.kind));
    assert.ok(found.has('missing-object-version'), 'missing version');
    assert.ok(found.has('blob-without-declaration'), 'orphan object');
    assert.ok(found.has('run-end-without-start'), 'end without start');
    assert.ok(found.has('dangling-parent-run'), 'dangling parent');

    // read-only proof: object_version_id + version_state unchanged after diagnose.
    const beforeVer = (await h.pool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [digestA])).rows[0];
    assert.equal((beforeVer as { object_version_id: string | null }).object_version_id, null);

    // fill-version-ids: the admin mutation fills the version + flips the declaration.
    const res = await fillVersionIds(source);
    assert.deepEqual(res.filled.map((f) => f.digest), [digestA]);
    const afterVer = (await h.pool.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [digestA])).rows[0];
    assert.equal((afterVer as { object_version_id: string }).object_version_id, putA.objectVersionId);
    const declState = (await h.pool.query(`SELECT version_state FROM roster_ops.artifact_declarations WHERE digest = $1`, [digestA])).rows[0];
    assert.equal((declState as { version_state: string }).version_state, 'verified');

    // re-diagnose: the missing-object-version finding is gone.
    const diag2 = await diagnoseRunLedger(source);
    assert.ok(!diag2.findings.some((f) => f.kind === 'missing-object-version'), 'version filled');
    assert.ok(
      !diag2.findings.some((f) => f.kind === 'declaration-version-unverified'),
      'and the declaration is no longer residual-unverified',
    );

    // Round-7 finding 5, over the REAL source: a residual declaration left
    // 'unverified' while its blob DOES record a version is reported (so any
    // leftover from a pre-fix spool or a partial repair is at least diagnosed).
    const bytesR = randomBytes(20);
    const digestR = sha256Hex(bytesR);
    const putR = await store.putIfAbsent({ prefix: 'artifacts', segments: [digestR] }, bytesR);
    await seedBlob(h.pool, digestR, putR.objectVersionId ?? null);
    await seedDeclaration(h.pool, digestR, 'unverified');
    const diag3 = await diagnoseRunLedger(source);
    const residual = diag3.findings.filter((f) => f.kind === 'declaration-version-unverified');
    assert.deepEqual(residual.map((f) => f.ref), [digestR], 'exactly the residual declaration is reported');
  } finally {
    await h.close();
  }
});
