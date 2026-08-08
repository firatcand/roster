import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { executeInit } from '../src/commands/init.ts';
import { RosterError } from '../src/lib/errors.ts';
import { parseGeneratedMarkdown } from '../src/lib/generated-artifacts.ts';
import { probeWorkspace } from '../src/lib/workspace-probe.ts';
import { discoverWorkspace, validateWorkspace } from '../src/lib/workspace-registry.ts';
import {
  publishCreateOnly,
  realWorkspaceDurabilityFs,
  removePublishedWorkspaceFile,
} from '../src/lib/workspace-io.ts';

function workspace(prefix = 'roster-init'): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function expectRosterError(
  action: () => Promise<unknown>,
  code: string,
  context?: string,
): Promise<RosterError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof RosterError, `expected RosterError, got ${String(error)}`);
    assert.equal(error.code, code, context);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function copyLegacyManagedFile(root: string, relativePath: string): void {
  const source = resolve('templates', 'scaffold', relativePath);
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function injectDirectoryInspectionError(
  path: string,
  code?: string,
): (relativePath: string) => void {
  return (relativePath) => {
    if (relativePath !== path) return;
    const error = new Error('injected unreadable directory') as NodeJS.ErrnoException;
    if (code !== undefined) error.code = code;
    throw error;
  };
}

const failUnrelatedDirectoryInspection = injectDirectoryInspectionError('unrelated', 'EACCES');

test('executeInit creates exactly roster.yaml and ROSTER.md', async () => {
  const { root, cleanup } = workspace();
  try {
    const result = await executeInit({ cwd: root, name: 'acme', silent: true });
    assert.deepEqual(readdirSync(root).sort(), ['ROSTER.md', 'roster.yaml']);
    assert.deepEqual(result.filesWritten.sort(), ['ROSTER.md', 'roster.yaml']);
    assert.deepEqual(result.filesSkipped, []);
    assert.equal(result.workspaceRoot, resolve(root));
    assert.equal(result.workspaceId, 'acme');
  } finally {
    cleanup();
  }
});

test('executeInit writes the canonical registry and valid self-hashed bootstrap', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'my-roster', silent: true });
    assert.equal(
      readFileSync(join(root, 'roster.yaml'), 'utf8'),
      'schema_version: 2\nworkspace_id: my-roster\ntool_uses: []\nfunctions: {}\nhosts: {}\n',
    );
    const parsed = parseGeneratedMarkdown(readFileSync(join(root, 'ROSTER.md'), 'utf8'));
    assert.ok(parsed);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.header.artifact, 'roster-bootstrap');
    assert.match(parsed.body, /host agent interprets plans and executes the work/i);
  } finally {
    cleanup();
  }
});

test('executeInit is byte-idempotent and reports adopted files as skipped', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    const beforeRegistry = readFileSync(join(root, 'roster.yaml'));
    const beforeBootstrap = readFileSync(join(root, 'ROSTER.md'));
    const repeat = await executeInit({ cwd: root, name: 'acme', silent: true });
    assert.deepEqual(repeat.filesWritten, []);
    assert.deepEqual(repeat.filesSkipped.sort(), ['ROSTER.md', 'roster.yaml']);
    assert.deepEqual(readFileSync(join(root, 'roster.yaml')), beforeRegistry);
    assert.deepEqual(readFileSync(join(root, 'ROSTER.md')), beforeBootstrap);
  } finally {
    cleanup();
  }
});

test('executeInit refuses a different workspace id without overwriting bytes', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'first', silent: true });
    const before = readFileSync(join(root, 'roster.yaml'));
    await expectRosterError(
      () => executeInit({ cwd: root, name: 'second', silent: true }),
      'WRITE_CONFLICT',
    );
    assert.deepEqual(readFileSync(join(root, 'roster.yaml')), before);
  } finally {
    cleanup();
  }
});

test('a differing registry-only target is refused before bootstrap publication', async () => {
  const { root, cleanup } = workspace();
  try {
    const existing = 'schema_version: 2\nworkspace_id: first\ntool_uses: []\nfunctions: {}\nhosts: {}\n';
    writeFileSync(join(root, 'roster.yaml'), existing);
    await expectRosterError(
      () => executeInit({ cwd: root, name: 'second', silent: true }),
      'WRITE_CONFLICT',
    );
    assert.deepEqual(readdirSync(root), ['roster.yaml']);
    assert.equal(readFileSync(join(root, 'roster.yaml'), 'utf8'), existing);
  } finally {
    cleanup();
  }
});

test('an identical registry-only target adopts the sentinel and creates the bootstrap', async () => {
  const { root, cleanup } = workspace();
  try {
    const existing = 'schema_version: 2\nworkspace_id: acme\ntool_uses: []\nfunctions: {}\nhosts: {}\n';
    writeFileSync(join(root, 'roster.yaml'), existing);
    const result = await executeInit({ cwd: root, name: 'acme', silent: true });
    assert.deepEqual(result.filesWritten, ['ROSTER.md']);
    assert.deepEqual(result.filesSkipped, ['roster.yaml']);
    assert.deepEqual(readdirSync(root).sort(), ['ROSTER.md', 'roster.yaml']);
    assert.equal(readFileSync(join(root, 'roster.yaml'), 'utf8'), existing);
  } finally {
    cleanup();
  }
});

test('positional workspaceId and --name must agree', async () => {
  const { root, cleanup } = workspace();
  try {
    await expectRosterError(
      () => executeInit({ cwd: root, workspaceId: 'first', name: 'second', silent: true }),
      'IDENTITY_INVALID',
    );
    assert.deepEqual(readdirSync(root), []);
    const matching = await executeInit({
      cwd: root,
      workspaceId: 'same-id',
      name: 'same-id',
      silent: true,
    });
    assert.equal(matching.workspaceId, 'same-id');
  } finally {
    cleanup();
  }
});

test('executeInit validates a derived basename before writing', async () => {
  const { root, cleanup } = workspace('Roster Invalid');
  try {
    await expectRosterError(() => executeInit({ cwd: root, silent: true }), 'IDENTITY_INVALID');
    assert.deepEqual(readdirSync(root), []);
  } finally {
    cleanup();
  }
});

test('an existing differing ROSTER.md is preserved and blocks initialization', async () => {
  const { root, cleanup } = workspace();
  try {
    writeFileSync(join(root, 'ROSTER.md'), '# authored\n');
    await expectRosterError(
      () => executeInit({ cwd: root, name: 'acme', silent: true }),
      'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(join(root, 'ROSTER.md'), 'utf8'), '# authored\n');
    assert.deepEqual(readdirSync(root), ['ROSTER.md']);
  } finally {
    cleanup();
  }
});

test('a bootstrap-only interrupted init can be completed by an identical retry', async () => {
  const { root, cleanup } = workspace();
  const source = workspace();
  try {
    await executeInit({ cwd: source.root, name: 'source', silent: true });
    writeFileSync(join(root, 'ROSTER.md'), readFileSync(join(source.root, 'ROSTER.md')));
    assert.equal(probeWorkspace(root).kind, 'none');
    const result = await executeInit({ cwd: root, name: 'recovered', silent: true });
    assert.deepEqual(result.filesWritten, ['roster.yaml']);
    assert.deepEqual(result.filesSkipped, ['ROSTER.md']);
    assert.equal(probeWorkspace(root).kind, 'v2');
  } finally {
    source.cleanup();
    cleanup();
  }
});

test('registry durability failure rolls back canonical init files and preserves disclosed recovery bytes', async () => {
  const { root, cleanup } = workspace();
  try {
    await expectRosterError(() => executeInit(
      { cwd: root, name: 'acme', silent: true },
      {
        publish(targetRoot, relativePath, content, options) {
          return publishCreateOnly(targetRoot, relativePath, content, relativePath === 'roster.yaml'
            ? {
                ...options,
                durabilityFs: {
                  ...realWorkspaceDurabilityFs,
                  fsyncSync() {
                    const error = new Error('sync failed') as NodeJS.ErrnoException;
                    error.code = 'EIO';
                    throw error;
                  },
                },
              }
            : options);
        },
        removePublished: removePublishedWorkspaceFile,
      },
    ), 'WRITE_CONFLICT');
    assert.equal(existsSync(join(root, 'ROSTER.md')), false);
    assert.equal(existsSync(join(root, 'roster.yaml')), false);
    assert.ok(readdirSync(root).some((name) => name.startsWith('.roster.yaml.roster-')));
    const recovered = await executeInit({ cwd: root, name: 'acme', silent: true });
    assert.deepEqual(recovered.filesWritten.sort(), ['ROSTER.md', 'roster.yaml']);
  } finally {
    cleanup();
  }
});

test('late adopted-registry durability failure removes the invocation bootstrap', async () => {
  const { root, cleanup } = workspace();
  const registry = 'schema_version: 2\nworkspace_id: acme\ntool_uses: []\nfunctions: {}\nhosts: {}\n';
  try {
    writeFileSync(join(root, 'roster.yaml'), registry);
    let durabilitySyncs = 0;
    await expectRosterError(() => executeInit(
      { cwd: root, name: 'acme', silent: true },
      {
        publish(targetRoot, relativePath, content, options) {
          if (relativePath !== 'roster.yaml') {
            return publishCreateOnly(targetRoot, relativePath, content, options);
          }
          return publishCreateOnly(targetRoot, relativePath, content, {
            ...options,
            durabilityFs: {
              ...realWorkspaceDurabilityFs,
              fsyncSync(fd) {
                durabilitySyncs += 1;
                if (durabilitySyncs === 3) {
                  const error = new Error('late adopted cleanup sync failed') as NodeJS.ErrnoException;
                  error.code = 'EIO';
                  throw error;
                }
                realWorkspaceDurabilityFs.fsyncSync(fd);
              },
            },
          });
        },
        removePublished: removePublishedWorkspaceFile,
      },
    ), 'WRITE_CONFLICT');
    assert.equal(durabilitySyncs, 3);
    assert.equal(readFileSync(join(root, 'roster.yaml'), 'utf8'), registry);
    assert.equal(existsSync(join(root, 'ROSTER.md')), false);
    assert.deepEqual(readdirSync(root), ['roster.yaml']);
  } finally {
    cleanup();
  }
});

test('legacy exact markers fail closed and remain byte-preserved', async () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'project.yaml'), 'name: legacy\n');
    const before = readFileSync(join(root, 'config', 'project.yaml'));
    const error = await expectRosterError(
      () => executeInit({ cwd: root, name: 'acme', silent: true }),
      'LEGACY_WORKSPACE',
    );
    assert.deepEqual(error.details, { signals: ['config/project.yaml'] });
    assert.deepEqual(readFileSync(join(root, 'config', 'project.yaml')), before);
    assert.ok(!readdirSync(root).includes('roster.yaml'));
  } finally {
    cleanup();
  }
});

test('v0.4 projects markers fail closed at every supported depth', async () => {
  for (const relativePath of ['projects', 'gtm/projects', 'gtm/sdr/projects']) {
    const { root, cleanup } = workspace();
    try {
      mkdirSync(join(root, relativePath), { recursive: true });
      const error = await expectRosterError(
        () => executeInit({ cwd: root, name: 'acme', silent: true }),
        'LEGACY_WORKSPACE',
      );
      assert.ok((error.details['signals'] as string[]).includes(`${relativePath}/`));
      assert.ok(!readdirSync(root).includes('roster.yaml'));
    } finally {
      cleanup();
    }
  }
});

test('large unrelated source trees do not become unsafe legacy probe signals', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'src'));
    for (let index = 0; index < 1025; index++) {
      writeFileSync(join(root, 'src', `module-${index}.ts`), 'export {};\n');
    }
    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'none');
    assert.deepEqual(probe.unsafeSignals, []);
    assert.deepEqual(probe.inconclusiveSignals, []);
    assert.deepEqual(probe.legacySignals, []);
  } finally {
    cleanup();
  }
});

test('probe limits remain fail closed without a regular v2 sentinel', async () => {
  const rootCap = workspace();
  try {
    for (let index = 0; index < 1200; index++) {
      mkdirSync(join(rootCap.root, `area-${String(index).padStart(4, '0')}`));
    }
    const probe = probeWorkspace(rootCap.root);
    assert.equal(probe.kind, 'unsafe');
    assert.ok(probe.unsafeSignals.includes('.:probe-directory-entry-limit-exceeded'));
    assert.deepEqual(probe.inconclusiveSignals, ['.:probe-directory-entry-limit-exceeded']);
    await expectRosterError(
      () => executeInit({ cwd: rootCap.root, name: 'acme', silent: true }),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.equal(existsSync(join(rootCap.root, 'roster.yaml')), false);
  } finally {
    rootCap.cleanup();
  }

  const nestedCap = workspace();
  try {
    mkdirSync(join(nestedCap.root, 'company'));
    for (let index = 0; index < 1200; index++) {
      mkdirSync(join(nestedCap.root, 'company', `team-${String(index).padStart(4, '0')}`));
    }
    const probe = probeWorkspace(nestedCap.root);
    assert.equal(probe.kind, 'unsafe');
    assert.ok(probe.unsafeSignals.includes('company:probe-directory-entry-limit-exceeded'));
    assert.deepEqual(probe.inconclusiveSignals, [
      'company:probe-directory-entry-limit-exceeded',
    ]);
  } finally {
    nestedCap.cleanup();
  }
});

test('probe total traversal budget is inconclusive and therefore unsafe', () => {
  const { root, cleanup } = workspace();
  try {
    for (let group = 0; group < 10; group++) {
      const parent = join(root, `area-${group}`);
      mkdirSync(parent);
      for (let child = 0; child < 1000; child++) {
        mkdirSync(join(parent, `team-${String(child).padStart(4, '0')}`));
      }
    }
    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'unsafe');
    assert.ok(probe.unsafeSignals.some((signal) => signal.endsWith(':probe-total-entry-limit-exceeded')));
    assert.ok(probe.inconclusiveSignals.some((signal) => signal.endsWith(':probe-total-entry-limit-exceeded')));
  } finally {
    cleanup();
  }
});

test('a regular v2 sentinel keeps traversal-budget diagnostics non-blocking', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    for (let index = 0; index < 1025; index++) {
      writeFileSync(join(root, `unrelated-${String(index).padStart(4, '0')}.txt`), 'data\n');
    }

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'v2');
    assert.deepEqual(probe.v2Signals, ['roster.yaml']);
    assert.deepEqual(probe.legacySignals, []);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.deepEqual(probe.inconclusiveSignals, ['.:probe-directory-entry-limit-exceeded']);
    assert.deepEqual(discoverWorkspace(root).records, []);
    assert.equal(validateWorkspace(root).ok, true);
  } finally {
    cleanup();
  }
});

test('a regular v2 sentinel keeps incidental legacy-scan uncertainty non-blocking', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    mkdirSync(join(root, 'scripts'));
    symlinkSync('../ROSTER.md', join(root, 'scripts', 'new-agent.sh'));
    mkdirSync(join(root, 'company'));
    writeFileSync(join(root, 'company', 'projects'), 'not a legacy projects directory\n');
    mkdirSync(join(root, 'unrelated'));

    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: failUnrelatedDirectoryInspection,
    });
    assert.equal(probe.kind, 'v2');
    assert.deepEqual(probe.v2Signals, ['roster.yaml']);
    assert.deepEqual(probe.legacySignals, []);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.deepEqual(probe.inconclusiveSignals, [
      'company/projects:file',
      'scripts/new-agent.sh:symlink',
      'unrelated:unreadable:EACCES',
    ]);
    assert.deepEqual(discoverWorkspace(root).records, []);
    assert.equal(validateWorkspace(root).ok, true);

    rmSync(join(root, 'company', 'projects'));
    mkdirSync(join(root, 'company', 'projects'));
    const mixed = probeWorkspace(root, {
      beforeDirectoryInspect: failUnrelatedDirectoryInspection,
    });
    assert.equal(mixed.kind, 'mixed');
    assert.deepEqual(mixed.legacySignals, ['company/projects/']);
    assert.deepEqual(mixed.unsafeSignals, []);
    assert.deepEqual(mixed.inconclusiveSignals, [
      'scripts/new-agent.sh:symlink',
      'unrelated:unreadable:EACCES',
    ]);
  } finally {
    cleanup();
  }
});

test('incidental legacy-scan uncertainty remains fail closed without a v2 sentinel', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'scripts'));
    symlinkSync('../missing-target', join(root, 'scripts', 'new-agent.sh'));
    mkdirSync(join(root, 'company'));
    writeFileSync(join(root, 'company', 'projects'), 'not a legacy projects directory\n');
    mkdirSync(join(root, 'unrelated'));

    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: failUnrelatedDirectoryInspection,
    });
    const expected = [
      'company/projects:file',
      'scripts/new-agent.sh:symlink',
      'unrelated:unreadable:EACCES',
    ];
    assert.equal(probe.kind, 'unsafe');
    assert.deepEqual(probe.v2Signals, []);
    assert.deepEqual(probe.legacySignals, []);
    assert.deepEqual(probe.unsafeSignals, expected);
    assert.deepEqual(probe.inconclusiveSignals, expected);
  } finally {
    cleanup();
  }
});

test('canonical marker violations remain unsafe with a regular v2 sentinel', async () => {
  const cases: Array<{
    expected: string;
    mutate: (root: string) => void;
  }> = [
    {
      expected: 'ROSTER.md:symlink',
      mutate(root) {
        rmSync(join(root, 'ROSTER.md'));
        symlinkSync('roster.yaml', join(root, 'ROSTER.md'));
      },
    },
    {
      expected: 'config/project.yaml:directory',
      mutate(root) {
        mkdirSync(join(root, 'config', 'project.yaml'), { recursive: true });
      },
    },
    {
      expected: '.roster/scaffold-manifest.json:symlink_component',
      mutate(root) {
        symlinkSync('.', join(root, '.roster'));
      },
    },
  ];

  for (const entry of cases) {
    const { root, cleanup } = workspace();
    try {
      await executeInit({ cwd: root, name: 'acme', silent: true });
      entry.mutate(root);

      const probe = probeWorkspace(root);
      assert.equal(probe.kind, 'unsafe', entry.expected);
      assert.deepEqual(probe.v2Signals, ['roster.yaml']);
      assert.deepEqual(probe.unsafeSignals, [entry.expected]);
      assert.deepEqual(probe.inconclusiveSignals, []);
    } finally {
      cleanup();
    }
  }
});

test('root rename and same-path replacement stays unsafe after swap-back before init', async () => {
  const parent = workspace();
  const root = join(parent.root, 'workspace');
  const moved = join(parent.root, 'workspace-original');
  try {
    mkdirSync(root);
    let swapped = false;
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect(relativePath) {
        if (relativePath !== '.' || swapped) return;
        renameSync(root, moved);
        mkdirSync(root);
        swapped = true;
      },
    });
    assert.equal(swapped, true);
    assert.equal(probe.kind, 'unsafe');
    assert.ok(probe.unsafeSignals.includes('.:probe-directory-identity-changed'));

    rmSync(root, { recursive: true });
    renameSync(moved, root);
    let publications = 0;
    const error = await expectRosterError(
      () => executeInit(
        { cwd: root, name: 'acme', silent: true },
        {
          probe: () => probe,
          publish(targetRoot, relativePath, content, options) {
            publications += 1;
            return publishCreateOnly(targetRoot, relativePath, content, options);
          },
          removePublished: removePublishedWorkspaceFile,
        },
      ),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.deepEqual(error.details, { signals: ['.:probe-directory-identity-changed'] });
    assert.equal(publications, 0);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    parent.cleanup();
  }
});

test('candidate rename and same-path replacement stays unsafe after swap-back before init', async () => {
  const { root, cleanup } = workspace();
  const candidate = join(root, 'company');
  const moved = join(root, 'company-original');
  try {
    mkdirSync(candidate);
    let swapped = false;
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect(relativePath) {
        if (relativePath !== 'company' || swapped) return;
        renameSync(candidate, moved);
        mkdirSync(candidate);
        swapped = true;
      },
    });
    assert.equal(swapped, true);
    assert.equal(probe.kind, 'unsafe');
    assert.ok(
      probe.unsafeSignals.includes('company:probe-directory-identity-changed'),
    );

    rmSync(candidate, { recursive: true });
    renameSync(moved, candidate);
    let publications = 0;
    const error = await expectRosterError(
      () => executeInit(
        { cwd: root, name: 'acme', silent: true },
        {
          probe: () => probe,
          publish(targetRoot, relativePath, content, options) {
            publications += 1;
            return publishCreateOnly(targetRoot, relativePath, content, options);
          },
          removePublished: removePublishedWorkspaceFile,
        },
      ),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.deepEqual(error.details, {
      signals: ['company:probe-directory-identity-changed'],
    });
    assert.equal(publications, 0);
    assert.deepEqual(readdirSync(root), ['company']);
  } finally {
    cleanup();
  }
});

test('init revalidates a clean candidate token before any publication', async () => {
  const { root, cleanup } = workspace();
  const candidate = join(root, 'company');
  const moved = join(root, 'company-original');
  try {
    mkdirSync(candidate);
    let publications = 0;
    const error = await expectRosterError(
      () => executeInit(
        { cwd: root, name: 'acme', silent: true },
        {
          probe(targetRoot) {
            const probe = probeWorkspace(targetRoot);
            assert.ok(probe.session?.candidates.some((token) => token.path === 'company'));
            renameSync(candidate, moved);
            mkdirSync(candidate);
            return probe;
          },
          publish(targetRoot, relativePath, content, options) {
            publications += 1;
            return publishCreateOnly(targetRoot, relativePath, content, options);
          },
          removePublished: removePublishedWorkspaceFile,
        },
      ),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.deepEqual(error.details, {
      signals: ['company:probe-directory-identity-changed'],
    });
    assert.equal(publications, 0);
    assert.equal(existsSync(join(root, 'ROSTER.md')), false);
    assert.equal(existsSync(join(root, 'roster.yaml')), false);
    assert.equal(existsSync(join(moved, 'ROSTER.md')), false);
    assert.equal(existsSync(join(moved, 'roster.yaml')), false);
  } finally {
    cleanup();
  }
});

test('idempotent v2 init ignores churn in optional legacy-scan candidates', async () => {
  const { root, cleanup } = workspace();
  const candidate = join(root, 'company');
  const moved = join(root, 'company-original');
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    mkdirSync(candidate);

    const result = await executeInit(
      { cwd: root, name: 'acme', silent: true },
      {
        probe(targetRoot) {
          const probe = probeWorkspace(targetRoot);
          assert.deepEqual(probe.v2Signals, ['roster.yaml']);
          assert.ok(probe.session?.candidates.some((token) => token.path === 'company'));
          renameSync(candidate, moved);
          mkdirSync(candidate);
          return probe;
        },
        publish: publishCreateOnly,
        removePublished: removePublishedWorkspaceFile,
      },
    );

    assert.deepEqual(result.filesWritten, []);
    assert.deepEqual(result.filesSkipped.sort(), ['ROSTER.md', 'roster.yaml']);
    assert.equal(existsSync(join(root, 'ROSTER.md')), true);
    assert.equal(existsSync(join(root, 'roster.yaml')), true);
  } finally {
    cleanup();
  }
});

test('init root replacement at every publication boundary rolls back exact created bytes', async () => {
  for (const phase of [
    'bootstrap-before',
    'bootstrap-after',
    'registry-before',
    'registry-after',
  ] as const) {
    const parent = workspace();
    const root = join(parent.root, 'workspace');
    const moved = join(parent.root, 'workspace-original');
    try {
      mkdirSync(root);
      let swapped = false;
      const swap = (): void => {
        if (swapped) return;
        renameSync(root, moved);
        mkdirSync(root);
        swapped = true;
      };
      const error = await expectRosterError(
        () => executeInit(
          { cwd: root, name: 'acme', silent: true },
          {
            publish(targetRoot, relativePath, content, options) {
              const target = relativePath === 'ROSTER.md' ? 'bootstrap' : 'registry';
              return publishCreateOnly(targetRoot, relativePath, content, {
                ...options,
                beforePublish() {
                  options?.beforePublish?.();
                  if (phase === `${target}-before`) swap();
                },
                afterMutation() {
                  options?.afterMutation?.();
                  if (phase === `${target}-after`) swap();
                },
              });
            },
            removePublished: removePublishedWorkspaceFile,
          },
        ),
        'UNSAFE_WORKSPACE_MARKER',
        phase,
      );
      assert.equal(swapped, true, phase);
      assert.deepEqual(error.details, { signals: ['.:probe-directory-identity-changed'] });
      assert.equal(existsSync(join(root, 'ROSTER.md')), false, phase);
      assert.equal(existsSync(join(root, 'roster.yaml')), false, phase);
      assert.equal(existsSync(join(moved, 'ROSTER.md')), false, phase);
      assert.equal(existsSync(join(moved, 'roster.yaml')), false, phase);
    } finally {
      parent.cleanup();
    }
  }
});

test('init unwinds exact creation tokens when publication throws after capture', async () => {
  for (const latePath of ['ROSTER.md', 'roster.yaml'] as const) {
    const { root, cleanup } = workspace();
    try {
      await assert.rejects(
        () => executeInit(
          { cwd: root, name: 'acme', silent: true },
          {
            publish(targetRoot, relativePath, content, options) {
              const publication = publishCreateOnly(targetRoot, relativePath, content, options);
              if (relativePath === latePath) throw new Error(`late failure after ${latePath}`);
              return publication;
            },
            removePublished: removePublishedWorkspaceFile,
          },
        ),
        new RegExp(`late failure after ${latePath.replace('.', '\\.')}`),
      );
      assert.equal(existsSync(join(root, 'ROSTER.md')), false, latePath);
      assert.equal(existsSync(join(root, 'roster.yaml')), false, latePath);
    } finally {
      cleanup();
    }
  }
});

test('init discloses exact preserved tokens when transactional removal is incomplete', async () => {
  for (const removalFailure of ['false', 'throw'] as const) {
    const { root, cleanup } = workspace();
    try {
      const error = await expectRosterError(
        () => executeInit(
          { cwd: root, name: 'acme', silent: true },
          {
            publish(targetRoot, relativePath, content, options) {
              const publication = publishCreateOnly(targetRoot, relativePath, content, options);
              if (relativePath === 'roster.yaml') throw new Error('late registry failure');
              return publication;
            },
            removePublished(targetRoot, relativePath, identity) {
              if (relativePath === 'roster.yaml') {
                if (removalFailure === 'false') return false;
                const failure = new Error('removal failed') as NodeJS.ErrnoException;
                failure.code = 'EIO';
                throw failure;
              }
              return removePublishedWorkspaceFile(targetRoot, relativePath, identity);
            },
          },
        ),
        'WRITE_CONFLICT',
        removalFailure,
      );
      assert.equal(error.details['path'], 'roster.yaml');
      assert.equal(error.details['state'], 'unknown');
      assert.deepEqual(error.details['preservedPaths'], ['roster.yaml', 'ROSTER.md']);
      assert.equal(typeof error.details['expectedDev'], 'number');
      assert.equal(typeof error.details['expectedIno'], 'number');
      assert.equal(typeof error.details['expectedHash'], 'string');
      assert.equal(existsSync(join(root, 'ROSTER.md')), true);
      assert.equal(existsSync(join(root, 'roster.yaml')), true);
    } finally {
      cleanup();
    }
  }
});

test('an unreadable, unrelated sibling directory does not block a plain init (#386)', async () => {
  if (process.getuid && process.getuid() === 0) return;
  const { root, cleanup } = workspace();
  const candidate = join(root, 'company');
  try {
    mkdirSync(candidate);
    chmodSync(candidate, 0o000);
    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'none');
    assert.deepEqual(probe.unsafeSignals, []);
    assert.ok(probe.inconclusiveSignals.some((signal) => signal.startsWith('company:unreadable:')));

    const result = await executeInit({ cwd: root, name: 'acme', silent: true });
    assert.deepEqual(result.filesWritten.sort(), ['ROSTER.md', 'roster.yaml']);
  } finally {
    chmodSync(candidate, 0o755);
    cleanup();
  }
});

test('a non-permission error on a scanned candidate root stays unsafe (#386 negative control)', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'company'));
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: injectDirectoryInspectionError('company', 'EIO'),
    });
    assert.equal(probe.kind, 'unsafe');
    assert.ok(probe.unsafeSignals.includes('company:unreadable:EIO'));
  } finally {
    cleanup();
  }
});

test('EPERM on an unrelated candidate is treated the same as EACCES (#386)', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'unrelated'));
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: injectDirectoryInspectionError('unrelated', 'EPERM'),
    });
    assert.equal(probe.kind, 'none');
    assert.deepEqual(probe.unsafeSignals, []);
    assert.deepEqual(probe.inconclusiveSignals, ['unrelated:unreadable:EPERM']);
  } finally {
    cleanup();
  }
});

test('EIO on an unrelated candidate stays fail closed (#386)', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'unrelated'));
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: injectDirectoryInspectionError('unrelated', 'EIO'),
    });
    assert.equal(probe.kind, 'unsafe');
    assert.deepEqual(probe.unsafeSignals, ['unrelated:unreadable:EIO']);
    assert.deepEqual(probe.inconclusiveSignals, ['unrelated:unreadable:EIO']);
  } finally {
    cleanup();
  }
});

test('an error with no code stays fail closed as unknown (#386)', () => {
  const { root, cleanup } = workspace();
  try {
    mkdirSync(join(root, 'unrelated'));
    const probe = probeWorkspace(root, {
      beforeDirectoryInspect: injectDirectoryInspectionError('unrelated'),
    });
    assert.equal(probe.kind, 'unsafe');
    assert.deepEqual(probe.unsafeSignals, ['unrelated:unreadable:unknown']);
    assert.deepEqual(probe.inconclusiveSignals, ['unrelated:unreadable:unknown']);
  } finally {
    cleanup();
  }
});

test('an unreadable legacy-signature file alone does not block (#386)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const { root, cleanup } = workspace();
  const signature = join(root, 'dreamer', 'agent.md');
  try {
    mkdirSync(join(root, 'dreamer'));
    writeFileSync(signature, 'unreadable legacy signature\n');
    chmodSync(signature, 0o000);

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'none');
    assert.deepEqual(probe.legacySignals, []);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.ok(
      probe.inconclusiveSignals.some((signal) => signal.startsWith('dreamer/agent.md:')),
    );
  } finally {
    chmodSync(signature, 0o644);
    cleanup();
  }
});

test('an unreadable legacy-signature file does not block a genuine legacy signal elsewhere (#386)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const { root, cleanup } = workspace();
  const signature = join(root, 'dreamer', 'agent.md');
  try {
    mkdirSync(join(root, 'projects'));
    mkdirSync(join(root, 'dreamer'));
    writeFileSync(signature, 'unreadable legacy signature\n');
    chmodSync(signature, 0o000);

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'legacy');
    assert.deepEqual(probe.legacySignals, ['projects/']);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.ok(
      probe.inconclusiveSignals.some((signal) => signal.startsWith('dreamer/agent.md:')),
    );
  } finally {
    chmodSync(signature, 0o644);
    cleanup();
  }
});

test('an unreadable parent of a legacy-signature file does not block a genuine legacy signal elsewhere (#386)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const { root, cleanup } = workspace();
  const parent = join(root, 'dreamer');
  try {
    mkdirSync(join(root, 'projects'));
    mkdirSync(parent);
    writeFileSync(join(parent, 'agent.md'), 'unreadable legacy signature\n');
    chmodSync(parent, 0o000);

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'legacy');
    assert.deepEqual(probe.legacySignals, ['projects/']);
    assert.deepEqual(probe.unsafeSignals, []);
    // The unreadable directory itself, plus inspectPath's early workspace-failure
    // branch for the signature file whose parent cannot be traversed.
    assert.deepEqual(probe.inconclusiveSignals, [
      'dreamer/agent.md:write_conflict',
      'dreamer:unreadable:write_conflict',
    ]);
  } finally {
    chmodSync(parent, 0o755);
    cleanup();
  }
});

test('a structural inconclusive signal keeps a legacy workspace fail closed (#386)', () => {
  const { root, cleanup } = workspace();
  try {
    copyLegacyManagedFile(root, 'chief-of-staff/agent.md');
    copyLegacyManagedFile(root, 'dreamer/agent.md');
    mkdirSync(join(root, 'company'));
    writeFileSync(join(root, 'company', 'projects'), 'not a legacy projects directory\n');

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'unsafe');
    assert.deepEqual(probe.legacySignals, [
      'managed-v1:chief-of-staff/agent.md',
      'managed-v1:dreamer/agent.md',
    ]);
    assert.deepEqual(probe.unsafeSignals, ['company/projects:file']);
    assert.deepEqual(probe.inconclusiveSignals, ['company/projects:file']);
  } finally {
    cleanup();
  }
});

test('an io-ambiguous signal leaves a legacy workspace classified legacy (#386)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const { root, cleanup } = workspace();
  const candidate = join(root, 'company');
  try {
    copyLegacyManagedFile(root, 'chief-of-staff/agent.md');
    copyLegacyManagedFile(root, 'dreamer/agent.md');
    mkdirSync(candidate);
    chmodSync(candidate, 0o000);

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'legacy');
    assert.deepEqual(probe.legacySignals, [
      'managed-v1:chief-of-staff/agent.md',
      'managed-v1:dreamer/agent.md',
    ]);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.ok(probe.inconclusiveSignals.some((signal) => signal.startsWith('company:unreadable:')));
  } finally {
    chmodSync(candidate, 0o755);
    cleanup();
  }
});

test('one coincidental managed v1 leaf is ignored but two exact leaves classify legacy', async () => {
  const one = workspace();
  const two = workspace();
  try {
    copyLegacyManagedFile(one.root, 'chief-of-staff/agent.md');
    assert.equal(probeWorkspace(one.root).kind, 'none');

    copyLegacyManagedFile(two.root, 'chief-of-staff/agent.md');
    copyLegacyManagedFile(two.root, 'dreamer/agent.md');
    const probe = probeWorkspace(two.root);
    assert.equal(probe.kind, 'legacy');
    assert.deepEqual(probe.legacySignals, [
      'managed-v1:chief-of-staff/agent.md',
      'managed-v1:dreamer/agent.md',
    ]);
  } finally {
    one.cleanup();
    two.cleanup();
  }
});

test('exact managed v1 signatures retain mixed precedence over incidental uncertainty', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    copyLegacyManagedFile(root, 'chief-of-staff/agent.md');
    copyLegacyManagedFile(root, 'dreamer/agent.md');
    mkdirSync(join(root, 'scripts'));
    symlinkSync('../ROSTER.md', join(root, 'scripts', 'new-agent.sh'));

    const probe = probeWorkspace(root);
    assert.equal(probe.kind, 'mixed');
    assert.deepEqual(probe.legacySignals, [
      'managed-v1:chief-of-staff/agent.md',
      'managed-v1:dreamer/agent.md',
    ]);
    assert.deepEqual(probe.unsafeSignals, []);
    assert.deepEqual(probe.inconclusiveSignals, ['scripts/new-agent.sh:symlink']);
  } finally {
    cleanup();
  }
});

test('mixed v2 and legacy markers are refused distinctly', async () => {
  const { root, cleanup } = workspace();
  try {
    await executeInit({ cwd: root, name: 'acme', silent: true });
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'project.yaml'), 'name: legacy\n');
    const error = await expectRosterError(
      () => executeInit({ cwd: root, name: 'acme', silent: true }),
      'MIXED_WORKSPACE',
    );
    assert.deepEqual(error.details, {
      v2_signals: ['roster.yaml'],
      legacy_signals: ['config/project.yaml'],
    });
  } finally {
    cleanup();
  }
});

test('unsafe workspace marker types are refused without following symlinks', async () => {
  const { root, cleanup } = workspace();
  const outside = workspace();
  try {
    writeFileSync(join(outside.root, 'roster.yaml'), 'outside\n');
    symlinkSync(join(outside.root, 'roster.yaml'), join(root, 'roster.yaml'));
    const error = await expectRosterError(
      () => executeInit({ cwd: root, name: 'acme', silent: true }),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.deepEqual(error.details, { signals: ['roster.yaml:symlink'] });
    assert.equal(readFileSync(join(outside.root, 'roster.yaml'), 'utf8'), 'outside\n');
    assert.deepEqual(readdirSync(root), ['roster.yaml']);
  } finally {
    outside.cleanup();
    cleanup();
  }
});

test('a symlinked workspace root is classified unsafe before any publication', async () => {
  const parent = workspace();
  const target = workspace();
  const link = join(parent.root, 'workspace-link');
  try {
    symlinkSync(target.root, link);
    const error = await expectRosterError(
      () => executeInit({ cwd: link, name: 'acme', silent: true }),
      'UNSAFE_WORKSPACE_MARKER',
    );
    assert.deepEqual(error.details, { signals: ['.:symlink'] });
    assert.deepEqual(readdirSync(target.root), []);
  } finally {
    target.cleanup();
    parent.cleanup();
  }
});
