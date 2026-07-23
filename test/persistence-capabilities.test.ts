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
    assert.deepEqual(info, {
      backend: 'local',
      components: {
        roster_ops: { version: 1, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint'] },
        hitl: { version: 1, capabilities: ['requests', 'decisions'] },
        objects: { version: 1, capabilities: ['content-addressed', 'create-only'] },
      },
    });
    assert.doesNotThrow(() => assertBackendSupported(info));
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
    writeMeta(env, { roster_ops: 99, hitl: 1, objects: 1 });
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
    writeMeta(env, { roster_ops: 1, hitl: 2, objects: 1 });
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
      hitl: { version: 1, capabilities: ['requests', 'decisions'] },
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
    assert.equal(info.components.objects.version, 1);
    assert.doesNotThrow(() => assertBackendSupported(info));
    writeMeta(env, { hitl: 1, roster_ops: 1.5, objects: 1 });
    assert.throws(() => localBackendInfo(env.opsRoot, env.ws), InvalidRecordError);
  } finally {
    cleanup(env);
  }
});

test('capabilities: unknown EXTRA capabilities are ignored (forward-compat); missing REQUIRED ones refuse by name', () => {
  const extra = makeBackendInfo('postgres-s3', {
    roster_ops: { version: 1, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint', 'x-future-frobnicate'] },
    hitl: { version: 1, capabilities: ['requests', 'decisions', 'x-batch-decide'] },
    objects: { version: 1 },
  });
  assert.doesNotThrow(() => assertOperationSupported(extra, 'hitl.appendDecision'));
  assert.doesNotThrow(() => assertOperationSupported(extra, 'runs.appendEvent'));

  const missing = makeBackendInfo('postgres-s3', {
    roster_ops: { version: 1 },
    hitl: { version: 1, capabilities: ['requests'] },
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
