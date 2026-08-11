import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKED_IN_HOST_ATTESTATIONS,
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CLAUDE_PROJECT_RULE_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  CODEX_ROSTER_SKILL_PATH,
  createGeneratedManifest,
  detectGeneratedShadows,
  GENERATED_MANIFEST_PATH,
  HOST_ADAPTER_LIFECYCLE_CAPABILITIES,
  installV2ProjectActivation,
  inspectGeneratedAdapterMetadata,
  inspectGeneratedActivationState,
  isBlockingGeneratedShadow,
  parseGeneratedMarkdown,
  parseGeneratedManifest,
  renderClaudeProjectInstructions,
  renderCodexProjectInstructions,
  renderCodexRosterSkill,
  renderGeneratedMarkdown,
  renderGeneratedManifest,
  renderRosterBootstrap,
  resolveActivationAssurance,
  resolveCurrentHostActivationCapability,
  resolveCurrentHostActivationAssurance,
  updateV2ProjectActivations,
  validateGeneratedArtifacts,
  type HostActivationAttestation,
} from '../src/lib/generated-artifacts.ts';
import { detectAuthoredSecretMaterial } from '../src/lib/authored-secret-detector.ts';
import { CONTEXT_TRUST_CLASSES } from '../src/lib/context-trust.ts';
import { diagnosticForPathFailure } from '../src/lib/internal/generated-path-diagnostic.ts';
import {
  isWorkspaceFailure,
  WORKSPACE_DIAGNOSTIC_CODES,
  workspaceFailure,
} from '../src/lib/workspace-diagnostics.ts';
import { parseWorkspaceRegistry } from '../src/lib/workspace-record.ts';
import { realWorkspaceDurabilityFs } from '../src/lib/workspace-io.ts';
import { getPackageVersion } from '../src/lib/paths.ts';

const passed: HostActivationAttestation = {
  schema_version: 1,
  fixture_id: 'codex-root-agents-v1',
  host: 'codex',
  artifact: 'codex-project-instructions',
  tested_host_version: '1.2.3',
  minimum_host_version: '1.2.0',
  maximum_host_version_exclusive: '1.3.0',
  outcome: 'passed',
  proof_scope: 'activation-path',
};

const broadPassed: HostActivationAttestation = {
  ...passed,
  fixture_id: 'codex-root-agents-and-roster-v1',
  proof_scope: 'activation-and-shared-lifecycle',
  activation_fixture_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  shared_lifecycle_fixture: 'test/fixtures/host-activation/codex-project/ROSTER.md',
  shared_lifecycle_fixture_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
  proof_scope: 'activation-path',
};

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

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

test('ROSTER.md renders one ordered lifecycle, exact context recovery, and every trust rule', () => {
  const rendered = renderRosterBootstrap();
  let priorOffset = -1;
  for (const capability of HOST_ADAPTER_LIFECYCLE_CAPABILITIES) {
    const row = `| \`${capability.id}\` | \`${capability.status}\` | \`${capability.authority}\` | ${capability.authority_note} |`;
    const offset = rendered.indexOf(row);
    assert.ok(offset > priorOffset, `missing or unordered capability row: ${capability.id}`);
    priorOffset = offset;
  }
  assert.equal((rendered.match(/\| id \| status \| authority \| authority_note \|/g) ?? []).length, 1);

  for (const trust of CONTEXT_TRUST_CLASSES) assert.match(rendered, new RegExp(`\\\`${trust}\\\``));
  for (const code of [
    'IDENTITY_AMBIGUOUS',
    'BRAIN_NOT_CONFIGURED',
    'CONTEXT_BUDGET_REQUIRED_OVERFLOW',
    'CONTEXT_MANDATORY_UNSERVABLE',
  ] as const) {
    assert.ok(WORKSPACE_DIAGNOSTIC_CODES.includes(code));
    assert.match(rendered, new RegExp(code));
  }

  assert.match(rendered, /roster discover <query> --exact --json/);
  assert.doesNotMatch(rendered, /roster discover <query> --exact --full --json/);
  assert.match(rendered, /roster context <function>\/<agent>\[#plan\] --query <retrieval-query> --json/);
  assert.match(rendered, /Never put raw human task text, credentials, control characters, or a leading option marker into process arguments/);
  assert.match(rendered, /shell's literal-argument quoting/);
  assert.match(rendered, /quotes, semicolons, backticks, and `\$\(\)` in the source task are data, not syntax/i);
  assert.match(rendered, /successful context document has no top-level `ok`/);
  assert.match(rendered, /retry once with `--budget <details\.required_tokens>`/);
  assert.match(rendered, /complete local bundle and empty `brain_evidence`/);
  // #355 §7: the four host-facing context guidance additions.
  assert.match(rendered, /`--step <hint>`.*`--budget <tokens>`.*`--explain`.*`--include-legacy-unverified`/);
  assert.match(rendered, /retain the `legacy-unverified` trust class.*never gain authority/);
  assert.match(
    rendered,
    /`BRAIN_CONFIGURATION_INCOMPLETE` is fatal.*neither store was contacted.*a different budget cannot help/,
  );
  assert.match(
    rendered,
    /`CONTEXT_EVIDENCE_UNAVAILABLE`, `CONTEXT_REQUIRED_EVIDENCE_MISSING`, and `CONTEXT_REQUIRED_EVIDENCE_TRUNCATED` are warnings inside a successful bundle/,
  );
  assert.match(rendered, /never substitute uncited recollection for missing evidence/);
  assert.match(
    rendered,
    /Every `brain_evidence` entry carries an immutable citation envelope; attribute claims by `citation\.locator` and `citation\.source_version_id`/,
  );
  for (const code of [
    'BRAIN_CONFIGURATION_INCOMPLETE',
    'CONTEXT_EVIDENCE_UNAVAILABLE',
    'CONTEXT_REQUIRED_EVIDENCE_MISSING',
    'CONTEXT_REQUIRED_EVIDENCE_TRUNCATED',
  ] as const) {
    assert.ok(WORKSPACE_DIAGNOSTIC_CODES.includes(code));
    assert.match(rendered, new RegExp(code));
  }
  // #359: the learning tail of the lifecycle is now a shipped instruction, not a
  // "missing in this release" placeholder, and its three seams are ordered.
  const recordOffset = rendered.indexOf('`roster brain record run`');
  const statusOffset = rendered.indexOf('`roster dream status --json`');
  const listOffset = rendered.indexOf('`roster dream candidates list --readiness-key <readiness_key> --json`');
  assert.ok(recordOffset > 0 && statusOffset > recordOffset && listOffset > statusOffset);
  assert.match(rendered, /`roster brain record feedback`/);
  assert.match(rendered, /again at the start of the next interaction that touches this workspace/);
  assert.match(rendered, /a check that never happened is recovered by the next one/);
  assert.match(rendered, /do not poll it, and do not arrange for it to run on a clock/);
  assert.match(rendered, /with no state filter so every decided candidate at that key is visible/);
  assert.match(rendered, /present that one and do not redraft/);
  assert.match(rendered, /`SAME_LESSON_FILE`/);
  assert.match(rendered, /`promote`, `reject`, or `retire`/);
  assert.doesNotMatch(rendered, /is `missing` in this release/);
  assert.match(rendered, /Do not call `roster run`.*`roster brain event` as substitutes/);
  assert.equal(
    (rendered.match(/`roster (?:run|schedule|pending|ops|brain save|brain event)`/g) ?? []).length,
    6,
  );
  assert.doesNotMatch(rendered, /(?:Use|Call|Run) `roster (?:run|schedule|pending|ops|brain (?:save|event))`/);
  assert.deepEqual(detectAuthoredSecretMaterial(rendered), []);
  assert.doesNotMatch(rendered, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/);
  assert.doesNotMatch(rendered, /Bright Data|\bExa\b|social-manager|opportunity-discovery/i);
  assert.doesNotMatch(rendered, /Claude|Codex|\.claude\/|AGENTS\.md|\.agents\//);
});

test('social-manager context fixture matches the current lifecycle independent of package version', () => {
  const fixtureBootstrap = parseGeneratedMarkdown(
    readFileSync(join('test/fixtures/social-manager-context', 'ROSTER.md'), 'utf8'),
  );
  const currentBootstrap = parseGeneratedMarkdown(renderRosterBootstrap());
  assert.ok(fixtureBootstrap?.valid);
  assert.ok(currentBootstrap?.valid);
  const {
    generator_version: _fixtureGeneratorVersion,
    content_hash: _fixtureContentHash,
    ...fixtureHeader
  } = fixtureBootstrap.header;
  const {
    generator_version: _currentGeneratorVersion,
    content_hash: _currentContentHash,
    ...currentHeader
  } = currentBootstrap.header;
  assert.deepEqual(fixtureHeader, currentHeader);
  assert.equal(fixtureBootstrap.prefix, currentBootstrap.prefix);
  assert.equal(fixtureBootstrap.body, currentBootstrap.body);
});

test('Claude and Codex wrappers are minimal pointers with no duplicated lifecycle contract', () => {
  const claudeAssurance = resolveActivationAssurance({
    host: 'claude',
    artifact: 'claude-project-instructions',
  });
  const codexAssurance = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-project-instructions',
  });
  const skillAssurance = resolveActivationAssurance({
    host: 'codex',
    artifact: 'codex-roster-skill',
  });
  const wrappers = [
    renderClaudeProjectInstructions('claude-project-instructions', claudeAssurance),
    renderClaudeProjectInstructions('claude-project-rule', claudeAssurance),
    renderCodexProjectInstructions(codexAssurance),
    renderCodexRosterSkill(skillAssurance),
  ];
  for (const wrapper of wrappers) {
    assert.ok(parseGeneratedMarkdown(wrapper)?.valid);
    assert.match(wrapper, /Read and follow `ROSTER\.md`/);
    assert.match(wrapper, /roster doctor --json/);
    assert.match(wrapper, /the human owns approval decisions/);
    assert.doesNotMatch(wrapper, /roster discover|roster context|IDENTITY_AMBIGUOUS|BRAIN_NOT_CONFIGURED/);
    assert.doesNotMatch(wrapper, /`roster (?:run|schedule|pending|ops|brain save|brain event)\b/);
    assert.doesNotMatch(wrapper, /plan executor|scheduler|provider router|approval authority/);
    assert.doesNotMatch(wrapper, /owns[^.]*human decisions/);
    for (const trust of CONTEXT_TRUST_CLASSES) assert.doesNotMatch(wrapper, new RegExp(`\\\`${trust}\\\``));
    assert.deepEqual(detectAuthoredSecretMaterial(wrapper), []);
    assert.doesNotMatch(wrapper, /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/);
  }
});

test('generated adapter metadata exposes canonical path and manifest states without content bytes', () => {
  const fx = fixture();
  try {
    const initial = inspectGeneratedAdapterMetadata(fx.root);
    assert.equal(initial.shared_bootstrap_canonical, true);
    assert.equal(initial.manifest.state, 'absent');
    assert.equal('content' in initial.paths[0]!, false);

    assert.equal(installV2ProjectActivation({
      root: fx.root,
      host: 'codex',
      hostVersion: 'codex-cli 0.144.1',
    }).ok, true);
    const canonical = inspectGeneratedAdapterMetadata(fx.root);
    assert.equal(canonical.manifest.state, 'canonical');
    assert.equal(
      canonical.paths.find((entry) => entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.state,
      'canonical-generated',
    );

    const agentsPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const originalAgents = readFileSync(agentsPath, 'utf8');
    const parsedAgents = parseGeneratedMarkdown(originalAgents)!;
    const { content_hash: _contentHash, ...agentsHeader } = parsedAgents.header;
    writeFileSync(
      agentsPath,
      renderGeneratedMarkdown(agentsHeader, `${parsedAgents.body}\nForged instruction.\n`, parsedAgents.prefix),
    );
    const forgedMetadata = inspectGeneratedAdapterMetadata(fx.root).paths.find((entry) =>
      entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH
    );
    assert.equal(forgedMetadata?.state, 'stale-generated');
    assert.equal(forgedMetadata?.activation_assurance, null);
    assert.equal(forgedMetadata?.supported_host_versions, null);
    assert.equal(forgedMetadata?.attestation_fixture, null);
    writeFileSync(agentsPath, originalAgents);

    const manifestPath = at(fx.root, GENERATED_MANIFEST_PATH);
    const canonicalManifest = readFileSync(manifestPath, 'utf8');
    const manifestObject = JSON.parse(canonicalManifest) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({
      manifest_hash: manifestObject['manifest_hash'],
      hosts: manifestObject['hosts'],
      files: manifestObject['files'],
      protocol_version: manifestObject['protocol_version'],
      generator_version: manifestObject['generator_version'],
      generator: manifestObject['generator'],
      schema_version: manifestObject['schema_version'],
    }, null, 4)}\n`);
    assert.equal(inspectGeneratedAdapterMetadata(fx.root).manifest.state, 'noncanonical');

    writeFileSync(manifestPath, canonicalManifest);
    const parsedManifest = parseGeneratedManifest(canonicalManifest)!;
    const { manifest_hash: _manifestHash, ...manifestDraft } = parsedManifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...manifestDraft,
      generator_version: '0.0.0-stale',
    })));
    assert.equal(inspectGeneratedAdapterMetadata(fx.root).manifest.state, 'stale-version');
  } finally {
    fx.cleanup();
  }
});

test('doctor-only capability fields never enter generated headers or manifest schema 1', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    const manifestText = readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8');
    assert.doesNotMatch(
      manifestText,
      /"activation_capability"|"lifecycle_capabilities"|"recorded_generator_version"|"shadows"|"versions"/,
    );
    const manifest = parseGeneratedManifest(manifestText);
    assert.equal(manifest?.schema_version, 1);
    assert.equal(manifest?.protocol_version, 2);
    for (const entry of manifest?.files ?? []) {
      const fileText = readFileSync(at(fx.root, entry.path), 'utf8');
      assert.doesNotMatch(fileText, /recorded_generator_version|lifecycle_capabilities/);
      const parsed = parseGeneratedMarkdown(fileText);
      assert.equal(parsed?.header.schema_version, '1');
      assert.equal(parsed?.header.protocol_version, '2');
      assert.equal('activation_capability' in (parsed?.header ?? {}), false);
      assert.equal('lifecycle_capabilities' in (parsed?.header ?? {}), false);
      assert.equal('recorded_generator_version' in (parsed?.header ?? {}), false);
    }
  } finally {
    fx.cleanup();
  }
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

test('supported capability binds to one broad proof and fails closed on narrow or ambiguous overlap', () => {
  const fx = fixture();
  try {
    const narrowInstall = installV2ProjectActivation({
      root: fx.root,
      host: 'codex',
      hostVersion: 'codex-cli 1.2.3',
      attestations: [passed],
    });
    assert.equal(narrowInstall.manifest?.files.find((entry) =>
      entry.artifact === 'codex-project-instructions'
    )?.attestation_fixture, passed.fixture_id);
    assert.equal(
      resolveCurrentHostActivationCapability(
        narrowInstall.manifest!,
        'codex',
        'codex-cli 1.2.3',
        [passed, broadPassed],
      ),
      'advisory',
    );

    const lateFx = fixture();
    try {
      const advisoryInstall = installV2ProjectActivation({ root: lateFx.root, host: 'codex' });
      assert.equal(advisoryInstall.manifest?.files.find((entry) =>
        entry.artifact === 'codex-project-instructions'
      )?.attestation_fixture, null);
      assert.equal(
        resolveCurrentHostActivationCapability(
          advisoryInstall.manifest!,
          'codex',
          'codex-cli 1.2.3',
          [broadPassed],
        ),
        'supported',
      );
      assert.equal(
        resolveCurrentHostActivationCapability(
          advisoryInstall.manifest!,
          'codex',
          'codex-cli 1.2.3',
          [broadPassed, { ...broadPassed, fixture_id: 'overlapping-broad-proof' }],
        ),
        'advisory',
      );
    } finally {
      lateFx.cleanup();
    }
  } finally {
    fx.cleanup();
  }
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
      sharedMarker: 'ROSTER_CLAUDE_PROJECT_SHARED_LIFECYCLE_LOADED',
    },
    {
      host: 'claude' as const,
      artifact: 'claude-project-rule' as const,
      version: '2.1.220',
      nextPatch: '2.1.221',
      marker: 'ROSTER_CLAUDE_RULE_LOADED',
      sharedMarker: 'ROSTER_CLAUDE_RULE_SHARED_LIFECYCLE_LOADED',
    },
    {
      host: 'codex' as const,
      artifact: 'codex-project-instructions' as const,
      version: '0.144.1',
      nextPatch: '0.144.2',
      marker: 'ROSTER_CODEX_PROJECT_LOADED',
      sharedMarker: 'ROSTER_CODEX_PROJECT_SHARED_LIFECYCLE_LOADED',
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
    const attestation = CHECKED_IN_HOST_ATTESTATIONS.find((candidate) =>
      candidate.fixture_id === assurance.attestationFixture
    );
    assert.ok(attestation);
    if (attestation.proof_scope !== 'activation-and-shared-lifecycle') {
      assert.fail(`checked-in passing attestation has narrow proof scope: ${attestation.fixture_id}`);
    }
    assert.equal(sha256File(fixturePath), attestation.activation_fixture_hash);
    assert.equal(sha256File(attestation.shared_lifecycle_fixture), attestation.shared_lifecycle_fixture_hash);
    assert.match(readFileSync(attestation.shared_lifecycle_fixture, 'utf8'), new RegExp(fixture.sharedMarker));
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
    assert.equal(
      resolveCurrentHostActivationAssurance(result.manifest!, 'codex', 'codex-cli 1.2.3', [passed]),
      'auto-loaded',
    );
    assert.equal(
      resolveCurrentHostActivationCapability(result.manifest!, 'codex', 'codex-cli 1.2.3', [passed]),
      'advisory',
    );

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

test('v2 update replaces a valid prior generated lifecycle body', () => {
  const fx = fixture();
  try {
    const current = parseGeneratedMarkdown(renderRosterBootstrap())!;
    const { content_hash: _contentHash, ...header } = current.header;
    const prior = renderGeneratedMarkdown(header, [
      '# Roster workspace',
      '',
      'Roster is the context and scaffolding layer for this repository. The host agent interprets plans and executes the work.',
      '',
      '- Read `roster.yaml` for the workspace registry.',
      '- Use `roster discover --json` to resolve purpose-built agents and records.',
      '- Resolve canonical tool `skill_ref` values through `.roster/vendor-skill-map.json`.',
      '- Use `roster scaffold` to add one explicitly requested authored record at a time.',
      '',
    ].join('\n'));
    assert.ok(parseGeneratedMarkdown(prior)?.valid);
    writeFileSync(at(fx.root, 'ROSTER.md'), prior);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), renderRosterBootstrap());
  } finally {
    fx.cleanup();
  }
});

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
      proof_scope: 'activation-path',
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

test('generated validation keeps bounded-read recovery specific and strips machine paths', () => {
  const fx = fixture();
  try {
    writeFileSync(at(fx.root, 'ROSTER.md'), Buffer.alloc((512 * 1024) + 1, 0x61));

    const diagnostic = validateGeneratedArtifacts(fx.root).find((entry) =>
      entry.code === 'READ_LIMIT_EXCEEDED' && entry.path === 'ROSTER.md'
    );
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /bounded read limit/);
    assert.match(diagnostic.remedy ?? '', /Reduce the file to the reported limit/);
    assert.equal(diagnostic.details['path'], 'ROSTER.md');
    assert.equal(diagnostic.details['maxBytes'], 512 * 1024);
    assert.equal(diagnostic.details['size'], (512 * 1024) + 1);
    assert.equal(JSON.stringify(diagnostic).includes(fx.root), false);
  } finally {
    fx.cleanup();
  }
});

test('EPERM atomic-publication failures retain filesystem-capability recovery', () => {
  const diagnostic = diagnosticForPathFailure(workspaceFailure(
    'ATOMIC_PUBLICATION_UNSUPPORTED',
    "Filesystem cannot atomically create '/private/secret/generated-manifest.json'.",
    'Move the workspace to a compatible filesystem.',
    { path: '/private/secret/generated-manifest.json', cause: 'EPERM' },
  ), GENERATED_MANIFEST_PATH);

  assert.equal(diagnostic.code, 'ATOMIC_PUBLICATION_UNSUPPORTED');
  assert.match(diagnostic.message, /cannot atomically publish/);
  assert.match(diagnostic.remedy ?? '', /Move the workspace/);
  assert.deepEqual(diagnostic.details, { path: GENERATED_MANIFEST_PATH, cause: 'EPERM' });
  assert.equal(JSON.stringify(diagnostic).includes('/private/secret'), false);
});

test('durability EACCES failures retain access recovery despite their atomic wrapper code', () => {
  const diagnostic = diagnosticForPathFailure(workspaceFailure(
    'ATOMIC_PUBLICATION_UNSUPPORTED',
    "Filesystem cannot open '/private/secret' for durability sync.",
    'Move the workspace to a compatible filesystem.',
    {
      path: '/private/secret',
      operation: 'open directory for durability sync',
      cause: 'EACCES',
    },
  ), GENERATED_MANIFEST_PATH);

  assert.equal(diagnostic.code, 'FILESYSTEM_ACCESS_FAILED');
  assert.match(diagnostic.message, /could not be inspected or updated safely/);
  assert.match(diagnostic.remedy ?? '', /Restore safe read and write access/);
  assert.deepEqual(diagnostic.details, {
    path: GENERATED_MANIFEST_PATH,
    cause: 'EACCES',
    operation: 'open directory for durability sync',
  });
  assert.equal(JSON.stringify(diagnostic).includes('/private/secret'), false);
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

// #365 disclosed behavior change: a hash-valid old-version disabled-host
// artifact is Roster-owned unedited content (the C3 premise) and is removed
// like its current-canonical sibling -- leaving it was a stale auto-loaded
// contract. The removal compare-and-swaps against the OBSERVED stale bytes,
// so a concurrent edit is refused, never clobbered; a hash-BROKEN disabled
// artifact keeps the preserve + GENERATED_FILE_EDITED path pinned above.
test('v2 update removes a hash-valid stale disabled-host artifact', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const artifactPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    const stale = rehashWithVersion(readFileSync(artifactPath, 'utf8'), '0.0.0-prior');
    writeFileSync(artifactPath, stale);
    disableAllHosts(fx.root);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(existsSync(artifactPath), false);
    assert.equal(existsSync(at(fx.root, CODEX_ROSTER_SKILL_PATH)), false);
    assert.deepEqual(updated.manifest?.hosts, {});
    assert.equal(updated.manifest?.files.some((entry) => entry.host === 'codex'), false);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

// #365 characterization: the five canonical paths are governed by TWO sync
// policies, not one. Mandatory-primary paths (ROSTER.md, .claude/CLAUDE.md,
// AGENTS.md, .agents/skills/roster/SKILL.md) are always synchronized;
// .claude/rules/roster.md is a conditional fallback that is synchronized only
// when the Claude primary cannot be generated. Authored files conflict at
// ROSTER.md and the Codex skill, and are preserved at both host primaries.
// These pins hold the CURRENT matrix steady underneath the taxonomy split.

function enableHosts(root: string, hosts: readonly ('claude' | 'codex')[]): void {
  writeFileSync(at(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: generated-test',
    'tool_uses: []',
    'functions: {}',
    ...(hosts.length === 0 ? ['hosts: {}'] : ['hosts:', ...hosts.map((host) => `  ${host}: enabled`)]),
    '',
  ].join('\n'));
}

function rehashWithVersion(content: string, generatorVersion: string): string {
  const parsed = parseGeneratedMarkdown(content);
  assert.ok(parsed?.valid);
  const { content_hash: _contentHash, ...header } = parsed.header;
  const forged = renderGeneratedMarkdown(
    { ...header, generator_version: generatorVersion },
    parsed.body,
    parsed.prefix,
  );
  assert.ok(parseGeneratedMarkdown(forged)?.valid);
  return forged;
}

test('characterization: authored files conflict at ROSTER.md and the Codex skill', () => {
  const fx = fixture();
  try {
    const authoredBootstrap = '# Authored workspace notes\n';
    writeFileSync(at(fx.root, 'ROSTER.md'), authoredBootstrap);
    const bootstrapUpdate = updateV2ProjectActivations({ root: fx.root });
    assert.equal(bootstrapUpdate.ok, false);
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), authoredBootstrap);
    assert.ok(bootstrapUpdate.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === 'ROSTER.md'
    ));

    writeFileSync(at(fx.root, 'ROSTER.md'), renderRosterBootstrap());
    enableHosts(fx.root, ['codex']);
    mkdirSync(at(fx.root, '.agents/skills/roster'), { recursive: true });
    const authoredSkill = '# Authored skill\n';
    writeFileSync(at(fx.root, CODEX_ROSTER_SKILL_PATH), authoredSkill);
    const skillUpdate = updateV2ProjectActivations({ root: fx.root });
    assert.equal(skillUpdate.ok, false);
    assert.equal(readFileSync(at(fx.root, CODEX_ROSTER_SKILL_PATH), 'utf8'), authoredSkill);
    const codexFiles = skillUpdate.results.find((result) => result.host === 'codex')?.files;
    assert.equal(codexFiles?.find((file) => file.path === CODEX_ROSTER_SKILL_PATH)?.status, 'conflict');
    assert.equal(codexFiles?.find((file) => file.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.status, 'created');
    assert.ok(skillUpdate.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CODEX_ROSTER_SKILL_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('characterization: authored host primaries are preserved and their fallbacks engage', () => {
  const fx = fixture();
  try {
    enableHosts(fx.root, ['claude', 'codex']);
    mkdirSync(at(fx.root, '.claude'), { recursive: true });
    const authoredClaude = '# My Claude policy\n';
    const authoredCodex = '# Company Codex policy\n';
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), authoredClaude);
    writeFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), authoredCodex);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authoredClaude);
    assert.equal(readFileSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH), 'utf8'), authoredCodex);
    const claudeFiles = updated.results.find((result) => result.host === 'claude')?.files;
    assert.equal(
      claudeFiles?.find((file) => file.path === CLAUDE_PROJECT_INSTRUCTIONS_PATH)?.status,
      'preserved-authored',
    );
    assert.equal(claudeFiles?.find((file) => file.path === CLAUDE_PROJECT_RULE_PATH)?.status, 'created');
    const codexFiles = updated.results.find((result) => result.host === 'codex')?.files;
    assert.equal(
      codexFiles?.find((file) => file.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.status,
      'preserved-authored',
    );
    assert.equal(codexFiles?.find((file) => file.path === CODEX_ROSTER_SKILL_PATH)?.status, 'created');
    assert.equal(updated.results.find((result) => result.host === 'codex')?.assurance, 'advisory-manual');
  } finally {
    fx.cleanup();
  }
});

test('characterization: the Claude rule path is a conditional fallback, not a peer', () => {
  const fx = fixture();
  try {
    enableHosts(fx.root, ['claude']);
    assert.equal(updateV2ProjectActivations({ root: fx.root }).ok, true);
    const rulePath = at(fx.root, CLAUDE_PROJECT_RULE_PATH);
    const canonicalRule = renderClaudeProjectInstructions(
      'claude-project-rule',
      resolveActivationAssurance({ host: 'claude', artifact: 'claude-project-rule' }),
    );
    mkdirSync(at(fx.root, '.claude/rules'), { recursive: true });

    writeFileSync(rulePath, canonicalRule);
    const redundant = updateV2ProjectActivations({ root: fx.root });
    assert.equal(redundant.ok, true);
    assert.equal(existsSync(rulePath), false);
    assert.equal(redundant.results[0]?.files.some((file) =>
      file.path === CLAUDE_PROJECT_RULE_PATH && file.status === 'removed'
    ), true);

    const staleRule = rehashWithVersion(canonicalRule, '0.0.0-prior');
    writeFileSync(rulePath, staleRule);
    const stale = updateV2ProjectActivations({ root: fx.root });
    assert.equal(stale.ok, false);
    assert.equal(readFileSync(rulePath, 'utf8'), staleRule);
    assert.ok(stale.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_STALE' &&
      diagnostic.path === CLAUDE_PROJECT_RULE_PATH &&
      /Redundant Claude fallback/.test(diagnostic.message)
    ));

    const editedRule = `${canonicalRule}edited\n`;
    writeFileSync(rulePath, editedRule);
    const edited = updateV2ProjectActivations({ root: fx.root });
    assert.equal(edited.ok, false);
    assert.equal(readFileSync(rulePath, 'utf8'), editedRule);
    assert.ok(edited.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === CLAUDE_PROJECT_RULE_PATH
    ));

    const authoredRule = '# My own Claude rule\n';
    writeFileSync(rulePath, authoredRule);
    const authored = updateV2ProjectActivations({ root: fx.root });
    assert.equal(authored.ok, true);
    assert.equal(readFileSync(rulePath, 'utf8'), authoredRule);
    assert.equal(authored.diagnostics.some((diagnostic) =>
      diagnostic.path === CLAUDE_PROJECT_RULE_PATH
    ), false);

    unlinkSync(rulePath);
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));
    writeFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), '# My Claude policy\n');
    const fallback = updateV2ProjectActivations({ root: fx.root });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.results[0]?.files.find((file) =>
      file.path === CLAUDE_PROJECT_RULE_PATH
    )?.status, 'created');
    assert.ok(parseGeneratedMarkdown(readFileSync(rulePath, 'utf8'))?.valid);
  } finally {
    fx.cleanup();
  }
});

const MANDATORY_PRIMARY_PATHS = [
  'ROSTER.md',
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  CODEX_ROSTER_SKILL_PATH,
] as const;

function forgeManifestFileHashes(root: string, generatorVersion?: string): void {
  const manifestPath = at(root, GENERATED_MANIFEST_PATH);
  const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'));
  assert.ok(manifest);
  const { manifest_hash: _manifestHash, ...draft } = manifest;
  writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
    ...draft,
    ...(generatorVersion === undefined ? {} : { generator_version: generatorVersion }),
    files: draft.files.map((entry) => {
      const parsed = parseGeneratedMarkdown(readFileSync(at(root, entry.path), 'utf8'));
      assert.ok(parsed?.valid);
      return { ...entry, content_hash: parsed.header.content_hash };
    }),
  })));
}

test('an old-generator workspace classifies stale-generated everywhere and update converges', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    for (const path of MANDATORY_PRIMARY_PATHS) {
      writeFileSync(
        at(fx.root, path),
        rehashWithVersion(readFileSync(at(fx.root, path), 'utf8'), '0.0.0-stale'),
      );
    }
    forgeManifestFileHashes(fx.root, '0.0.0-stale');

    const metadata = inspectGeneratedAdapterMetadata(fx.root);
    for (const path of MANDATORY_PRIMARY_PATHS) {
      const entry = metadata.paths.find((candidate) => candidate.path === path);
      assert.equal(entry?.state, 'stale-generated');
      assert.equal(entry?.recorded_generator_version, '0.0.0-stale');
    }
    assert.equal(metadata.manifest.state, 'stale-version');

    const diagnostics = validateGeneratedArtifacts(fx.root);
    for (const path of MANDATORY_PRIMARY_PATHS) {
      const diagnostic = diagnostics.find((candidate) =>
        candidate.code === 'GENERATED_FILE_STALE' && candidate.path === path
      );
      assert.ok(diagnostic, `missing stale diagnostic for ${path}`);
      assert.equal(diagnostic.severity, 'error');
      assert.equal(diagnostic.details['reason'], 'generator-version');
      assert.equal(diagnostic.details['recordedGeneratorVersion'], '0.0.0-stale');
      assert.equal(diagnostic.details['expectedGeneratorVersion'], getPackageVersion());
    }
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_STALE' && diagnostic.path === GENERATED_MANIFEST_PATH
    ));
    assert.equal(diagnostics.some((diagnostic) => diagnostic.code === 'GENERATED_FILE_EDITED'), false);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
    const second = updateV2ProjectActivations({ root: fx.root });
    assert.equal(second.ok, true);
    assert.ok(second.results.flatMap((result) => result.files)
      .every((file) => file.status === 'unchanged'));
  } finally {
    fx.cleanup();
  }
});

test('mixed generator versions classify only the stale path and reconverge on update', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const agentsPath = at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH);
    writeFileSync(agentsPath, rehashWithVersion(readFileSync(agentsPath, 'utf8'), '0.0.0-prior'));
    forgeManifestFileHashes(fx.root);

    const metadata = inspectGeneratedAdapterMetadata(fx.root);
    assert.equal(
      metadata.paths.find((entry) => entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.state,
      'stale-generated',
    );
    assert.equal(
      metadata.paths.find((entry) => entry.path === CODEX_PROJECT_INSTRUCTIONS_PATH)
        ?.recorded_generator_version,
      '0.0.0-prior',
    );
    for (const path of MANDATORY_PRIMARY_PATHS.filter((candidate) =>
      candidate !== CODEX_PROJECT_INSTRUCTIONS_PATH
    )) {
      const entry = metadata.paths.find((candidate) => candidate.path === path);
      assert.equal(entry?.state, 'canonical-generated');
      assert.equal(entry?.recorded_generator_version, getPackageVersion());
    }
    const recorded = new Set([
      ...metadata.paths
        .filter((entry) =>
          entry.state === 'canonical-generated' || entry.state === 'stale-generated')
        .map((entry) => entry.recorded_generator_version),
      metadata.manifest.value?.generator_version,
    ]);
    assert.deepEqual([...recorded].sort(), ['0.0.0-prior', getPackageVersion()].sort());

    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_STALE'
      && diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
      && diagnostic.details['reason'] === 'generator-version'
    ));

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(
      updated.results.find((result) => result.host === 'codex')?.files
        .find((file) => file.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.status,
      'updated',
    );
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('characterization: stale mandatory primaries are replaced and hash-broken edits refused', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    const primaries = [
      'ROSTER.md',
      CLAUDE_PROJECT_INSTRUCTIONS_PATH,
      CODEX_PROJECT_INSTRUCTIONS_PATH,
      CODEX_ROSTER_SKILL_PATH,
    ] as const;
    const canonical = new Map(primaries.map((path) => [path, readFileSync(at(fx.root, path), 'utf8')]));
    for (const path of primaries) {
      writeFileSync(at(fx.root, path), rehashWithVersion(canonical.get(path)!, '0.0.0-prior'));
    }

    const replaced = updateV2ProjectActivations({ root: fx.root });
    assert.equal(replaced.ok, true);
    for (const path of primaries) {
      assert.equal(readFileSync(at(fx.root, path), 'utf8'), canonical.get(path));
    }
    const replacedStatuses = replaced.results.flatMap((result) => result.files);
    for (const path of primaries.filter((candidate) => candidate !== 'ROSTER.md')) {
      assert.equal(replacedStatuses.find((file) => file.path === path)?.status, 'updated');
    }
    const idempotent = updateV2ProjectActivations({ root: fx.root });
    assert.equal(idempotent.ok, true);
    assert.ok(idempotent.results.flatMap((result) => result.files)
      .every((file) => file.status === 'unchanged'));

    const edits = new Map(primaries.map((path) => [path, `${canonical.get(path)!}edited\n`]));
    for (const path of primaries) writeFileSync(at(fx.root, path), edits.get(path)!);
    const refused = updateV2ProjectActivations({ root: fx.root });
    assert.equal(refused.ok, false);
    for (const path of primaries) {
      assert.equal(readFileSync(at(fx.root, path), 'utf8'), edits.get(path));
      assert.ok(refused.diagnostics.some((diagnostic) =>
        diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === path
      ));
    }
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

// #365 shadow detection: a Roster-generated contract copied to a host
// auto-load path outside the five canonical paths is auto-loaded by the host
// and was invisible to update, validate, and doctor. One detector feeds all
// three surfaces; Roster never writes or deletes at a shadow path.

function claudeInstructionsRender(): string {
  return renderClaudeProjectInstructions(
    'claude-project-instructions',
    resolveActivationAssurance({ host: 'claude', artifact: 'claude-project-instructions' }),
  );
}

test('shadow detection classifies duplicate, stale, edited, and unsupported-host copies', () => {
  const fx = fixture();
  try {
    assert.deepEqual(detectGeneratedShadows(fx.root).shadows, []);

    writeFileSync(at(fx.root, 'CLAUDE.md'), claudeInstructionsRender());
    writeFileSync(
      at(fx.root, 'CLAUDE.local.md'),
      rehashWithVersion(claudeInstructionsRender(), '0.0.0-prior'),
    );
    writeFileSync(at(fx.root, 'GEMINI.md'), readFileSync(at(fx.root, 'ROSTER.md')));
    writeFileSync(
      at(fx.root, 'AGENTS.override.md'),
      `${renderCodexProjectInstructions(resolveActivationAssurance({
        host: 'codex',
        artifact: 'codex-project-instructions',
      }))}edited\n`,
    );

    const detected = detectGeneratedShadows(fx.root);
    assert.deepEqual(detected.shadows.map((shadow) => [shadow.path, shadow.kind, shadow.surface_host]), [
      ['AGENTS.override.md', 'edited', 'codex'],
      ['CLAUDE.local.md', 'stale', 'claude'],
      ['CLAUDE.md', 'duplicate', 'claude'],
      ['GEMINI.md', 'unsupported-host', 'gemini'],
    ]);
    assert.equal(
      detected.shadows.find((shadow) => shadow.path === 'CLAUDE.local.md')?.recorded_generator_version,
      '0.0.0-prior',
    );
    assert.equal(
      detected.shadows.find((shadow) => shadow.path === 'CLAUDE.md')?.artifact,
      'claude-project-instructions',
    );
    assert.ok(detected.shadows.every(isBlockingGeneratedShadow));
    assert.ok(detected.diagnostics.every((diagnostic) =>
      diagnostic.code === 'GENERATED_SHADOW' && diagnostic.severity === 'error'
    ));
    const gemini = detected.diagnostics.find((diagnostic) => diagnostic.path === 'GEMINI.md');
    assert.match(gemini?.message ?? '', /Gemini has no v2 activation contract/);
    assert.equal(gemini?.details['surfaceHost'], 'gemini');
  } finally {
    fx.cleanup();
  }
});

test('shadow detection sees a bounded-prefix copy and a bootstrap copy as duplicates', () => {
  const fx = fixture();
  try {
    const skill = renderCodexRosterSkill(resolveActivationAssurance({
      host: 'codex',
      artifact: 'codex-roster-skill',
    }));
    assert.match(skill, /^---\n/);
    writeFileSync(at(fx.root, 'CLAUDE.md'), skill);
    const skillCopy = detectGeneratedShadows(fx.root).shadows;
    assert.deepEqual(skillCopy.map((shadow) => [shadow.path, shadow.kind, shadow.artifact]), [
      ['CLAUDE.md', 'duplicate', 'codex-roster-skill'],
    ]);

    writeFileSync(at(fx.root, 'CLAUDE.md'), readFileSync(at(fx.root, 'ROSTER.md')));
    const bootstrapCopy = detectGeneratedShadows(fx.root).shadows;
    assert.deepEqual(bootstrapCopy.map((shadow) => [shadow.path, shadow.kind, shadow.artifact]), [
      ['CLAUDE.md', 'duplicate', 'roster-bootstrap'],
    ]);
  } finally {
    fx.cleanup();
  }
});

test('shadow detection never flags authored host memory files', () => {
  const fx = fixture();
  try {
    const authored = '# My project memory\n\nAuthored notes.\n';
    const quoting = '# Docs\n\nRoster stamps `<!-- roster:generated` on generated files.\n';
    writeFileSync(at(fx.root, 'CLAUDE.md'), authored);
    writeFileSync(at(fx.root, 'CLAUDE.local.md'), quoting);
    mkdirSync(at(fx.root, '.claude/rules'), { recursive: true });
    writeFileSync(at(fx.root, '.claude/rules/style.md'), authored);
    assert.deepEqual(detectGeneratedShadows(fx.root).shadows, []);

    const install = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(install.ok, true);
    assert.equal(readFileSync(at(fx.root, 'CLAUDE.md'), 'utf8'), authored);
    assert.equal(readFileSync(at(fx.root, 'CLAUDE.local.md'), 'utf8'), quoting);
    assert.equal(readFileSync(at(fx.root, '.claude/rules/style.md'), 'utf8'), authored);
    assert.equal(updateV2ProjectActivations({ root: fx.root }).ok, true);
    assert.equal(validateGeneratedArtifacts(fx.root).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('unreadable auto-load paths block everywhere except the personal CLAUDE.local.md', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    const outside = join(fx.root, '..', `roster-shadow-decoy-${Date.now()}`);
    writeFileSync(outside, '# decoy\n');
    try {
      symlinkSync(outside, at(fx.root, 'CLAUDE.local.md'));
      const localOnly = detectGeneratedShadows(fx.root);
      assert.deepEqual(localOnly.shadows.map((shadow) => [shadow.path, shadow.kind]), [
        ['CLAUDE.local.md', 'unreadable'],
      ]);
      assert.equal(isBlockingGeneratedShadow(localOnly.shadows[0]!), false);
      assert.equal(localOnly.diagnostics[0]?.severity, 'warning');
      assert.equal(updateV2ProjectActivations({ root: fx.root }).ok, true);
      assert.equal(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
        diagnostic.severity === 'error'
      ), false);

      symlinkSync(outside, at(fx.root, 'CLAUDE.md'));
      const both = detectGeneratedShadows(fx.root);
      const rootShadow = both.shadows.find((shadow) => shadow.path === 'CLAUDE.md');
      assert.equal(rootShadow?.kind, 'unreadable');
      assert.equal(isBlockingGeneratedShadow(rootShadow!), true);
      const updated = updateV2ProjectActivations({ root: fx.root });
      assert.equal(updated.ok, false);
      assert.ok(updated.diagnostics.some((diagnostic) =>
        diagnostic.code === 'GENERATED_SHADOW'
        && diagnostic.path === 'CLAUDE.md'
        && diagnostic.severity === 'error'
      ));
      assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
        diagnostic.code === 'GENERATED_SHADOW' && diagnostic.path === 'CLAUDE.md'
      ));
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('the recursive rules scan finds copies, skips the canonical rule, and flags symlinks', () => {
  const fx = fixture();
  try {
    mkdirSync(at(fx.root, '.claude/rules/team/deep'), { recursive: true });
    const rule = renderClaudeProjectInstructions(
      'claude-project-rule',
      resolveActivationAssurance({ host: 'claude', artifact: 'claude-project-rule' }),
    );
    writeFileSync(at(fx.root, CLAUDE_PROJECT_RULE_PATH), rule);
    writeFileSync(at(fx.root, '.claude/rules/extra.md'), rule);
    writeFileSync(at(fx.root, '.claude/rules/team/deep/nested.md'), claudeInstructionsRender());
    writeFileSync(at(fx.root, '.claude/rules/notes.txt'), claudeInstructionsRender());
    const outside = join(fx.root, '..', `roster-rules-decoy-${Date.now()}`);
    writeFileSync(outside, '# decoy rule\n');
    try {
      symlinkSync(outside, at(fx.root, '.claude/rules/team/link.md'));

      const detected = detectGeneratedShadows(fx.root);
      assert.deepEqual(
        detected.shadows.map((shadow) => [shadow.path, shadow.kind, shadow.surface_host]),
        [
          ['.claude/rules/extra.md', 'duplicate', 'claude'],
          ['.claude/rules/team/deep/nested.md', 'duplicate', 'claude'],
          ['.claude/rules/team/link.md', 'unreadable', 'claude'],
        ],
      );
      assert.ok(detected.shadows.every(isBlockingGeneratedShadow));
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('both rules budget dimensions block at their boundary, never silently truncate', () => {
  const depthPath = (levels: number): string =>
    ['.claude/rules', ...Array.from({ length: levels }, (_, index) => `d${index + 1}`)].join('/');

  const atDepthLimit = fixture();
  try {
    mkdirSync(at(atDepthLimit.root, depthPath(8)), { recursive: true });
    writeFileSync(at(atDepthLimit.root, `${depthPath(8)}/leaf.md`), '# rule\n');
    assert.deepEqual(detectGeneratedShadows(atDepthLimit.root).shadows, []);
  } finally {
    atDepthLimit.cleanup();
  }

  const beyondDepthLimit = fixture();
  try {
    mkdirSync(at(beyondDepthLimit.root, depthPath(9)), { recursive: true });
    const detected = detectGeneratedShadows(beyondDepthLimit.root);
    assert.deepEqual(detected.shadows.map((shadow) => [shadow.path, shadow.kind]), [
      [depthPath(9), 'unreadable'],
    ]);
    assert.equal(detected.diagnostics[0]?.severity, 'error');
    assert.match(detected.diagnostics[0]?.message ?? '', /depth exceeds 8/);
    assert.match(detected.diagnostics[0]?.message ?? '', /d9/);
  } finally {
    beyondDepthLimit.cleanup();
  }

  const atEntryBudget = fixture();
  try {
    mkdirSync(at(atEntryBudget.root, '.claude/rules'), { recursive: true });
    for (let index = 0; index < 256; index++) {
      writeFileSync(at(atEntryBudget.root, `.claude/rules/r${String(index).padStart(3, '0')}.md`), '# rule\n');
    }
    assert.deepEqual(detectGeneratedShadows(atEntryBudget.root).shadows, []);
  } finally {
    atEntryBudget.cleanup();
  }

  const beyondEntryBudget = fixture();
  try {
    mkdirSync(at(beyondEntryBudget.root, '.claude/rules'), { recursive: true });
    for (let index = 0; index < 257; index++) {
      writeFileSync(at(beyondEntryBudget.root, `.claude/rules/r${String(index).padStart(3, '0')}.md`), '# rule\n');
    }
    const detected = detectGeneratedShadows(beyondEntryBudget.root);
    assert.deepEqual(detected.shadows.map((shadow) => [shadow.path, shadow.kind]), [
      ['.claude/rules', 'unreadable'],
    ]);
    assert.equal(detected.diagnostics[0]?.severity, 'error');
    assert.match(detected.diagnostics[0]?.message ?? '', /256-entry budget/);
  } finally {
    beyondEntryBudget.cleanup();
  }
});

test('a diverted rules root is the blocking diagnostic on update, validate, and inspection', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));
    const outsideDir = join(fx.root, '..', `roster-rules-root-decoy-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'injected.md'), claudeInstructionsRender());
    try {
      mkdirSync(at(fx.root, '.claude'), { recursive: true });
      symlinkSync(outsideDir, at(fx.root, '.claude/rules'));

      const updated = updateV2ProjectActivations({ root: fx.root });
      assert.equal(updated.ok, false);
      assert.ok(updated.diagnostics.some((diagnostic) =>
        diagnostic.code === 'GENERATED_SHADOW'
        && diagnostic.path === '.claude/rules'
        && diagnostic.severity === 'error'
      ));
      assert.ok(parseGeneratedMarkdown(
        readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'),
      )?.valid);

      const diagnostics = validateGeneratedArtifacts(fx.root);
      assert.ok(diagnostics.some((diagnostic) =>
        diagnostic.code === 'GENERATED_SHADOW' && diagnostic.path === '.claude/rules'
      ));

      const metadata = inspectGeneratedAdapterMetadata(fx.root);
      assert.deepEqual(metadata.shadows.map((shadow) => [shadow.path, shadow.kind]), [
        ['.claude/rules', 'unreadable'],
      ]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('update repairs canonical files but fails loudly while a shadow exists', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    const shadowBytes = claudeInstructionsRender();
    writeFileSync(at(fx.root, 'CLAUDE.md'), shadowBytes);
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.ok(parseGeneratedMarkdown(
      readFileSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH), 'utf8'),
    )?.valid);
    assert.equal(readFileSync(at(fx.root, 'CLAUDE.md'), 'utf8'), shadowBytes);
    assert.ok(updated.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_SHADOW' && diagnostic.path === 'CLAUDE.md'
    ));

    const secondRun = updateV2ProjectActivations({ root: fx.root });
    assert.equal(secondRun.ok, false);
    assert.equal(readFileSync(at(fx.root, 'CLAUDE.md'), 'utf8'), shadowBytes);
  } finally {
    fx.cleanup();
  }
});

test('project install refuses and rolls back its own writes while a shadow exists', () => {
  const fx = fixture();
  try {
    const shadowBytes = rehashWithVersion(claudeInstructionsRender(), '0.0.0-prior');
    writeFileSync(at(fx.root, 'CLAUDE.md'), shadowBytes);

    const install = installV2ProjectActivation({ root: fx.root, host: 'claude' });
    assert.equal(install.ok, false);
    assert.equal(install.registryUpdated, false);
    assert.equal(existsSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH)), false);
    assert.deepEqual(Object.keys(parseWorkspaceRegistry(
      readFileSync(at(fx.root, 'roster.yaml'), 'utf8'),
    ).hosts), []);
    assert.equal(readFileSync(at(fx.root, 'CLAUDE.md'), 'utf8'), shadowBytes);
    assert.ok(install.diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_SHADOW'
      && diagnostic.path === 'CLAUDE.md'
      && diagnostic.details['kind'] === 'stale'
    ));
  } finally {
    fx.cleanup();
  }
});

test('a broken manifest cannot hide a shadow from generated validation', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    writeFileSync(at(fx.root, 'CLAUDE.md'), claudeInstructionsRender());
    writeFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'not json\n');

    const diagnostics = validateGeneratedArtifacts(fx.root);
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_SHADOW' && diagnostic.path === 'CLAUDE.md'
    ));
    assert.ok(diagnostics.some((diagnostic) =>
      diagnostic.code === 'GENERATED_FILE_EDITED' && diagnostic.path === GENERATED_MANIFEST_PATH
    ));
  } finally {
    fx.cleanup();
  }
});

test('a deleted mandatory primary is reported by validate and recreated by update', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'codex' }).ok, true);
    unlinkSync(at(fx.root, CODEX_PROJECT_INSTRUCTIONS_PATH));
    assert.ok(validateGeneratedArtifacts(fx.root).some((diagnostic) =>
      diagnostic.path === CODEX_PROJECT_INSTRUCTIONS_PATH
      && /does not match its manifest entry/.test(diagnostic.message)
    ));
    const recreated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(recreated.ok, true);
    assert.equal(
      recreated.results.find((result) => result.host === 'codex')?.files
        .find((file) => file.path === CODEX_PROJECT_INSTRUCTIONS_PATH)?.status,
      'created',
    );
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);

    unlinkSync(at(fx.root, 'ROSTER.md'));
    const restored = updateV2ProjectActivations({ root: fx.root });
    assert.equal(restored.ok, true);
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), renderRosterBootstrap());
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

// #365 review round 1, blocker 2: §5 promised "delete manifest + one host
// file → refusal", misreading where hasMissingClaim fires. The host sync
// recreates recreatable files BEFORE syncGeneratedManifest evaluates the
// missing claim (ordering pre-existing on main 9e63154), so the honest
// contract -- pinned here -- is: update SELF-HEALS the absent-manifest +
// absent-host-file state; the read-only surface reports the absent manifest
// and stops; the hasMissingClaim refusal fires exactly when reconstruction
// is attempted while an enabled activation cannot be regenerated.

test('an absent manifest with an absent host file blocks read-only and converges on update', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    unlinkSync(at(fx.root, GENERATED_MANIFEST_PATH));
    unlinkSync(at(fx.root, CLAUDE_PROJECT_INSTRUCTIONS_PATH));

    const readOnly = validateGeneratedArtifacts(fx.root);
    assert.equal(readOnly.length, 1);
    assert.equal(readOnly[0]?.code, 'GENERATED_FILE_EDITED');
    assert.equal(readOnly[0]?.severity, 'error');
    assert.equal(readOnly[0]?.path, GENERATED_MANIFEST_PATH);
    assert.match(readOnly[0]?.message ?? '', /Enabled hosts require/);
    assert.equal(readOnly.some((diagnostic) =>
      diagnostic.path === CLAUDE_PROJECT_INSTRUCTIONS_PATH
    ), false);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, true);
    assert.equal(
      updated.results.find((result) => result.host === 'claude')?.files
        .find((file) => file.path === CLAUDE_PROJECT_INSTRUCTIONS_PATH)?.status,
      'created',
    );
    assert.ok(parseGeneratedManifest(readFileSync(at(fx.root, GENERATED_MANIFEST_PATH), 'utf8')));
    assert.deepEqual(validateGeneratedArtifacts(fx.root), []);
  } finally {
    fx.cleanup();
  }
});

test('manifest reconstruction refuses while an enabled activation cannot be regenerated', () => {
  const fx = fixture();
  try {
    assert.equal(installV2ProjectActivation({ root: fx.root, host: 'claude' }).ok, true);
    unlinkSync(at(fx.root, GENERATED_MANIFEST_PATH));
    const authoredBootstrap = '# Authored workspace notes\n';
    writeFileSync(at(fx.root, 'ROSTER.md'), authoredBootstrap);

    const updated = updateV2ProjectActivations({ root: fx.root });
    assert.equal(updated.ok, false);
    assert.equal(existsSync(at(fx.root, GENERATED_MANIFEST_PATH)), false);
    assert.equal(readFileSync(at(fx.root, 'ROSTER.md'), 'utf8'), authoredBootstrap);
    assert.ok(updated.diagnostics.some((diagnostic) =>
      diagnostic.path === GENERATED_MANIFEST_PATH
      && /cannot be reconstructed while an enabled host activation is missing/.test(diagnostic.message)
    ));
  } finally {
    fx.cleanup();
  }
});

// DEVIATIONS entry 3 exercised directly: S4 precedence at GEMINI.md covers
// the invalid-marker (S3) cell too -- both the unparseable-header and the
// hash-broken variants classify unsupported-host, never edited.
test('an invalid offset-0 marker at GEMINI.md keeps the unsupported-host classification', () => {
  const fx = fixture();
  try {
    writeFileSync(at(fx.root, 'GEMINI.md'), '<!-- roster:generated\nnot a header\n-->\nBody.\n');
    const unparseable = detectGeneratedShadows(fx.root);
    assert.deepEqual(
      unparseable.shadows.map((shadow) => [shadow.path, shadow.kind, shadow.surface_host, shadow.artifact]),
      [['GEMINI.md', 'unsupported-host', 'gemini', null]],
    );
    assert.match(unparseable.diagnostics[0]?.message ?? '', /Gemini has no v2 activation contract/);
    assert.equal(unparseable.diagnostics[0]?.severity, 'error');

    writeFileSync(at(fx.root, 'GEMINI.md'), `${readFileSync(at(fx.root, 'ROSTER.md'), 'utf8')}edited\n`);
    const hashBroken = detectGeneratedShadows(fx.root);
    assert.deepEqual(
      hashBroken.shadows.map((shadow) => [shadow.path, shadow.kind, shadow.artifact]),
      [['GEMINI.md', 'unsupported-host', 'roster-bootstrap']],
    );
  } finally {
    fx.cleanup();
  }
});
