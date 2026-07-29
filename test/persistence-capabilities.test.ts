import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_COMPONENT_VERSIONS,
  OPS_COMPONENTS,
  SUPPORTED_COMPONENT_RANGES,
  assertBackendSupported,
  assertComponentSupported,
  assertOperationSupported,
  knownCapabilities,
  localBackendInfo,
  makeBackendInfo,
  requiredCapabilities,
  type BackendInfo,
} from '../src/lib/persistence/capabilities.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import {
  InvalidRecordError,
  VersionSkewError,
  WorkspaceMismatchError,
} from '../src/lib/persistence/contracts.ts';

// #318 stage 3 section H: capability discovery / version negotiation. The
// skew matrix: future roster_ops, future hitl (per-component independence),
// corrupt/missing meta.json, unknown extra capabilities tolerated, and the
// failure-BEFORE-write guarantee.

type Env = { dir: string; opsRoot: string; ws: string };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'roster-caps-'));
  return { dir, opsRoot: join(dir, 'ops'), ws: randomUUID() };
}

function cleanup(env: Env): void {
  rmSync(env.dir, { recursive: true, force: true });
}

function writeMeta(env: Env, componentVersions: Record<string, number>, overrides: Record<string, unknown> = {}): void {
  const treeDir = join(env.opsRoot, env.ws);
  mkdirSync(treeDir, { recursive: true });
  writeFileSync(
    join(treeDir, 'meta.json'),
    JSON.stringify({
      configVersion: 1,
      workspaceId: env.ws,
      producerId: randomUUID(),
      componentVersions,
      ...overrides,
    }),
  );
}

test('backendInfo: shape — backend + per-component version and capabilities', () => {
  const env = makeEnv();
  try {
    new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws }).meta();
    const info = localBackendInfo(env.opsRoot, env.ws);
    // The local backend implements the #323 run ledger unconditionally, so it
    // mints + reports roster_ops/objects at v2 (finding: local mints v1).
    assert.deepEqual(info, {
      backend: 'local',
      components: {
        roster_ops: { version: 2, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint', 'run-ledger'] },
        hitl: { version: 2, capabilities: ['requests', 'decisions', 'state-machine'] },
        objects: { version: 2, capabilities: ['content-addressed', 'create-only', 'version-id', 'list-prefix'] },
      },
    });
    assert.doesNotThrow(() => assertBackendSupported(info));
    // The run-ledger operation gates pass on a local workspace.
    assert.doesNotThrow(() => assertOperationSupported(info, 'runs.appendEvent'));
    assert.doesNotThrow(() => assertOperationSupported(info, 'artifacts.getByRun'));
  } finally {
    cleanup(env);
  }
});

test('backendInfo: a tree that does not exist yet reports the CLI baseline without minting anything', () => {
  const env = makeEnv();
  try {
    const info = localBackendInfo(env.opsRoot, env.ws);
    for (const component of OPS_COMPONENTS) {
      assert.equal(info.components[component].version, CURRENT_COMPONENT_VERSIONS[component]);
    }
    assert.equal(existsSync(join(env.opsRoot, env.ws)), false);
  } finally {
    cleanup(env);
  }
});

test('skew: future roster_ops version refuses roster_ops operations with an actionable upgrade error — hitl unaffected', () => {
  const env = makeEnv();
  try {
    writeMeta(env, { roster_ops: 99, hitl: 2, objects: 1 });
    const info = localBackendInfo(env.opsRoot, env.ws);
    assert.equal(info.components.roster_ops.version, 99);
    assert.deepEqual(info.components.roster_ops.capabilities, []);
    assert.throws(
      () => assertOperationSupported(info, 'runs.appendEvent'),
      (err: unknown) =>
        err instanceof VersionSkewError &&
        /roster_ops/.test((err as Error).message) &&
        /version 99/.test((err as Error).message) &&
        /upgrade the CLI/.test((err as Error).message),
    );
    // components negotiate independently
    assert.doesNotThrow(() => assertOperationSupported(info, 'hitl.createRequest'));
    assert.throws(() => assertBackendSupported(info), VersionSkewError);
  } finally {
    cleanup(env);
  }
});

test('skew: future hitl version refuses hitl operations while runs operations proceed', () => {
  const env = makeEnv();
  try {
    // hitl 3 is beyond the supported range (#319 raised the ceiling to 2).
    writeMeta(env, { roster_ops: 1, hitl: 3, objects: 1 });
    const info = localBackendInfo(env.opsRoot, env.ws);
    assert.throws(() => assertOperationSupported(info, 'hitl.appendDecision'), VersionSkewError);
    assert.throws(() => assertOperationSupported(info, 'hitl.createRequest'), VersionSkewError);
    assert.doesNotThrow(() => assertOperationSupported(info, 'runs.appendEvent'));
    assert.doesNotThrow(() => assertOperationSupported(info, 'outbox.drain'));
  } finally {
    cleanup(env);
  }
});

test('skew: the gate fires BEFORE any write — a refused operation leaves the tree untouched', () => {
  const env = makeEnv();
  try {
    writeMeta(env, { roster_ops: 99, hitl: 99, objects: 99 });
    const before = readdirSync(join(env.opsRoot, env.ws)).sort();
    const info = localBackendInfo(env.opsRoot, env.ws);
    for (const op of ['runs.appendEvent', 'hitl.createRequest', 'artifacts.putArtifact', 'outbox.enqueue'] as const) {
      assert.throws(() => assertOperationSupported(info, op), VersionSkewError);
    }
    // no namespace dir, no segment, no meta rewrite: the refusal wrote nothing
    assert.deepEqual(readdirSync(join(env.opsRoot, env.ws)).sort(), before);
    assert.deepEqual(before, ['meta.json']);
  } finally {
    cleanup(env);
  }
});

test('skew: below-range component version points at backend migration, not CLI upgrade', () => {
  const info: BackendInfo = {
    backend: 'postgres-s3',
    components: {
      roster_ops: { version: 0, capabilities: [] },
      hitl: { version: 2, capabilities: ['requests', 'decisions', 'state-machine'] },
      objects: { version: 1, capabilities: ['content-addressed', 'create-only'] },
    },
  };
  assert.throws(
    () => assertComponentSupported(info, 'roster_ops'),
    (err: unknown) =>
      err instanceof VersionSkewError && /requires at least 1/.test((err as Error).message) && /roster ops setup/.test((err as Error).message),
  );
});

test('meta: corrupt meta.json refuses loudly instead of guessing versions', () => {
  const env = makeEnv();
  try {
    const treeDir = join(env.opsRoot, env.ws);
    mkdirSync(treeDir, { recursive: true });
    writeFileSync(join(treeDir, 'meta.json'), 'not json {');
    assert.throws(() => localBackendInfo(env.opsRoot, env.ws), InvalidRecordError);
    writeFileSync(join(treeDir, 'meta.json'), JSON.stringify({ workspaceId: env.ws }));
    assert.throws(() => localBackendInfo(env.opsRoot, env.ws), InvalidRecordError);
  } finally {
    cleanup(env);
  }
});

test('meta: a foreign workspace id in meta.json is a WorkspaceMismatchError', () => {
  const env = makeEnv();
  try {
    writeMeta(env, { roster_ops: 1, hitl: 1, objects: 1 }, { workspaceId: randomUUID() });
    assert.throws(() => localBackendInfo(env.opsRoot, env.ws), WorkspaceMismatchError);
  } finally {
    cleanup(env);
  }
});

test('meta: a component the meta predates defaults to version 1; non-integer versions refuse', () => {
  const env = makeEnv();
  try {
    writeMeta(env, { hitl: 1, roster_ops: 1 }); // no 'objects' key (older tree)
    const info = localBackendInfo(env.opsRoot, env.ws);
    // A missing/older component is clamped UP to the local code floor (the local
    // backend implements v2 unconditionally — finding: local mints v1).
    assert.equal(info.components.objects.version, 2);
    assert.equal(info.components.roster_ops.version, 2);
    assert.doesNotThrow(() => assertBackendSupported(info));
    writeMeta(env, { hitl: 1, roster_ops: 1.5, objects: 1 });
    assert.throws(() => localBackendInfo(env.opsRoot, env.ws), InvalidRecordError);
  } finally {
    cleanup(env);
  }
});

test('capabilities: unknown EXTRA capabilities are ignored (forward-compat); missing REQUIRED ones refuse by name', () => {
  const extra = makeBackendInfo('postgres-s3', {
    roster_ops: { version: 2, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint', 'run-ledger', 'x-future-frobnicate'] },
    hitl: { version: 2, capabilities: ['requests', 'decisions', 'state-machine', 'x-batch-decide'] },
    objects: { version: 2, capabilities: ['content-addressed', 'create-only', 'version-id', 'list-prefix', 'x-cold-storage'] },
  });
  assert.doesNotThrow(() => assertOperationSupported(extra, 'hitl.appendDecision'));
  assert.doesNotThrow(() => assertOperationSupported(extra, 'runs.appendEvent'));

  const missing = makeBackendInfo('postgres-s3', {
    roster_ops: { version: 1 },
    hitl: { version: 2, capabilities: ['requests', 'state-machine'] },
    objects: { version: 1 },
  });
  assert.throws(
    () => assertOperationSupported(missing, 'hitl.appendDecision'),
    (err: unknown) =>
      err instanceof VersionSkewError && /'decisions'/.test((err as Error).message) && /hitl/.test((err as Error).message),
  );
  assert.doesNotThrow(() => assertOperationSupported(missing, 'hitl.createRequest'));
});

test('capabilities: makeBackendInfo derives known capabilities by version and reports none for unknown versions', () => {
  const info = makeBackendInfo('local', {
    roster_ops: { version: 1 },
    hitl: { version: 7 },
    objects: { version: 1 },
  });
  assert.deepEqual(info.components.roster_ops.capabilities, knownCapabilities('roster_ops', 1));
  assert.deepEqual(info.components.hitl.capabilities, []);
  assert.throws(() => makeBackendInfo('local', { roster_ops: { version: 0 }, hitl: { version: 1 }, objects: { version: 1 } }), InvalidRecordError);
});

test('registry: supported ranges and operation requirements are self-consistent at the current versions', () => {
  for (const component of OPS_COMPONENTS) {
    const range = SUPPORTED_COMPONENT_RANGES[component];
    const current = CURRENT_COMPONENT_VERSIONS[component];
    assert.ok(range.min <= current && current <= range.max);
    assert.ok(knownCapabilities(component, current).length > 0);
  }
  // every declared requirement is satisfiable by the current baseline
  const baseline = makeBackendInfo('local', {
    roster_ops: { version: CURRENT_COMPONENT_VERSIONS.roster_ops },
    hitl: { version: CURRENT_COMPONENT_VERSIONS.hitl },
    objects: { version: CURRENT_COMPONENT_VERSIONS.objects },
  });
  for (const op of [
    'hitl.createRequest',
    'hitl.listRequests',
    'hitl.appendDecision',
    'hitl.count',
    'runs.appendEvent',
    'runs.listRuns',
    'runs.count',
    'artifacts.putArtifact',
    'artifacts.getArtifact',
    'outbox.enqueue',
    'outbox.drain',
  ] as const) {
    assert.doesNotThrow(() => assertOperationSupported(baseline, op));
    assert.ok(Object.keys(requiredCapabilities(op)).length > 0);
  }
});

test('input guards: a non-UUID workspace id refuses before touching the filesystem', () => {
  const env = makeEnv();
  try {
    assert.throws(() => localBackendInfo(env.opsRoot, 'not-a-uuid'), InvalidRecordError);
    assert.equal(existsSync(env.opsRoot), false);
  } finally {
    cleanup(env);
  }
});

test('meta: config version in meta.json is reported meta-first (read-only) — reading twice never mutates the file', () => {
  const env = makeEnv();
  try {
    writeMeta(env, { roster_ops: 1, hitl: 1, objects: 1 });
    const path = join(env.opsRoot, env.ws, 'meta.json');
    const before = readFileSync(path, 'utf8');
    localBackendInfo(env.opsRoot, env.ws);
    localBackendInfo(env.opsRoot, env.ws);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    cleanup(env);
  }
});

// ── finding: capability gates authorize v2 SQL against a v1 backend ──────────

test('finding 8: a v1 roster_ops backend refuses the run-ledger operations with VersionSkewError (not a SQL error)', () => {
  // A postgres backend still at #318 v1: base caps, NO run-ledger. Its run-event
  // + declaration SQL needs v2 columns/tables, so the gate must refuse BEFORE the
  // query with an actionable skew error rather than letting a missing-column /
  // missing-relation SQL error escape.
  const v1 = makeBackendInfo('postgres-s3', {
    roster_ops: { version: 1, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint'] },
    hitl: { version: 1, capabilities: ['requests', 'decisions'] },
    objects: { version: 1, capabilities: ['content-addressed', 'create-only'] },
  });
  for (const op of [
    'runs.appendEvent',
    'runs.getRun',
    'runs.listRuns',
    // putArtifact writes object_version_id (v2) + optionally the v2 declaration
    // table, so it too is gated on run-ledger (finding 3): declare-artifact must
    // refuse on a v1 backend BEFORE any object upload, not after partial persist.
    'artifacts.putArtifact',
    'artifacts.putExternal',
    'artifacts.getByRun',
    'artifacts.getDeclaration',
  ] as const) {
    assert.throws(
      () => assertOperationSupported(v1, op),
      (err: unknown) => err instanceof VersionSkewError && /run-ledger|version-id/.test((err as Error).message),
      `${op} must refuse on a v1 backend`,
    );
  }
  // a bare-blob GET remains available on v1...
  assert.doesNotThrow(() => assertOperationSupported(v1, 'artifacts.getArtifact'));
  // ...but #319 moved EVERY hitl verb behind the v2 `state-machine` capability,
  // so a v1 hitl schema now refuses with the same actionable skew error rather
  // than running generation/version SQL against columns that do not exist.
  assert.throws(
    () => assertOperationSupported(v1, 'hitl.createRequest'),
    (err: unknown) => err instanceof VersionSkewError && /state-machine/.test((err as Error).message),
  );
});

test('finding 8: a local tree minted at v1 is upgraded to v2 on next access (meta rewrite) so run-ledger ops pass', () => {
  const env = makeEnv();
  try {
    // Simulate a #318 tree: meta.json records roster_ops v1.
    writeMeta(env, { roster_ops: 1, hitl: 1, objects: 1 });
    // localBackendInfo clamps up (the code IS v2).
    const info = localBackendInfo(env.opsRoot, env.ws);
    assert.equal(info.components.roster_ops.version, 2, 'v1 tree reports v2 (code floor)');
    assert.doesNotThrow(() => assertOperationSupported(info, 'runs.appendEvent'));

    // ledger.meta() rewrites the stored meta.json to v2 (the local "migration").
    new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws }).meta();
    const raw = JSON.parse(readFileSync(join(env.opsRoot, env.ws, 'meta.json'), 'utf8')) as {
      componentVersions: Record<string, number>;
    };
    assert.equal(raw.componentVersions.roster_ops, 2, 'stored meta.json upgraded to v2');
    assert.equal(raw.componentVersions.objects, 2);
  } finally {
    cleanup(env);
  }
});
