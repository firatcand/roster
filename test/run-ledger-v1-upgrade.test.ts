import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { createLocalBackend } from '../src/lib/persistence/local/stores.ts';
import { ConflictError, computeRecordId, sha256Hex } from '../src/lib/persistence/contracts.ts';
import { declarationId, internalDeclarationParts } from '../src/lib/persistence/artifact-declarations.ts';
import { safeProjectionIdent } from '../src/lib/persistence/sanitize-index.ts';

// Finding: shipped v1 (#318) local records are not upgraded. A v1 run-event
// payload used `type` (not `kind`) and carried no observations; a v1 artifact
// row carried its meta INSIDE the payload and never synthesized a declaration.
// Reading these with the v2 code must not throw AND must surface v2-shaped views.

const WS = '33333333-3333-4333-8333-333333333333';

function withTree(fn: (ledger: LocalLedger, opsRoot: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roster-v1-'));
  const opsRoot = join(dir, '.roster', 'ops');
  const ledger = new LocalLedger({ opsRoot, workspaceId: WS });
  return (async () => {
    try {
      await fn(ledger, opsRoot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('v1 upgrade: reading a v1 local run-event (payload.type, no observations) does NOT throw', async () => {
  await withTree(async (ledger, opsRoot) => {
    // Write a v1-shaped run-event exactly as #318 did: the id derived from the
    // LITERAL kind:'run-event' (the shipped v1 identity scheme — NOT the event
    // kind), payload has `type` + `dedupeKey`, NO `kind`, NO observations.
    const id = computeRecordId(WS, 'runs', { kind: 'run-event', runId: 'r-legacy', dedupeKey: 'start' });
    ledger.append('runs', {
      id,
      kind: 'run-event',
      payload: { runId: 'r-legacy', dedupeKey: 'start', type: 'run-start', data: null },
    });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    const run = await backend.runs.getRun('r-legacy'); // must not TypeError in correlationColumn
    assert.ok(run);
    assert.equal(run.events.length, 1);
    assert.equal(run.events[0]!.kind, 'run-start', 'the v1 `type` maps to `kind`');
    assert.equal(run.events[0]!.source, 'unverified', 'a v1 row has no trust stamp → unverified');
  });
});

test('v1 upgrade (finding 6): a shipped v1 run-start deduplicates against a post-upgrade retry', async () => {
  await withTree(async (ledger, opsRoot) => {
    // A REAL shipped v1 run-start: its id derived from the LITERAL kind:'run-event'
    // (the #318 scheme), payload uses `type`, dedupeKey='start' (the natural key
    // the v2 singleton also produces).
    const v1Id = computeRecordId(WS, 'runs', { kind: 'run-event', runId: 'r-up', dedupeKey: 'start' });
    ledger.append('runs', {
      id: v1Id,
      kind: 'run-event',
      payload: { runId: 'r-up', dedupeKey: 'start', type: 'run-start', data: null },
    });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    // Post-upgrade retry via the v2 CLI path — a plain `run start` for the same run.
    const retry = await backend.runs.appendEvent({ runId: 'r-up', kind: 'run-start', data: null });
    // The v2 write uses a DIFFERENT physical id (kind:'run-start' scheme)…
    assert.notEqual(retry.id, v1Id, 'the v2 retry has a distinct physical id from the v1 record');

    const run = await backend.runs.getRun('r-up');
    assert.ok(run);
    // …but the read collapses the v1 record and its v2 retry into ONE event
    // (shared canonical id) — replay idempotency is preserved across the upgrade.
    assert.equal(run.events.length, 1, 'a v1 run-start + its v2 retry read as ONE event');
    // The trusted v2 retry supersedes the untrusted v1 row.
    assert.equal(run.events[0]!.kind, 'run-start');
    assert.equal(run.events[0]!.source, 'cli', 'the trusted v2 retry supersedes the v1 unverified row');
  });
});

test('v1 upgrade: a v1 local artifact row (meta in payload, no declaration) yields a synthesized legacy declaration', async () => {
  await withTree(async (ledger, opsRoot) => {
    const bytes = Buffer.from('legacy artifact bytes');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'run-legacy' };
    // v1 artifact record: meta INSIDE the payload; no declaration record.
    const id = computeRecordId(WS, 'artifacts', { kind: 'artifact', digest });
    ledger.append('artifacts', { id, kind: 'artifact', payload: { digest, size: bytes.byteLength, meta } });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    const decls = await backend.artifacts.getByRun('run-legacy');
    assert.equal(decls.length, 1, 'a v1 blob with no declaration synthesizes one');
    const d = decls[0]!;
    assert.equal(d.declaringAgent, 'legacy');
    assert.equal(d.role, 'produced');
    assert.equal(d.kind, 'internal');
    assert.equal(d.digest, digest);
    assert.equal(d.versionState, 'unverified');

    // The synthesized id equals the deterministic PG-backfill derivation.
    const expectedId = declarationId(WS, safeProjectionIdent('run-legacy'), 'legacy', 'produced', digest);
    assert.equal(d.id, expectedId, 'deterministic id (matches the PG migration backfill)');
    const byId = await backend.artifacts.getDeclaration(expectedId);
    assert.ok(byId, 'getDeclaration resolves the synthesized declaration');
    assert.equal(byId!.digest, digest);
  });
});

test('v1 upgrade (finding 11): a later run declaring the same digest does NOT drop the legacy blob provenance', async () => {
  await withTree(async (ledger, opsRoot) => {
    const bytes = Buffer.from('shared content bytes');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'old' };
    // v1 blob: producer run 'old', meta INSIDE the payload, no declaration.
    const id = computeRecordId(WS, 'artifacts', { kind: 'artifact', digest });
    ledger.append('artifacts', { id, kind: 'artifact', payload: { digest, size: bytes.byteLength, meta } });

    // Post-upgrade: run 'new' declares the SAME digest — model the declaration
    // record directly (content reuse) so another declaration for D now exists.
    const newParts = internalDeclarationParts(WS, digest, { runId: 'new', declaringAgent: 'writer', role: 'used' }, 'unverified');
    ledger.append('artifacts', {
      id: newParts.id,
      kind: 'artifact-declaration',
      payload: newParts.payload,
      observations: newParts.observations,
    });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });

    // The legacy blob's provenance MUST survive: getByRun('old') still returns the
    // synthesized legacy declaration even though another declaration for D exists.
    const oldDecls = await backend.artifacts.getByRun('old');
    assert.equal(oldDecls.length, 1, "the legacy declaration for run 'old' is not dropped");
    assert.equal(oldDecls[0]!.declaringAgent, 'legacy');
    assert.equal(oldDecls[0]!.digest, digest);
    const expectedLegacyId = declarationId(WS, safeProjectionIdent('old'), 'legacy', 'produced', digest);
    assert.equal(oldDecls[0]!.id, expectedLegacyId, 'matches the PG once-per-blob backfill id');

    // And run 'new' still resolves its own declaration.
    const newDecls = await backend.artifacts.getByRun('new');
    assert.equal(newDecls.length, 1);
    assert.equal(newDecls[0]!.declaringAgent, 'writer');
    assert.equal(newDecls[0]!.role, 'used');
  });
});

test('v1 upgrade (finding 1): a v2 putArtifact of a REAL v1 blob\'s identical bytes does NOT conflict', async () => {
  await withTree(async (ledger, opsRoot) => {
    const bytes = Buffer.from('v1 blob identical bytes');
    const digest = sha256Hex(bytes);
    const meta = { filename: 'old.md', contentType: 'text/markdown', runId: 'run-old' };
    // A REAL shipped v1 blob record: id over {kind:'artifact',digest}, payload
    // {digest,size,meta} (meta INSIDE the payload — the #318 shape). Its checksum
    // covers meta; the v2 content-only payload {digest,size} hashes differently →
    // the SAME id with a DIFFERENT checksum → a ConflictError before the fix.
    const id = computeRecordId(WS, 'artifacts', { kind: 'artifact', digest });
    ledger.append('artifacts', { id, kind: 'artifact', payload: { digest, size: bytes.byteLength, meta } });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    // A NEW run declares IDENTICAL bytes through the v2 putArtifact API.
    const put = await backend.artifacts.putArtifact(
      { filename: 'new.md', contentType: 'text/markdown', runId: 'run-new' },
      bytes,
      { runId: 'run-new', declaringAgent: 'writer', role: 'produced' },
    );
    assert.equal(put.digest, digest);
    assert.equal(put.blobOutcome, 'committed', 'the already-present v1 blob satisfies the digest — no conflict');
    assert.ok(put.declarationId, 'the v2 declaration is added on top of the existing blob');
    // The blob is readable + digest-verified, and there is exactly ONE new run
    // declaration (the blob was deduped by digest, not re-appended).
    const got = await backend.artifacts.getArtifact(digest);
    assert.ok(got);
    assert.deepEqual(got.bytes, bytes);
    const decls = await backend.artifacts.getByRun('run-new');
    assert.equal(decls.length, 1);
    assert.equal(decls[0]!.declaringAgent, 'writer');
  });
});

test('v1 upgrade (finding 8): listRuns counts CANONICAL events — a v1 run-start + v2 retry is ONE event', async () => {
  await withTree(async (ledger, opsRoot) => {
    // A REAL v1 run-start (LITERAL kind:'run-event' id scheme, payload.type).
    const v1Id = computeRecordId(WS, 'runs', { kind: 'run-event', runId: 'r-count', dedupeKey: 'start' });
    ledger.append('runs', {
      id: v1Id,
      kind: 'run-event',
      payload: { runId: 'r-count', dedupeKey: 'start', type: 'run-start', data: null },
    });
    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    await backend.runs.appendEvent({ runId: 'r-count', kind: 'run-start', data: null }); // v2 retry

    // getRun collapses the v1 record + its v2 retry to ONE event…
    const run = await backend.runs.getRun('r-count');
    assert.equal(run!.events.length, 1);
    // …and listRuns now agrees (it counted 2 physical rows — "2 ev" — before).
    const page = await backend.runs.listRuns({});
    const summary = page.items.find((s) => s.runId === 'r-count');
    assert.ok(summary);
    assert.equal(summary.events, 1, 'run list shows 1 canonical event, not 2 physical rows');
  });
});

test('v1 upgrade (round-5 finding 4): a v1 run-start + a v2 replay with a CHANGED stable payload raises ConflictError on getRun', async () => {
  await withTree(async (ledger, opsRoot) => {
    // A REAL v1 run-start storing {phase:'old'} under the LITERAL kind:'run-event' scheme.
    const v1Id = computeRecordId(WS, 'runs', { kind: 'run-event', runId: 'r-conflict', dedupeKey: 'start' });
    ledger.append('runs', {
      id: v1Id,
      kind: 'run-event',
      payload: { runId: 'r-conflict', dedupeKey: 'start', type: 'run-start', data: { phase: 'old' } },
    });
    // A post-upgrade v2 replay of the SAME logical run-start but with DIFFERENT
    // stable data {phase:'new'} — a distinct physical id, the same canonical id.
    const v2Id = computeRecordId(WS, 'runs', { kind: 'run-start', runId: 'r-conflict', dedupeKey: 'start' });
    assert.notEqual(v1Id, v2Id);
    ledger.append('runs', {
      id: v2Id,
      kind: 'run-event',
      payload: { runId: 'r-conflict', kind: 'run-start', dedupeKey: 'start', data: { phase: 'new' }, agent: null, skill: null, trigger: null, parentRunId: null, originTaskId: null },
    });

    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    // getRun must NOT silently return {phase:'new'} — it raises a ConflictError.
    await assert.rejects(() => backend.runs.getRun('r-conflict'), ConflictError);
    // listRuns (the summary-count path) also refuses to silently collapse.
    await assert.rejects(() => backend.runs.listRuns({ runId: 'r-conflict' }), ConflictError);
  });
});

test('v1 upgrade (round-5 finding 4): a v1 run-start + a v2 replay with an IDENTICAL stable payload dedups (no conflict)', async () => {
  await withTree(async (ledger, opsRoot) => {
    const v1Id = computeRecordId(WS, 'runs', { kind: 'run-event', runId: 'r-benign', dedupeKey: 'start' });
    ledger.append('runs', {
      id: v1Id,
      kind: 'run-event',
      payload: { runId: 'r-benign', dedupeKey: 'start', type: 'run-start', data: null },
    });
    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    // The v2 retry carries the SAME stable payload (data:null, no metadata).
    await backend.runs.appendEvent({ runId: 'r-benign', kind: 'run-start', data: null });
    const run = await backend.runs.getRun('r-benign');
    assert.equal(run!.events.length, 1, 'an identical-payload replay dedups to ONE event');
    const page = await backend.runs.listRuns({ runId: 'r-benign' });
    assert.equal(page.items.find((s) => s.runId === 'r-benign')!.events, 1);
  });
});

test('v1 upgrade: a v2 bare-blob put (no meta in payload) is NOT synthesized (parity with post-migration PG)', async () => {
  await withTree(async (_ledger, opsRoot) => {
    const backend = createLocalBackend({ opsRoot, workspaceId: WS });
    const bytes = Buffer.from('v2 bare blob');
    // A v2 bare-blob put (no declaration context) writes a content-only payload.
    await backend.artifacts.putArtifact({ filename: 'x', contentType: 'application/octet-stream', runId: null }, bytes);
    // No declarations — a bare v2 blob is intentional, not legacy.
    const all = await backend.artifacts.getByRun('unknown');
    assert.equal(all.length, 0, 'a v2 bare blob does not get a spurious legacy declaration');
  });
});
