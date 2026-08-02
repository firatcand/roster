import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import type { NormalizedManifest } from '../src/lib/founder-skills/manifest-schema.ts';
import type { Lockfile } from '../src/lib/founder-skills/lockfile.ts';
import {
  readLockfile,
  writeLockfile,
} from '../src/lib/founder-skills/lockfile.ts';
import {
  buildVendorSkillMap,
  hashProjectSkillForHost,
  isCanonicalVendorSkillMapBytes,
  parseVendorSkillMap,
  serializeVendorSkillMap,
  VENDOR_SKILL_MAP_PATH,
  type VendorSkillMap,
  type VendorSkillHost,
} from '../src/lib/vendor-skills/adapter-map.ts';
import { canonicalJson } from '../src/lib/vendor-skills/canonical-json.ts';
import { parseSkillRef, type CanonicalSkillRef } from '../src/lib/vendor-skills/skill-ref.ts';
import { getPackageVersion } from '../src/lib/paths.ts';
import {
  scaffoldWorkspace,
  validateWorkspace,
} from '../src/lib/workspace-registry.ts';

function withWorkspace(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'roster-vendor-map-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function materialize(
  root: string,
  host: VendorSkillHost,
  name: string,
  body = '---\nname: pricing\ndescription: pricing skill\n---\nbody\n',
): void {
  const base = host === 'claude' ? ['.claude', 'skills'] : ['.agents', 'skills'];
  const directory = join(root, ...base, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), body);
}

function projectInputs(
  root: string,
  options: {
    skillRef?: CanonicalSkillRef;
    revision?: string;
    hosts?: VendorSkillHost[];
    lockHosts?: VendorSkillHost[];
  } = {},
): {
  skillRef: CanonicalSkillRef;
  manifest: NormalizedManifest;
  lockfile: Lockfile;
} {
  const skillRef = options.skillRef ?? parseSkillRef('founder-skills:pricing');
  const revision = options.revision ?? 'a'.repeat(40);
  const hosts = options.hosts ?? ['claude', 'codex'];
  for (const host of hosts) materialize(root, host, 'pricing');
  const lockHosts = options.lockHosts ?? [...hosts];
  const contentHashes = Object.fromEntries(lockHosts.map((host) => [
    host,
    hashProjectSkillForHost({
      workspaceRoot: root,
      host,
      skillName: 'pricing',
    }).contentHash,
  ]));
  const contentHash = Object.values(contentHashes)[0] ?? 'absent';
  return {
    skillRef,
    manifest: {
      source: 'github:firatcand/founder-skills',
      skills: [{ name: 'pricing', ref: revision, skillRef }],
    },
    lockfile: {
      version: 1,
      source: 'github:firatcand/founder-skills',
      skills: [{
        name: 'pricing',
        ref: revision,
        contentHash,
        contentHashes,
        tools: lockHosts,
        skill_ref: skillRef,
      }],
    },
  };
}

function errorRecord(fn: () => unknown): { code: unknown; rendered: string } {
  try {
    fn();
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown; header?: unknown; remedy?: unknown; details?: unknown };
    return {
      code: record.code,
      rendered: JSON.stringify({
        message: record.message,
        header: record.header,
        remedy: record.remedy,
        details: record.details,
      }),
    };
  }
  assert.fail('expected failure');
}

function ambiguousDelimiterHash(entries: Array<{ path: string; content: Buffer }>): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function targetedMapWorkspace(root: string): {
  skillRef: CanonicalSkillRef;
  selectedPath: string;
  ignoredDraftPath: string;
} {
  writeFileSync(join(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: vendor-map-test',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  for (const functionId of ['gtm', 'support']) {
    scaffoldWorkspace(root, { kind: 'function', id: functionId });
    scaffoldWorkspace(root, { kind: 'agent', id: 'manager', scope: `function:${functionId}` });
  }
  scaffoldWorkspace(root, {
    kind: 'plan',
    id: 'discover',
    scope: 'agent:gtm/manager',
    purpose: 'Discover opportunities.',
  });
  const selected = scaffoldWorkspace(root, {
    kind: 'tool-use',
    id: 'research',
    scope: 'agent:gtm/manager',
    purpose: 'Research public opportunities.',
  });
  const ignoredDraft = scaffoldWorkspace(root, {
    kind: 'tool-use',
    id: 'later',
    scope: 'agent:support/manager',
  });
  writeFileSync(join(root, selected.record.path), [
    'schema_version: 2',
    'id: research',
    'scope:',
    '  function: gtm',
    '  agent: manager',
    'purpose: Research public opportunities.',
    'skill_ref: exa:search',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'functions/gtm/agents/manager/plans/discover.yaml'), [
    'schema_version: 2',
    'id: discover',
    'agent: gtm/manager',
    'purpose: Discover opportunities.',
    'inputs: {}',
    'brain_selectors: {}',
    'guidelines: []',
    'tool_uses: []',
    'artifacts: {}',
    'caps: {}',
    'steps:',
    '  - id: research',
    '    kind: tool',
    '    instruction: Research opportunities.',
    '    tool_use: research',
    'completion:',
    '  artifacts: []',
    '  output_guidance: Return the opportunities.',
    '  criteria:',
    '    - Every opportunity has a source.',
    '',
  ].join('\n'));
  return {
    skillRef: parseSkillRef('exa:search'),
    selectedPath: selected.record.path,
    ignoredDraftPath: ignoredDraft.record.path,
  };
}

function writeNativeMap(
  root: string,
  skillRef: CanonicalSkillRef,
  authoredPaths: string[],
): void {
  const map = buildVendorSkillMap({
    workspaceRoot: root,
    skillRefs: [skillRef],
    skillRefPaths: new Map([[skillRef, authoredPaths]]),
    enabledHosts: [],
    manifest: null,
    lockfile: null,
    generatorVersion: getPackageVersion(),
  });
  writeFileSync(join(root, VENDOR_SKILL_MAP_PATH), serializeVendorSkillMap(map));
}

test('native map generation is deterministic, sorted, canonical, and self-hashed', () => {
  withWorkspace((root) => {
    const search = parseSkillRef('exa:search');
    const browse = parseSkillRef('browser:control');
    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [search, browse, search],
      enabledHosts: ['codex', 'claude', 'codex'],
      manifest: null,
      lockfile: null,
      generatorVersion: '1.8.1',
    });
    assert.deepEqual(map.skills.map((entry) => entry.skill_ref), [browse, search]);
    for (const entry of map.skills) {
      assert.deepEqual(Object.keys(entry.hosts), ['claude', 'codex']);
      assert.deepEqual(entry.hosts['claude'], {
        kind: 'host-native',
        identity: entry.skill_ref,
        assurance: 'host-resolved',
      });
      assert.deepEqual(entry.hosts['codex'], entry.hosts['claude']);
    }
    assert.match(map.map_hash, /^sha256:[a-f0-9]{64}$/);
    const serialized = serializeVendorSkillMap(map);
    assert.equal(serialized.endsWith('\n'), true);
    assert.equal(serialized.endsWith('\n\n'), false);
    assert.deepEqual(parseVendorSkillMap(serialized), map);
    assert.equal(isCanonicalVendorSkillMapBytes(serialized), true);
    assert.equal(parseVendorSkillMap(`${JSON.stringify(map, null, 2)}\n`), null);
    assert.equal(parseVendorSkillMap(serialized.replace('host-resolved', 'verified')), null);
    assert.equal(VENDOR_SKILL_MAP_PATH, '.roster/vendor-skill-map.json');
  });
});

test('an unsynced founder manifest is irrelevant when no authored tool uses reference it', () => {
  withWorkspace((root) => {
    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [],
      enabledHosts: ['claude'],
      manifest: {
        source: 'github:firatcand/founder-skills',
        skills: [{
          name: 'pricing',
          ref: 'v1.0.0',
          skillRef: parseSkillRef('founder-skills:pricing'),
        }],
      },
      lockfile: null,
      generatorVersion: getPackageVersion(),
    });
    assert.deepEqual(map.skills, []);
    assert.match(map.map_hash, /^sha256:[a-f0-9]{64}$/);
  });
});

test('authored provenance accepts custom function roots but never serializes secret-shaped paths', () => {
  withWorkspace((root) => {
    const skillRef = parseSkillRef('exa:search');
    const customPath = 'teams/gtm/agents/manager/tools/research.yaml';
    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [skillRef],
      skillRefPaths: new Map([[skillRef, [customPath]]]),
      enabledHosts: [],
      manifest: null,
      lockfile: null,
      generatorVersion: '1.8.1',
    });
    assert.deepEqual(map.skills[0]?.authored_paths, [customPath]);

    const deepPath = `${Array.from({ length: 8 }, (_, index) => (
      `segment-${index}-${'a'.repeat(60)}`
    )).join('/')}/tools/research.yaml`;
    assert.ok(deepPath.length > 512);
    const manyPaths = Array.from({ length: 1_025 }, (_, index) => (
      `teams/team-${index.toString().padStart(4, '0')}/tools/research.yaml`
    ));
    const scalableMap = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [skillRef],
      skillRefPaths: new Map([[skillRef, [deepPath, ...manyPaths]]]),
      enabledHosts: [],
      manifest: null,
      lockfile: null,
      generatorVersion: '1.8.1',
    });
    assert.equal(scalableMap.skills[0]?.authored_paths.includes(deepPath), true);
    assert.equal(scalableMap.skills[0]?.authored_paths.length, 1_026);
    assert.ok(Buffer.byteLength(serializeVendorSkillMap(scalableMap), 'utf8') < 1024 * 1024);

    const canary = `sk-${'abcdefghijklmnopqrstuvwxyz123456'}`;
    const failure = errorRecord(() => buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [skillRef],
      skillRefPaths: new Map([[skillRef, [`teams/gtm/tools/${canary}.yaml`]]]),
      enabledHosts: [],
      manifest: null,
      lockfile: null,
      generatorVersion: '1.8.1',
    }));
    assert.equal(failure.code, 'SKILL_REF_INVALID');
    assert.equal(failure.rendered.includes(canary), false);
    assert.equal(failure.rendered.includes('sha256:'), false);
  });
});

test('an explicit manifest join is the only workspace-relative discriminator', () => {
  withWorkspace((root) => {
    const input = projectInputs(root);
    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [input.skillRef],
      enabledHosts: ['claude', 'codex'],
      manifest: input.manifest,
      lockfile: input.lockfile,
      generatorVersion: '1.8.1',
    });
    for (const host of ['claude', 'codex'] as const) {
      const locator = map.skills[0]!.hosts[host]!;
      assert.equal(locator.kind, 'workspace-relative');
      if (locator.kind !== 'workspace-relative') continue;
      assert.equal(locator.path, host === 'claude'
        ? '.claude/skills/pricing'
        : '.agents/skills/pricing');
      assert.match(locator.content_hash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(locator.source, 'github:firatcand/founder-skills');
      assert.equal(locator.revision, 'a'.repeat(40));
      assert.equal(locator.revision_immutable, true);
      assert.equal(locator.assurance, 'verified');
    }

    const native = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [input.skillRef],
      enabledHosts: ['claude'],
      manifest: {
        source: input.manifest.source,
        skills: [{ name: 'pricing', ref: 'main' }],
      },
      lockfile: {
        version: 1,
        source: input.manifest.source,
        skills: [{
          name: 'pricing',
          ref: 'main',
          contentHash: input.lockfile.skills[0]!.contentHash,
          tools: ['claude'],
        }],
      },
      generatorVersion: '1.8.1',
    });
    assert.equal(native.skills[0]!.hosts['claude']!.kind, 'host-native');
  });
});

test('an existing empty per-host skill can be verified but a removed directory fails closed', () => {
  withWorkspace((root) => {
    const skillRef = parseSkillRef('founder-skills:pricing');
    const directory = join(root, '.claude', 'skills', 'pricing');
    mkdirSync(directory, { recursive: true });
    const emptyHash = hashProjectSkillForHost({
      workspaceRoot: root,
      host: 'claude',
      skillName: 'pricing',
    }).contentHash;
    const manifest: NormalizedManifest = {
      source: 'github:firatcand/founder-skills',
      skills: [{ name: 'pricing', ref: 'a'.repeat(40), skillRef }],
    };
    const lockfile: Lockfile = {
      version: 1,
      source: manifest.source,
      skills: [{
        name: 'pricing',
        ref: 'a'.repeat(40),
        contentHash: emptyHash,
        contentHashes: { claude: emptyHash },
        tools: ['claude'],
        skill_ref: skillRef,
      }],
    };
    const verified = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [skillRef],
      enabledHosts: ['claude'],
      manifest,
      lockfile,
      generatorVersion: '1.8.1',
    });
    const locator = verified.skills[0]!.hosts['claude']!;
    assert.equal(locator.kind, 'workspace-relative');
    assert.equal(locator.assurance, 'verified');
    if (locator.kind === 'workspace-relative') assert.equal(locator.content_hash, emptyHash);

    rmSync(directory, { recursive: true });
    const missing = errorRecord(() => buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [skillRef],
      enabledHosts: ['claude'],
      manifest,
      lockfile,
      generatorVersion: '1.8.1',
    }));
    assert.equal(missing.code, 'SKILL_REF_UNMAPPED');
    assert.equal(missing.rendered.includes('verified'), false);
  });
});

test('a legacy aggregate contentHash cannot prove per-host project skill integrity', () => {
  withWorkspace((root) => {
    const input = projectInputs(root, { hosts: ['claude'] });
    const legacyOnly: Lockfile = {
      ...input.lockfile,
      skills: input.lockfile.skills.map(({ contentHashes: _contentHashes, ...skill }) => skill),
    };
    const failure = errorRecord(() => buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [input.skillRef],
      enabledHosts: ['claude'],
      manifest: input.manifest,
      lockfile: legacyOnly,
      generatorVersion: '1.8.1',
    }));
    assert.equal(failure.code, 'SKILL_REF_UNMAPPED');
    assert.equal(failure.rendered.includes('verified'), false);
  });
});

test('targeted validation subtracts only an explicitly ignored draft path from a current map entry', () => {
  withWorkspace((root) => {
    const fixture = targetedMapWorkspace(root);
    writeNativeMap(root, fixture.skillRef, [fixture.selectedPath, fixture.ignoredDraftPath]);

    const targeted = validateWorkspace(root, { target: 'gtm/manager#discover' });
    assert.equal(
      targeted.checks.find((check) => check.name === 'tool-use-lattice')?.details['ignored_unrelated_drafts'],
      1,
    );
    assert.equal(
      targeted.checks.find((check) => check.name === 'vendor-skill-map')?.status,
      'pass',
      JSON.stringify(targeted.diagnostics),
    );
    assert.equal(targeted.diagnostics.some((entry) => entry.code === 'SKILL_REF_DRIFTED'), false);
  });
});

test('targeted validation rejects a surplus non-ignored path in a current map entry', () => {
  withWorkspace((root) => {
    const fixture = targetedMapWorkspace(root);
    writeNativeMap(root, fixture.skillRef, [
      fixture.selectedPath,
      fixture.ignoredDraftPath,
      'tools/surplus.yaml',
    ]);

    const targeted = validateWorkspace(root, { target: 'gtm/manager#discover' });
    assert.equal(
      targeted.checks.find((check) => check.name === 'tool-use-lattice')?.details['ignored_unrelated_drafts'],
      1,
    );
    assert.equal(targeted.checks.find((check) => check.name === 'vendor-skill-map')?.status, 'fail');
    assert.equal(targeted.diagnostics.some((entry) => (
      entry.code === 'SKILL_REF_DRIFTED' && entry.path === VENDOR_SKILL_MAP_PATH
    )), true, JSON.stringify(targeted.diagnostics));
  });
});

test('targeted validation never trusts a verified locator carried only by an ignored draft', () => {
  withWorkspace((root) => {
    const fixture = targetedMapWorkspace(root);
    const base = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [fixture.skillRef],
      skillRefPaths: new Map([[fixture.skillRef, [fixture.selectedPath]]]),
      enabledHosts: [],
      manifest: null,
      lockfile: null,
      generatorVersion: getPackageVersion(),
    });
    const payload: Omit<VendorSkillMap, 'map_hash'> = {
      schema_version: base.schema_version,
      generator: base.generator,
      generator_version: base.generator_version,
      skills: [
        {
          skill_ref: parseSkillRef('exa:later'),
          authored_paths: [fixture.ignoredDraftPath],
          hosts: {
            claude: {
              kind: 'workspace-relative',
              path: '.claude/skills/later',
              content_hash: `sha256:${'a'.repeat(64)}`,
              source: 'github:firatcand/founder-skills',
              revision: 'b'.repeat(40),
              revision_immutable: true,
              assurance: 'verified',
            },
          },
        },
        ...base.skills,
      ],
    };
    const map: VendorSkillMap = {
      ...payload,
      map_hash: `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`,
    };
    writeFileSync(join(root, VENDOR_SKILL_MAP_PATH), serializeVendorSkillMap(map));

    const targeted = validateWorkspace(root, { target: 'gtm/manager#discover' });
    assert.equal(targeted.checks.find((check) => check.name === 'vendor-skill-map')?.status, 'fail');
    assert.equal(targeted.diagnostics.some((entry) => entry.code === 'SKILL_REF_DRIFTED'), true);
  });
});

test('mutable refs are preserved and never claimed as immutable', () => {
  withWorkspace((root) => {
    const input = projectInputs(root, { revision: 'main' });
    const map = buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [input.skillRef],
      enabledHosts: ['claude'],
      manifest: input.manifest,
      lockfile: input.lockfile,
      generatorVersion: '1.8.1',
    });
    const locator = map.skills[0]!.hosts['claude']!;
    assert.equal(locator.kind, 'workspace-relative');
    if (locator.kind === 'workspace-relative') {
      assert.equal(locator.revision, 'main');
      assert.equal(locator.revision_immutable, false);
    }
  });
});

test('partial, duplicate, mismatched, missing, and drifted project joins fail closed', () => {
  withWorkspace((root) => {
    const input = projectInputs(root, { lockHosts: ['claude'] });
    const base = {
      workspaceRoot: root,
      skillRefs: [input.skillRef],
      enabledHosts: ['claude', 'codex'] as const,
      manifest: input.manifest,
      lockfile: input.lockfile,
      generatorVersion: '1.8.1',
    };
    assert.equal(errorRecord(() => buildVendorSkillMap(base)).code, 'SKILL_REF_UNMAPPED');

    const duplicateManifest: NormalizedManifest = {
      ...input.manifest,
      skills: [
        ...input.manifest.skills,
        { name: 'pricing-copy', ref: 'a'.repeat(40), skillRef: input.skillRef },
      ],
    };
    assert.equal(errorRecord(() => buildVendorSkillMap({
      ...base,
      manifest: duplicateManifest,
    })).code, 'SKILL_REF_UNMAPPED');

    assert.equal(errorRecord(() => buildVendorSkillMap({
      ...base,
      enabledHosts: ['claude'],
      lockfile: {
        ...input.lockfile,
        source: 'github:another/repository',
      },
    })).code, 'SKILL_REF_UNMAPPED');

    assert.equal(errorRecord(() => buildVendorSkillMap({
      ...base,
      enabledHosts: ['claude'],
      lockfile: null,
    })).code, 'SKILL_REF_UNMAPPED');

    materialize(root, 'claude', 'pricing', 'changed');
    const drift = errorRecord(() => buildVendorSkillMap({
      ...base,
      enabledHosts: ['claude'],
      lockfile: {
        ...input.lockfile,
        skills: input.lockfile.skills.map((skill) => ({ ...skill, tools: ['claude'] })),
      },
    }));
    assert.equal(drift.code, 'SKILL_REF_DRIFTED');
    assert.equal(drift.rendered.includes(input.skillRef), false);
    assert.equal(drift.rendered.includes(input.lockfile.skills[0]!.contentHash), false);
  });
});

test('valid-looking but stale lock provenance fails even when requested refs are host-native', () => {
  withWorkspace((root) => {
    const nativeRef = parseSkillRef('exa:search');
    const manifest: NormalizedManifest = {
      source: 'github:firatcand/founder-skills',
      skills: [{ name: 'pricing', ref: 'main' }],
    };
    const lockfile: Lockfile = {
      version: 1,
      source: manifest.source,
      skills: [{
        name: 'pricing',
        ref: 'v2',
        contentHash: `sha256:${'a'.repeat(64)}`,
        tools: ['claude'],
      }],
    };
    assert.equal(errorRecord(() => buildVendorSkillMap({
      workspaceRoot: root,
      skillRefs: [nativeRef],
      enabledHosts: ['claude'],
      manifest,
      lockfile,
      generatorVersion: '1.8.1',
    })).code, 'SKILL_REF_UNMAPPED');
  });
});

test('project hashing is confined, symlink-safe, and bounded by depth, entries, and bytes', () => {
  withWorkspace((root) => {
    materialize(root, 'claude', 'pricing');
    const skillDir = join(root, '.claude', 'skills', 'pricing');
    const external = join(root, 'outside');
    writeFileSync(external, 'outside');
    symlinkSync(external, join(skillDir, 'escape'));
    assert.equal(
      errorRecord(() => hashProjectSkillForHost({
        workspaceRoot: root,
        host: 'claude',
        skillName: 'pricing',
      })).code,
      'SYMLINK_COMPONENT',
    );
    rmSync(join(skillDir, 'escape'));

    mkdirSync(join(skillDir, 'one', 'two'), { recursive: true });
    writeFileSync(join(skillDir, 'one', 'two', 'file'), 'x');
    assert.equal(
      errorRecord(() => hashProjectSkillForHost({
        workspaceRoot: root,
        host: 'claude',
        skillName: 'pricing',
        limits: { maxDepth: 1 },
      })).code,
      'READ_LIMIT_EXCEEDED',
    );
    assert.equal(
      errorRecord(() => hashProjectSkillForHost({
        workspaceRoot: root,
        host: 'claude',
        skillName: 'pricing',
        limits: { maxEntries: 1 },
      })).code,
      'READ_LIMIT_EXCEEDED',
    );
    assert.equal(
      errorRecord(() => hashProjectSkillForHost({
        workspaceRoot: root,
        host: 'claude',
        skillName: 'pricing',
        limits: { maxBytes: 1 },
      })).code,
      'READ_LIMIT_EXCEEDED',
    );
    assert.equal(readFileSync(external, 'utf8'), 'outside');
  });
});

test('length-prefixed tree framing separates the exact NUL delimiter collision', () => {
  withWorkspace((root) => {
    const directory = join(root, '.claude', 'skills', 'collision');
    mkdirSync(directory, { recursive: true });
    const oneFile = [{
      path: 'a',
      content: Buffer.from('prefix\0b\0data'),
    }];
    const twoFiles = [
      { path: 'a', content: Buffer.from('prefix') },
      { path: 'b', content: Buffer.from('data') },
    ];
    assert.equal(ambiguousDelimiterHash(oneFile), ambiguousDelimiterHash(twoFiles));

    writeFileSync(join(directory, 'a'), oneFile[0]!.content);
    const oneFileHash = hashProjectSkillForHost({
      workspaceRoot: root,
      host: 'claude',
      skillName: 'collision',
    }).contentHash;

    writeFileSync(join(directory, 'a'), twoFiles[0]!.content);
    writeFileSync(join(directory, 'b'), twoFiles[1]!.content);
    const twoFileHash = hashProjectSkillForHost({
      workspaceRoot: root,
      host: 'claude',
      skillName: 'collision',
    }).contentHash;
    assert.notEqual(oneFileHash, twoFileHash);
  });
});

test('strict lock reading preserves skill_ref and rejects any malformed present file', () => {
  withWorkspace((root) => {
    assert.equal(readLockfile(root), null);
    const skillRef = parseSkillRef('founder-skills:pricing');
    const lock: Lockfile = {
      version: 1,
      source: 'github:firatcand/founder-skills',
      skills: [{
        name: 'pricing',
        ref: 'main',
        contentHash: `sha256:${'a'.repeat(64)}`,
        tools: ['codex', 'claude'],
        skill_ref: skillRef,
      }],
    };
    writeLockfile(root, lock);
    assert.deepEqual(readLockfile(root), {
      ...lock,
      skills: [{ ...lock.skills[0]!, tools: ['claude', 'codex'] }],
    });

    writeFileSync(join(root, 'founder-skills.lock'), 'version: 1\nsource: nope\nskills: []\n');
    assert.equal(errorRecord(() => readLockfile(root)).code, 'SKILL_REF_INVALID');

    writeFileSync(
      join(root, 'founder-skills.lock'),
      `version: 1\nsource: github:owner/repository\nskills:\n  - name: pricing\n    ref: !unreviewed main\n    contentHash: sha256:${'a'.repeat(64)}\n    tools: [claude]\n`,
    );
    assert.equal(errorRecord(() => readLockfile(root)).code, 'SKILL_REF_INVALID');

    const token = `sk-${'Ab9_'.repeat(6)}`;
    writeFileSync(
      join(root, 'founder-skills.lock'),
      `# ${token}\nversion: 1\nsource: github:owner/repository\nskills: []\n`,
    );
    const secret = errorRecord(() => readLockfile(root));
    assert.equal(secret.code, 'SECRET_MATERIAL_FORBIDDEN');
    assert.equal(secret.rendered.includes(token), false);
    assert.equal(secret.rendered.includes('sha256:'), false);
  });
});
