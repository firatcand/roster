import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKED_IN_HOST_ATTESTATIONS,
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CLAUDE_PROJECT_RULE_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  CODEX_ROSTER_SKILL_PATH,
  createGeneratedManifest,
  GENERATED_MANIFEST_PATH,
  installV2ProjectActivation,
  inspectGeneratedActivationState,
  parseGeneratedMarkdown,
  parseGeneratedManifest,
  renderCodexRosterSkill,
  renderGeneratedMarkdown,
  renderGeneratedManifest,
  renderRosterBootstrap,
  resolveActivationAssurance,
  resolveCurrentHostActivationAssurance,
  updateV2ProjectActivations,
  validateGeneratedArtifacts,
  type HostActivationAttestation,
} from '../src/lib/generated-artifacts.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import { parseWorkspaceRegistry } from '../src/lib/workspace-record.ts';
import { realWorkspaceDurabilityFs } from '../src/lib/workspace-io.ts';

const passed: HostActivationAttestation = {
  schema_version: 1,
  fixture_id: 'codex-root-agents-v1',
  host: 'codex',
  artifact: 'codex-project-instructions',
  tested_host_version: '1.2.3',
  minimum_host_version: '1.2.0',
  maximum_host_version_exclusive: '1.3.0',
  outcome: 'passed',
};

const claudePassed: HostActivationAttestation = {
  schema_version: 1,
  fixture_id: 'claude-project-instructions-v1',
  host: 'claude',
  artifact: 'claude-project-instructions',
  tested_host_version: '2.1.0',
  minimum_host_version: '2.1.0',
  maximum_host_version_exclusive: '2.2.0',
  outcome: 'passed',
};

test('ROSTER.md renderer is deterministic and detects ownership-header or body drift', () => {
  const rendered = renderRosterBootstrap();
  assert.equal(renderRosterBootstrap(), rendered);
  const parsed = parseGeneratedMarkdown(rendered);
  assert.ok(parsed?.valid);
  assert.equal(parsed.header.artifact, 'roster-bootstrap');

  const headerEdited = rendered.replace('supported_host_versions: *', 'supported_host_versions: >=1');
  assert.equal(parseGeneratedMarkdown(headerEdited)?.valid, false);
  const bodyEdited = rendered.replace('context and scaffolding', 'runtime and scaffolding');
  assert.equal(parseGeneratedMarkdown(bodyEdited)?.valid, false);
});

test('activation assurance never claims auto-load without a matching passing attestation', () => {
  const absent = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-project-instructions',
    hostVersion: '1.2.3',
  });
  assert.equal(absent.assurance, 'advisory-manual');

  const outOfRange = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-project-instructions',
    hostVersion: '1.3.0',
    attestations: [passed],
  });
  assert.equal(outOfRange.assurance, 'advisory-manual');

  const disconfirmed = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-project-instructions',
    hostVersion: '1.2.3',
    attestations: [{ ...passed, outcome: 'disconfirmed' }],
  });
  assert.equal(disconfirmed.assurance, 'advisory-manual');

  const matched = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-project-instructions',
    hostVersion: 'codex-cli 1.2.3',
    attestations: [passed],
  });
  assert.equal(matched.assurance, 'auto-loaded');
  assert.equal(matched.attestationFixture, passed.fixture_id);
});

test('current host assurance is derived from actual activation files and the local host version', () => {
  const fx = fixture();
  try {
    const installed = installV2ProjectActivation({
      root: fx.root,
      host: 'codex',
      hostVersion: 'codex-cli 0.144.1',
    });
    assert.ok(installed.manifest);
    assert.equal(
      resolveCurrentHostActivationAssurance(installed.manifest!, 'codex', 'codex-cli 0.144.1'),
      'auto-loaded',
    );
    assert.equal(resolveCurrentHostActivationAssurance(installed.manifest!, 'codex'), 'advisory-manual');
    assert.equal(
      resolveCurrentHostActivationAssurance(installed.manifest!, 'codex', 'codex-cli 0.144.2'),
      'advisory-manual',
    );

    const rootPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const parsed = parseGeneratedMarkdown(readFileSync(rootPath, 'utf8'))!;
    const { content_hash: _contentHash, ...header } = parsed.header;
    writeFileSync(rootPath, renderGeneratedMarkdown(header, `${parsed.body}\nForged instruction.\n`, parsed.prefix));
    const current = inspectGeneratedActivationState(fx.root).manifest;
    assert.equal(
      resolveCurrentHostActivationAssurance(current, 'codex', 'codex-cli 0.144.1'),
      'advisory-manual',
    );
  } finally {
    fx.cleanup();
  }
});

test('checked-in host attestations are exact-patch and backed by explicit fixture paths', () => {
  const expected = [
    {
      host: 'claude' as const,
      artifact: 'claude-project-instructions' as const,
      version: '2.1.220',
      nextPatch: '2.1.221',
      marker: 'ROSTER_CLAUDE_PROJECT_LOADED',
    },
    {
      host: 'claude' as const,
      artifact: 'claude-project-rule' as const,
      version: '2.1.220',
      nextPatch: '2.1.221',
      marker: 'ROSTER_CLAUDE_RULE_LOADED',
    },
    {
      host: 'codex' as const,
      artifact: 'codex-project-instructions' as const,
      version: '0.144.1',
      nextPatch: '0.144.2',
      marker: 'ROSTER_CODEX_PROJECT_LOADED',
    },
  ];
  assert.equal(CHECKED_IN_HOST_ATTESTATIONS.length, expected.length);
  for (const fixture of expected) {
    const assurance = resolveActivationAssurance({
      host: fixture.host,
      artifact: fixture.artifact,
      hostVersion: fixture.version,
    });
    assert.equal(assurance.assurance, 'auto-loaded');
    assert.ok(assurance.attestationFixture);
    const fixturePath = assurance.attestationFixture!.replace(/@[^@]+$/, '');
    assert.match(readFileSync(fixturePath, 'utf8'), new RegExp(fixture.marker));
    assert.equal(resolveActivationAssurance({
      host: fixture.host,
      artifact: fixture.artifact,
      hostVersion: fixture.nextPatch,
    }).assurance, 'advisory-manual');
  }
  assert.equal(resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-roster-skill',
    hostVersion: '0.144.1',
  }).assurance, 'advisory-manual');
  assert.equal(resolveActivationAssurance({
    host: 'claude',
    artifact: 'claude-project-instructions',
    hostVersion: '2.1.220 (Claude Code)',
  }).assurance, 'auto-loaded');
  for (const prerelease of [
    '2.1.220-beta.1',
    'Claude Code 2.1.220-nightly',
    '2.1.220+local',
    '2.1.220_nightly',
    '2.1.220-beta.1 (base 2.1.220)',
  ]) {
    assert.equal(resolveActivationAssurance({
      host: 'claude',
      artifact: 'claude-project-instructions',
      hostVersion: prerelease,
    }).assurance, 'advisory-manual');
  }
});

test('matching attestations are recorded in generated headers and the portable manifest', () => {
  const fx = fixture();
  try {
    const result = installV2ProjectActivation({
      root: fx.root,
      host: 'codex',
      hostVersion: 'codex-cli 1.2.3',
      attestations: [passed],
    });
    assert.equal(result.ok, true);
    assert.equal(result.assurance, 'auto-loaded');

    const generated = parseGeneratedMarkdown(
      readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'),
    );
    assert.ok(generated?.valid);
    assert.equal(generated.header.activation_assurance, 'auto-loaded');
    assert.equal(generated.header.supported_host_versions, '>=1.2.0 <1.3.0');
    assert.equal(generated.header.attestation_fixture, passed.fixture_id);

    const manifest = parseGeneratedManifest(
      readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8'),
    );
    assert.ok(manifest);
    assert.equal(manifest.hosts.codex?.activation_assurance, 'auto-loaded');
    assert.equal(manifest.hosts.codex?.attestation_fixture, passed.fixture_id);
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH &&
      /current canonical renderer or attestation/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('sequential host install and update retain prior attested bytes when every host version is detected', () => {
  const fx = fixture();
  try {
    const attestations = [claudePassed, passed];
    const claude = installV2ProjectActivation({
      root: fx.root,
      host: 'claude',
      hostVersions: { claude: 'claude-code 2.1.0' },
      attestations,
    });
    assert.equal(claude.ok, true);
    assert.equal(claude.assurance, 'auto-loaded');
    const claudeBefore = readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8');

    const codex = installV2ProjectActivation({
      root: fx.root,
      host: 'codex',
      hostVersions: { claude: 'claude-code 2.1.0', codex: 'codex-cli 1.2.3' },
      attestations,
    });
    assert.equal(codex.ok, true);
    assert.equal(codex.assurance, 'auto-loaded');
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'), claudeBefore);

    const updated = updateV2ProjectActivations({
      root: fx.root,
      hostVersions: { claude: 'claude-code 2.1.0', codex: 'codex-cli 1.2.3' },
      attestations,
    });
    assert.equal(updated.ok, true);
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'), claudeBefore);
    assert.equal(updated.manifest?.hosts.claude?.activation_assurance, 'auto-loaded');
    assert.equal(updated.manifest?.hosts.codex?.activation_assurance, 'auto-loaded');
  } finally {
    fx.cleanup();
  }
});

test('Codex fallback remains a valid frontmatter-first skill and hashes all authored bytes', () => {
  const assurance = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-roster-skill',
  });
  const rendered = renderCodexRosterSkill(assurance);
  assert.match(rendered, /^---\nname: roster\n/);
  assert.ok(parseGeneratedMarkdown(rendered)?.valid);
  assert.equal(parseGeneratedMarkdown(rendered.replace('name: roster', 'name: changed'))?.valid, false);
});

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-generated-'));
  writeFileSync(join(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: generated-test',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function at(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function disableAllHosts(root: string): void {
  writeFileSync(at(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: generated-test',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
}

test('v2 Claude install is standalone, deterministic, and enables the host last', () => {
  const fx = fixture();
  try {
    const result = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(result.ok, true);
    assert.equal(result.assurance, 'advisory-manual');
    assert.equal(result.registryUpdated, true);
    assert.ok(parseGeneratedMarkdown(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'))?.valid);
    const registry = parseWorkspaceRegistry(readFileSync(at(fx.root, 'roster.yaml'), 'utf8'));
    assert.equal(registry.hosts.claude, 'enabled');
    const manifestText = readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8');
    const manifest = parseGeneratedManifest(manifestText);
    assert.ok(manifest);
    assert.equal(manifest.hosts.claude?.activation_assurance, 'advisory-manual');
    assert.doesNotMatch(manifestText, /generated_at|\/Users\/|roster-generated-/);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('project install restores manifest membership when the registry compare-and-swap loses a race', () => {
  const fx = fixture();
  try {
    const registryPath = at(fx.root, 'roster.yaml');
    const racedRegistry = `${readFileSync(registryPath, 'utf8')}# external edit\n`;
    let raced = false;
    const racingAttestation: HostActivationAttestation = {
      schema_version: 1,
      fixture_id: 'codex-racing-fixture',
      get host(): 'codex' {
        if (!raced) {
          raced = true;
          writeFileSync(registryPath, racedRegistry);
        }
        return 'codex';
      },
      artifact: 'codex-project-instructions',
      tested_host_version: '1.2.3',
      minimum_host_version: '1.2.0',
      maximum_host_version_exclusive: '1.3.0',
      outcome: 'passed',
    };

    assert.throws(
      () => installV2ProjectActivation({
        root: fx.root,
        host: 'codex',
        hostVersion: '1.2.3',
        attestations: [racingAttestation],
      }),
      (error: unknown) => isWorkspaceFailure(error) && error.code === 'WRITE_CONFLICT',
    );

    assert.equal(readFileSync(registryPath, 'utf8'), racedRegistry);
    const manifest = parseGeneratedManifest(readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8'));
    assert.ok(manifest);
    assert.deepEqual(manifest.hosts, {});
    assert.equal(existsSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH)), false);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.equal(manifest.files.some((entry) => entry.host === 'codex'), false);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('failed new-host registration restores pre-existing generated bytes after a safe update attempt', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const registryPath = at(fx.root, 'roster.yaml');
    const rootPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const skillPath = at(fx.root, CODEX_ROSTER_SKILL_PATH);
    const rootBefore = readFileSync(rootPath);
    const skillBefore = readFileSync(skillPath);
    disableAllHosts(fx.root);
    assert.equal(updateV2ProjectActivations({ root: fx.root }).ok, true);
    writeFileSync(rootPath, rootBefore);
    writeFileSync(skillPath, skillBefore);

    const racedRegistry = `${readFileSync(registryPath, 'utf8')}# external edit\n`;
    let raced = false;
    const racingAttestation: HostActivationAttestation = {
      ...passed,
      get host(): 'codex' {
        if (!raced) {
          raced = true;
          writeFileSync(registryPath, racedRegistry);
        }
        return 'codex';
      },
    };
    assert.throws(
      () => installV2ProjectActivation({
        root: fx.root,
        host: 'codex',
        hostVersion: '1.2.3',
        attestations: [racingAttestation],
      }),
      (error: unknown) => isWorkspaceFailure(error) && error.code === 'WRITE_CONFLICT',
    );

    assert.deepEqual(readFileSync(rootPath), rootBefore);
    assert.deepEqual(readFileSync(skillPath), skillBefore);
    assert.equal(readFileSync(registryPath, 'utf8'), racedRegistry);
    assert.deepEqual(parseGeneratedManifest(
      readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8'),
    )?.hosts, {});
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.message === `Generated activation '${CODEX_PROJECT_INSTRUCTIONS_PATH}' remains for disabled host 'codex'.`
    ));
  } finally {
    fx.cleanup();
  }
});

test('post-rename registry durability failure restores the pre-call registry and activation', () => {
  const fx = fixture();
  try {
    let failed = false;
    const durabilityFs = {
      ...realWorkspaceDurabilityFs,
      fsyncSync(fd: number): void {
        if (!failed) {
          failed = true;
          const error = new Error('injected post-rename durability failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        realWorkspaceDurabilityFs.fsyncSync(fd);
      },
    };
    assert.throws(
      () => installV2ProjectActivation({
        root: fx.root,
        host: 'codex',
        registryDurabilityFs: durabilityFs,
      }),
      (error: unknown) =>
        isWorkspaceFailure(error) &&
        error.code === 'ATOMIC_PUBLICATION_UNSUPPORTED' &&
        error.details.cause === 'EIO',
    );

    assert.deepEqual(Object.keys(parseWorkspaceRegistry(
      readFileSync(at(fx.root, 'roster.yaml'), 'utf8'),
    ).hosts), []);
    assert.equal(existsSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH)), false);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    const manifest = parseGeneratedManifest(
      readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8'),
    );
    assert.deepEqual(Object.keys(manifest?.hosts ?? {}), []);
    assert.deepEqual(manifest?.files.map((entry) => entry.path), ['ROSTER.md']);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('failed Claude registration restores a removed pre-existing generated fallback', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude'), { recursive: true });
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), '# My Claude policy\n');
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    const fallbackPath = at(fx.root, CLAUDE_PROJECT_RULE_PATH);
    const fallbackBefore = readFileSync(fallbackPath);
    disableAllHosts(fx.root);
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));

    const registryPath = at(fx.root, 'roster.yaml');
    const racedRegistry = `${readFileSync(registryPath, 'utf8')}# external edit\n`;
    let raced = false;
    const racingAttestation: HostActivationAttestation = {
      ...claudePassed,
      get host(): 'claude' {
        if (!raced) {
          raced = true;
          writeFileSync(registryPath, racedRegistry);
        }
        return 'claude';
      },
    };

    assert.throws(
      () => installV2ProjectActivation({
        root: fx.root,
        host: 'claude',
        hostVersion: '2.1.0',
        attestations: [racingAttestation],
      }),
      (error: unknown) => isWorkspaceFailure(error) && error.code === 'WRITE_CONFLICT',
    );
    assert.equal(readFileSync(registryPath, 'utf8'), racedRegistry);
    assert.equal(existsSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH)), false);
    assert.deepEqual(readFileSync(fallbackPath), fallbackBefore);
    const manifest = parseGeneratedManifest(readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8'));
    assert.deepEqual(manifest?.hosts, {});
    assert.equal(manifest?.files.some((entry) => entry.path === CLAUDE_PROJECT_RULE_PATH), true);
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects manifest hosts that are not enabled in roster.yaml', () => {
  const fx = fixture();
  try {
    const registryPath = at(fx.root, 'roster.yaml');
    const initialRegistry = readFileSync(registryPath, 'utf8');
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    writeFileSync(registryPath, initialRegistry);

    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' &&
      diagnostic.message === 'Generated manifest host membership does not match roster.yaml.'
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects a re-hashed forged host assurance summary', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const original = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
    assert.ok(original?.hosts.codex);
    const { manifest_hash: _manifestHash, ...draft } = original;
    const forged = createGeneratedManifest({
      ...draft,
      hosts: {
        ...draft.hosts,
        codex: {
          ...original.hosts.codex,
          activation_assurance: 'auto-loaded',
          artifacts: [],
          attestation_fixture: 'forged-fixture',
        },
      },
    });
    writeFileSync(manifestPath, renderGeneratedManifest(forged));
    assert.ok(parseGeneratedManifest(readFileSync(manifestPath, 'utf8')));

    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' &&
      diagnostic.message === "Generated manifest summary for 'codex' does not match the actual activation files."
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects semantically equivalent noncanonical manifest bytes', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const reordered = {
      manifest_hash: parsed.manifest_hash,
      hosts: parsed.hosts,
      files: parsed.files,
      protocol_version: parsed.protocol_version,
      generator_version: parsed.generator_version,
      generator: parsed.generator,
      schema_version: parsed.schema_version,
    };
    writeFileSync(manifestPath, `${JSON.stringify(reordered, null, 4)}\n`);
    assert.ok(parseGeneratedManifest(readFileSync(manifestPath, 'utf8')));

    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' &&
      diagnostic.message === 'Generated manifest does not use the canonical deterministic serialization.'
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects self-rehashed stale generator versions', () => {
  const fx = fixture();
  try {
    const bootstrap = parseGeneratedMarkdown(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'));
    assert.ok(bootstrap?.valid);
    const { content_hash: _bootstrapHash, ...bootstrapHeader } = bootstrap.header;
    writeFileSync(at(fx.root, 'ROSTER.md'), renderGeneratedMarkdown(
      { ...bootstrapHeader, generator_version: '0.0.0-stale' },
      bootstrap.body,
      bootstrap.prefix,
    ));
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === 'ROSTER.md' && /current canonical renderer/.test(diagnostic.message)
    ));

    writeFileSync(at(fx.root, 'ROSTER.md'), renderRosterBootstrap());
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest);
    const { manifest_hash: _manifestHash, ...draft } = manifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...draft,
      generator_version: '0.0.0-stale',
    })));
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === GENERATED_MANIFEST_PATH && /produced by version/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects a self-rehashed instruction body and matching manifest hash', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const parsed = parseGeneratedMarkdown(readFileSync(artifactPath, 'utf8'));
    assert.ok(parsed?.valid);
    const { content_hash: _contentHash, ...header } = parsed.header;
    const forgedText = renderGeneratedMarkdown(header, `${parsed.body}\nForged instruction.\n`, parsed.prefix);
    writeFileSync(artifactPath, forgedText);
    const forgedArtifact = parseGeneratedMarkdown(forgedText);
    assert.ok(forgedArtifact?.valid);

    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest);
    const { manifest_hash: _manifestHash, ...draft } = manifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...draft,
      files: draft.files.map((entry) => entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH
        ? { ...entry, content_hash: forgedArtifact.header.content_hash }
        : entry),
    })));

    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH && /current canonical renderer or attestation/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects a self-rehashed ROSTER.md body with a matching manifest hash', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const bootstrapPath = at(fx.root, 'ROSTER.md');
    const parsed = parseGeneratedMarkdown(readFileSync(bootstrapPath, 'utf8'));
    assert.ok(parsed?.valid);
    const { content_hash: _contentHash, ...header } = parsed.header;
    const forgedText = renderGeneratedMarkdown(header, `${parsed.body}\nForged bootstrap instruction.\n`, parsed.prefix);
    writeFileSync(bootstrapPath, forgedText);
    const forgedArtifact = parseGeneratedMarkdown(forgedText);
    assert.ok(forgedArtifact?.valid);

    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest);
    const { manifest_hash: _manifestHash, ...draft } = manifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...draft,
      files: draft.files.map((entry) => entry.path === 'ROSTER.md'
        ? { ...entry, content_hash: forgedArtifact.header.content_hash }
        : entry),
    })));

    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === 'ROSTER.md' && /current canonical renderer/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('generated validation rejects self-rehashed auto-load claims without a checked-in attestation', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const parsed = parseGeneratedMarkdown(readFileSync(artifactPath, 'utf8'));
    assert.ok(parsed?.valid);
    const { content_hash: _contentHash, ...header } = parsed.header;
    const forgedText = renderGeneratedMarkdown({
      ...header,
      activation_assurance: 'auto-loaded',
      supported_host_versions: '>=9.9.9 <9.9.10',
      attestation_fixture: 'forged-auto-load-fixture',
    }, parsed.body, parsed.prefix);
    writeFileSync(artifactPath, forgedText);
    const forgedArtifact = parseGeneratedMarkdown(forgedText);
    assert.ok(forgedArtifact?.valid);

    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest?.hosts.codex);
    const { manifest_hash: _manifestHash, ...draft } = manifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...draft,
      files: draft.files.map((entry) => entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH
        ? {
            ...entry,
            activation_assurance: 'auto-loaded',
            supported_host_versions: '>=9.9.9 <9.9.10',
            attestation_fixture: 'forged-auto-load-fixture',
            content_hash: forgedArtifact.header.content_hash,
          }
        : entry),
      hosts: {
        ...draft.hosts,
        codex: {
          ...manifest.hosts.codex,
          activation_assurance: 'auto-loaded',
          attestation_fixture: 'forged-auto-load-fixture',
        },
      },
    })));

    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH && /current canonical renderer or attestation/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('an existing host conflict does not block installing an unrelated host safely', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const codexPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const editedCodex = `${readFileSync(codexPath, 'utf8')}edited\n`;
    writeFileSync(codexPath, editedCodex);

    const claude = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(claude.ok, true);
    assert.equal(claude.registryUpdated, true);
    assert.ok(parseGeneratedMarkdown(
      readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'),
    )?.valid);
    assert.equal(readFileSync(codexPath, 'utf8'), editedCodex);
    assert.deepEqual(
      Object.keys(parseWorkspaceRegistry(readFileSync(at(fx.root, 'roster.yaml'), 'utf8')).hosts).sort(),
      ['claude', 'codex'],
    );
    assert.ok(claude.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('Claude install preserves authored primary instructions and uses the project rule fallback', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude'), { recursive: true });
    const authored = '# My Claude policy\n';
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), authored);
    const result = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authored);
    assert.ok(parseGeneratedMarkdown(readFileSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH), 'utf8'))?.valid);
    assert.equal(result.files.find((file) => file.path === CLAUDE_PROJECT_INSTRUCTIONS_PATH)?.status, 'preserved-authored');
  } finally {
    fx.cleanup();
  }
});

test('Claude install treats a documented generated marker as authored policy', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude'), { recursive: true });
    const authored = '# My Claude policy\n\nDocument `<!-- roster:generated` for reviewers.\n';
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), authored);

    const result = installV2ProjectActivation({ root: fx.root, host: 'claude' });

    assert.equal(result.ok, true);
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authored);
    assert.equal(
      result.files.find((file) => file.path === CLAUDE_PROJECT_INSTRUCTIONS_PATH)?.status,
      'preserved-authored',
    );
    assert.ok(parseGeneratedMarkdown(readFileSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH), 'utf8'))?.valid);
  } finally {
    fx.cleanup();
  }
});

test('Claude update removes a canonical fallback after the authored primary is removed', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude'), { recursive: true });
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), '# My Claude policy\n');
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    assert.equal(existsSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH)), true);
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.ok(parseGeneratedMarkdown(
      readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'),
    )?.valid);
    assert.equal(existsSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH)), false);
    assert.equal(updated.results[0]?.files.some((file) =>
      file.path === CLAUDE_PROJECT_RULE_PATH && file.status === 'removed'
    ), true);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('Codex install preserves authored AGENTS.md and installs a frontmatter-valid advisory skill', () => {
  const fx = fixture();
  try {
    const authored = '# Company Codex policy\n';
    writeFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), authored);
    const result = installV2ProjectActivation({ root: fx.root, host: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(result.assurance, 'advisory-manual');
    assert.equal(readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authored);
    const skill = readFileSync(at(fx.root, CODEX_ROSTER_SKILL_PATH), 'utf8');
    assert.match(skill, /^---\nname: roster\n/);
    assert.ok(parseGeneratedMarkdown(skill)?.valid);
  } finally {
    fx.cleanup();
  }
});

test('Codex install treats a documented generated marker as authored policy', () => {
  const fx = fixture();
  try {
    const authored = '# Company Codex policy\n\nDocument `<!-- roster:generated` for reviewers.\n';
    writeFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), authored);

    const result = installV2ProjectActivation({ root: fx.root, host: 'codex' });

    assert.equal(result.ok, true);
    assert.equal(result.assurance, 'advisory-manual');
    assert.equal(readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authored);
    assert.equal(
      result.files.find((file) => file.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.status,
      'preserved-authored',
    );
    assert.ok(parseGeneratedMarkdown(readFileSync(at(fx.root, CODEX_ROSTER_SKILL_PATH), 'utf8'))?.valid);
  } finally {
    fx.cleanup();
  }
});

test('Codex install never adopts or overwrites a valid generated artifact copied to AGENTS.md', () => {
  const fx = fixture();
  try {
    const copiedBootstrap = readFileSync(at(fx.root, 'ROSTER.md'), 'utf8');
    writeFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), copiedBootstrap);

    const result = installV2ProjectActivation({ root: fx.root, host: 'codex' });
    assert.equal(result.ok, false);
    assert.equal(result.registryUpdated, false);
    assert.equal(readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'), copiedBootstrap);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('Codex install preserves a wrong-type root collision and rolls back its fallback', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH));

    const result = installV2ProjectActivation({ root: fx.root, host: 'codex' });
    assert.equal(result.ok, false);
    assert.equal(existsSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH)), true);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.deepEqual(Object.keys(parseWorkspaceRegistry(
      readFileSync(at(fx.root, 'roster.yaml'), 'utf8'),
    ).hosts), []);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'NOT_REGULAR_FILE' && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('v2 update never overwrites ROSTER.md with bytes owned by another generated artifact', () => {
  const fx = fixture();
  try {
    const wrongArtifact = renderCodexRosterSkill(resolveActivationAssurance({
      host: 'codex',
      artifact: 'codex-roster-skill',
    }));
    writeFileSync(at(fx.root, 'ROSTER.md'), wrongArtifact);

    const result = updateV2ProjectActivations({ root: fx.root });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), wrongArtifact);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === 'ROSTER.md'
    ));
  } finally {
    fx.cleanup();
  }
});

test('Claude fallback never overwrites a valid generated artifact owned by another target path', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude/rules'), { recursive: true });
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), '# Authored Claude policy\n');
    const wrongArtifact = renderCodexRosterSkill(resolveActivationAssurance({
      host: 'codex',
      artifact: 'codex-roster-skill',
    }));
    writeFileSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH), wrongArtifact);

    const result = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH), 'utf8'), wrongArtifact);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CLAUDE_PROJECT_RULE_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('v2 update preserves an edited generated root while refreshing unrelated fallback artifacts', () => {
  const fx = fixture();
  try {
    const installed = installV2ProjectActivation({ root: fx.root, host: 'codex' });
    assert.equal(installed.ok, true);
    const edited = `${readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8')}\nUser edit\n`;
    writeFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), edited);
    unlinkSync(at(fx.root, CODEX_ROSTER_SKILL_PATH));

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.equal(updated.results.find((result) => result.host === 'codex')?.assurance, 'advisory-manual');
    assert.equal(updated.manifest?.hosts.codex?.activation_assurance, 'advisory-manual');
    assert.equal(readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'), edited);
    assert.ok(parseGeneratedMarkdown(readFileSync(at(fx.root, CODEX_ROSTER_SKILL_PATH), 'utf8'))?.valid);
    assert.ok(updated.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('v2 update accepts a bounded longer mixed-version predecessor and restores canonical bytes', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const canonical = readFileSync(artifactPath, 'utf8');
    const parsed = parseGeneratedMarkdown(canonical);
    assert.ok(parsed?.valid);
    const { content_hash: _contentHash, ...header } = parsed.header;
    writeFileSync(artifactPath, renderGeneratedMarkdown(
      { ...header, generator_version: '0.0.0-prior' },
      `${parsed.body}\n${'Prior generated guidance.\n'.repeat(2_000)}`,
      parsed.prefix,
    ));

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(readFileSync(artifactPath, 'utf8'), canonical);
    assert.equal(updated.diagnostics.some((diagnostic) => diagnostic.code === 'READ_LIMIT_EXCEEDED'), false);
  } finally {
    fx.cleanup();
  }
});

test('v2 update removes canonical activation files when an authored registry disables a host', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    disableAllHosts(fx.root);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(existsSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH)), false);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.deepEqual(updated.manifest?.hosts, {});
    assert.equal(updated.manifest?.files.some((entry) => entry.host === 'codex'), false);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('v2 update refuses an authored host without an activation contract', () => {
  const fx = fixture();
  try {
    writeFileSync(at(fx.root, 'roster.yaml'), [
      'schema_version: 2',
      'workspace_id: generated-test',
      'tool_uses: []',
      'functions: {}',
      'hosts:',
      '  gemini: enabled',
      '',
    ].join('\n'));

    assert.throws(
      () => updateV2ProjectActivations({ root: fx.root }),
      (error: unknown) => isWorkspaceFailure(error) && error.code === 'UNKNOWN_FIELD',
    );
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), renderRosterBootstrap());
  } finally {
    fx.cleanup();
  }
});

test('v2 update preserves edited disabled-host bytes and reports the stale activation', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const edited = `${readFileSync(artifactPath, 'utf8')}User edit\n`;
    writeFileSync(artifactPath, edited);
    disableAllHosts(fx.root);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.equal(readFileSync(artifactPath, 'utf8'), edited);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.deepEqual(updated.manifest?.hosts, {});
    assert.equal(updated.manifest?.files.some((entry) => entry.host === 'codex'), false);
    assert.ok(updated.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    ));
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.message === `Generated activation '${CODEX_PROJECT_INSTRUCTIONS_PATH}' remains for disabled host 'codex'.`
    ));
  } finally {
    fx.cleanup();
  }
});

test('v2 update preserves a self-hashed noncanonical disabled-host shadow', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const parsed = parseGeneratedMarkdown(readFileSync(artifactPath, 'utf8'));
    assert.ok(parsed?.valid);
    const { content_hash: _contentHash, ...header } = parsed.header;
    const stale = renderGeneratedMarkdown(
      { ...header, generator_version: '0.0.0-prior' },
      parsed.body,
      parsed.prefix,
    );
    writeFileSync(artifactPath, stale);
    disableAllHosts(fx.root);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.equal(readFileSync(artifactPath, 'utf8'), stale);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.ok(updated.manifest?.files.some((entry) =>
      entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH && entry.host === 'codex'
    ));
    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.message === `Generated activation '${CODEX_PROJECT_INSTRUCTIONS_PATH}' remains for disabled host 'codex'.`
    ));
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH &&
      /current canonical renderer or attestation/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

test('v2 update reconstructs a missing manifest only from valid generated headers', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    unlinkSync(at(fx.root, GENERATED_MANIFEST_PATH));
    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.ok(parseGeneratedManifest(readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8')));
  } finally {
    fx.cleanup();
  }
});

test('v2 update refuses manifest reconstruction when any claimed generated header is edited', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    unlinkSync(at(fx.root, GENERATED_MANIFEST_PATH));
    const skillPath = at(fx.root, CODEX_ROSTER_SKILL_PATH);
    writeFileSync(skillPath, `${readFileSync(skillPath, 'utf8')}edited\n`);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.equal(updated.manifest, null);
    assert.equal(existsSync(at(fx.root, GENERATED_MANIFEST_PATH)), false);
    assert.ok(updated.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_ROSTER_SKILL_PATH
    ));
  } finally {
    fx.cleanup();
  }
});
