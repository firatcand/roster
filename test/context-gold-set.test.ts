import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceRegistry } from '../src/lib/workspace-record.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  parseGeneratedMarkdown,
  renderClaudeProjectInstructions,
  renderCodexProjectInstructions,
  renderCodexRosterSkill,
  type ResolvedActivationAssurance,
} from '../src/lib/generated-artifacts.ts';
import { parseContextArgs } from '../src/lib/context-args.ts';
import { lintPrivacyArtifacts } from './support/privacy-lint.ts';
import { lintRetrievalGoldArtifacts } from './support/retrieval-gold.ts';
import {
  CONTEXT_GOLD_LINT_TABLES,
  CONTEXT_GOLD_WORKSPACE_DIR,
  CONTEXT_SYNTHETIC_WORKSPACE_IDS,
  computeEagerBaseline,
  contextPrivacyLintScope,
  evaluateMandatoryEntry,
  lintContextGoldArtifacts,
  loadContextGoldSet,
  validateContextGoldSet,
  type ObservedFragment,
} from './support/context-gold.ts';
import { derivePartialRegistry } from './fixtures/context-gold-workspace/_setup.ts';

const gold = loadContextGoldSet();

test('the gold set parses and satisfies its structural contract', () => {
  assert.deepEqual(validateContextGoldSet(gold), []);
  assert.equal(gold.tasks.length, 17, 'the gold set carries the seventeen planned tasks');
  assert.equal(gold.tasks.filter((task) => task.tier === 'local').length, 11);
  assert.equal(gold.tasks.filter((task) => task.tier === 'brain').length, 6);
  assert.deepEqual([...gold.document.identities.workspaceIds], [...CONTEXT_SYNTHETIC_WORKSPACE_IDS]);
});

// The FROZEN baseline is verified, not trusted: the whole structure is
// recomputed from the checked-in fixture and must deep-equal the committed
// file. An intentional fixture edit is a reviewed two-file change; the failure
// message reports the recomputed totals so the update is mechanical.
test('the eager baseline recomputes exactly from the checked-in fixture', () => {
  const recomputed = computeEagerBaseline();
  assert.deepEqual(
    gold.baseline,
    recomputed,
    `eager-baseline.json drifted from the fixture; recomputed totals: ${JSON.stringify(recomputed.totals)}`,
  );
  // The A4 composition rule is enforced structurally: only functions/** and
  // tools/** may appear, and the excluded files exist in the fixture but never
  // in the denominator.
  for (const file of gold.baseline.files) {
    assert.equal(
      file.path.startsWith('functions/') || file.path.startsWith('tools/'),
      true,
      `baseline file outside the composition rule: ${file.path}`,
    );
  }
  for (const excluded of ['ROSTER.md', 'roster.yaml', 'roster.brain.yaml', '_setup.ts']) {
    assert.equal(existsSync(join(CONTEXT_GOLD_WORKSPACE_DIR, excluded)), true);
    assert.equal(gold.baseline.files.some((file) => file.path.endsWith(excluded)), false);
  }
});

test('the privacy lint passes over the three context artifact directories', () => {
  const findings = lintContextGoldArtifacts();
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  const scope = contextPrivacyLintScope();
  assert.equal(scope.length, 3);
  assert.equal(scope.some((entry) => entry.endsWith('context-gold')), true);
  assert.equal(scope.some((entry) => entry.endsWith('context-gold-workspace')), true);
  assert.equal(scope.some((entry) => entry.endsWith('context-quality')), true);
  assert.equal(scope.some((entry) => entry.includes('support')), false);
  assert.equal(scope.some((entry) => entry.includes('retrieval')), false);
});

// ---------------------------------------------------------------------------
// Extraction characterization: fixed rule-combination inputs produce
// byte-identical findings through BOTH consumers of the shared engine.
// ---------------------------------------------------------------------------

function contextAdversarialRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'context-gold-lint-'));
  mkdirSync(join(root, 'test', 'fixtures', 'context-gold'), { recursive: true });
  mkdirSync(join(root, 'test', 'fixtures', 'context-gold-workspace'), { recursive: true });
  mkdirSync(join(root, 'docs', 'evals', 'context-quality'), { recursive: true });
  mkdirSync(join(root, 'test', 'fixtures', 'retrieval-gold'), { recursive: true });
  mkdirSync(join(root, 'docs', 'evals', 'retrieval-quality'), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    writeFileSync(join(root, relative), contents);
  }
  return root;
}

test('the extracted engine reproduces the #353 findings byte-identically on fixed inputs', () => {
  // One fixed input exercising the rule COMBINATION: a denylisted literal, a
  // userinfo URL, a bare private host on a listed TLD, a workspace-shaped
  // identity, and a digest inside prose.
  const body = [
    'my-roster leaked here',
    'https://user:hunter22secret@internal.example.io/path',
    'bare host internal.acme.systems in prose',
    'identity leaked-real-workspace mentioned',
    `digest sha256:${'d'.repeat(64)} in prose`,
  ].join('\n');
  const root = contextAdversarialRoot({
    'test/fixtures/retrieval-gold/note.md': body,
    'test/fixtures/context-gold/note.md': body,
  });
  const viaRetrievalGold = lintRetrievalGoldArtifacts(root)
    .map((finding) => `${finding.rule}:${finding.detail}`);
  const viaContextTables = lintPrivacyArtifacts({
    root,
    scanDirs: [join(root, 'test', 'fixtures', 'context-gold')],
    tables: CONTEXT_GOLD_LINT_TABLES,
  }).map((finding) => `${finding.rule}:${finding.detail}`);
  // Same rules, same order, same details — only the scanned file differs.
  assert.deepEqual(viaContextTables, viaRetrievalGold);
  assert.equal(viaRetrievalGold.includes('denylisted-literal:my-roster'), true);
  assert.equal(viaRetrievalGold.includes('non-synthetic-host:internal.acme.systems'), true);
  assert.equal(viaRetrievalGold.some((entry) => entry.startsWith('workspace-identity:leaked-real-workspace')), true);
});

test('the context lint fails a digest parked at an undeclared JSON position but passes declared ones', () => {
  const digest = 'a'.repeat(64);
  const root = contextAdversarialRoot({
    'test/fixtures/context-gold/eager-baseline.json': JSON.stringify({
      files: [{ path: 'functions/x.yaml', sha256: digest, bytes: 1, tokens: 1 }],
      notes: `copied ${digest} from a live workspace`,
    }),
  });
  const findings = lintPrivacyArtifacts({
    root,
    scanDirs: [join(root, 'test', 'fixtures', 'context-gold')],
    tables: CONTEXT_GOLD_LINT_TABLES,
  });
  assert.deepEqual(findings.map((entry) => entry.rule), ['unexpected-digest'], JSON.stringify(findings));
});

test('the context lint rejects a non-allowlisted workspace identity at a workspace key', () => {
  const root = contextAdversarialRoot({
    'test/fixtures/context-gold/tasks.json': JSON.stringify({
      identities: { workspaceIds: [] },
      workspace_id: 'someones-production-workspace',
    }),
  });
  const findings = lintPrivacyArtifacts({
    root,
    scanDirs: [join(root, 'test', 'fixtures', 'context-gold')],
    tables: CONTEXT_GOLD_LINT_TABLES,
  });
  const details = findings.map((entry) => `${entry.rule}:${entry.detail}`);
  assert.equal(details.includes('workspace-identity:someones-production-workspace'), true, JSON.stringify(findings));
});

// ---------------------------------------------------------------------------
// Registry variants (derive-don't-restate for both tiers)
// ---------------------------------------------------------------------------

test('the two checked-in registries parse identically except the brain block', () => {
  const local = parseWorkspaceRegistry(
    readFileSync(join(CONTEXT_GOLD_WORKSPACE_DIR, 'roster.yaml'), 'utf8'),
  );
  const brain = parseWorkspaceRegistry(
    readFileSync(join(CONTEXT_GOLD_WORKSPACE_DIR, 'roster.brain.yaml'), 'utf8'),
  );
  assert.equal(local.brain, undefined);
  assert.notEqual(brain.brain, undefined);
  // The brain variant exercises the registry DEFAULTS, like #355: no endpoint,
  // force_path_style defaulted false.
  assert.equal(brain.brain!.storage.force_path_style, false);
  assert.equal(Object.hasOwn(brain.brain!.storage, 'endpoint'), false);
  const { brain: _brain, ...brainRest } = brain;
  assert.deepEqual(brainRest, local);
});

test('the derived partial registry fails closed as an incomplete Brain activation', () => {
  const brainText = readFileSync(join(CONTEXT_GOLD_WORKSPACE_DIR, 'roster.brain.yaml'), 'utf8');
  const partial = derivePartialRegistry(brainText);
  assert.equal(partial.includes('secrets_path'), true);
  assert.equal(partial.includes('storage'), false);
  try {
    parseWorkspaceRegistry(partial);
    assert.fail('a partial brain block must not parse');
  } catch (error) {
    assert.equal(isWorkspaceFailure(error), true);
    if (isWorkspaceFailure(error)) {
      assert.equal(error.code, 'YAML_INVALID');
      assert.equal(error.details['brain_configuration'], 'incomplete');
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-host equivalence — the hermetic halves (§7.1 structural, §7.3 parity)
// ---------------------------------------------------------------------------

test("parseContextArgs rejects '--host' specifically: no per-invocation host selector exists", () => {
  const parsed = parseContextArgs([
    'gtm/social-manager', '--query', 'find current threads', '--json', '--host', 'claude',
  ]);
  assert.equal(parsed.kind, 'err');
  if (parsed.kind === 'err') assert.equal(parsed.message, "unknown argument for 'context'");
  // The same request without the host flag is accepted — the rejection above is
  // about the flag, not the request.
  const accepted = parseContextArgs(['gtm/social-manager', '--query', 'find current threads', '--json']);
  assert.equal(accepted.kind, 'ok');
});

const PARITY_ASSURANCE: ResolvedActivationAssurance = {
  assurance: 'advisory-manual',
  supportedHostVersions: 'unattested',
  attestationFixture: null,
};

test('activation parity: one bootstrap body renders for both hosts modulo the display name', () => {
  const claude = parseGeneratedMarkdown(
    renderClaudeProjectInstructions('claude-project-instructions', PARITY_ASSURANCE),
  );
  const codex = parseGeneratedMarkdown(renderCodexProjectInstructions(PARITY_ASSURANCE));
  const codexSkill = parseGeneratedMarkdown(renderCodexRosterSkill(PARITY_ASSURANCE));
  assert.notEqual(claude, null, 'claude activation must parse');
  assert.notEqual(codex, null, 'codex activation must parse');
  assert.notEqual(codexSkill, null, 'codex skill must parse');
  assert.equal(claude!.valid && codex!.valid && codexSkill!.valid, true);
  assert.equal(claude!.body.replaceAll('Claude Code', 'Codex'), codex!.body);
  // The Codex skill shares the SAME body; its frontmatter surfaces as the
  // parse's prefix and is asserted separately, excluded from body parity.
  assert.equal(codexSkill!.body, codex!.body);
  assert.equal(claude!.prefix, '');
  assert.equal(codex!.prefix, '');
  assert.equal(codexSkill!.prefix, [
    '---',
    'name: roster',
    'description: Use the repository Roster registry and sparse scaffold when working with purpose-built agents.',
    '---',
    '',
  ].join('\n'));
  assert.equal(claude!.body.includes('ROSTER.md'), true);
});

// ---------------------------------------------------------------------------
// Every gold ref resolves against the checked-in fixture
// ---------------------------------------------------------------------------

function fixtureFileFor(kind: string, ref: string): string | null {
  if (kind === 'function') return join('functions', ref, 'function.yaml');
  if (kind === 'agent') {
    const [functionId, agentId] = ref.split('/');
    return join('functions', functionId!, 'agents', agentId!, 'agent.yaml');
  }
  if (kind === 'plan') {
    const [owner, planId] = ref.split('#');
    const [functionId, agentId] = owner!.split('/');
    return join('functions', functionId!, 'agents', agentId!, 'plans', `${planId}.yaml`);
  }
  if (kind === 'guideline') {
    const segments = ref.split('/');
    if (segments.length === 3 && segments[1] === 'guidelines') {
      return join('functions', segments[0]!, 'guidelines', `${segments[2]}.md`);
    }
    if (segments.length === 4 && segments[2] === 'guidelines') {
      return join('functions', segments[0]!, 'agents', segments[1]!, 'guidelines', `${segments[3]}.md`);
    }
    return null;
  }
  if (kind === 'lesson') {
    const segments = ref.split('/');
    if (segments.length === 4 && segments[2] === 'playbook') {
      return join('functions', segments[0]!, 'agents', segments[1]!, 'playbook', `${segments[3]}.md`);
    }
    return null;
  }
  if (kind === 'tool-use') return join('tools', `${ref}.yaml`);
  return null;
}

test('every local gold ref resolves against the checked-in fixture workspace', () => {
  const workspaceToolText = ['signal-scan', 'channel-drafts', 'ticket-search', 'atlas-crawl']
    .map((id) => readFileSync(join(CONTEXT_GOLD_WORKSPACE_DIR, 'tools', `${id}.yaml`), 'utf8'))
    .join('\n');
  for (const task of gold.tasks) {
    const refs = [
      ...task.mandatory.flatMap((entry) => (entry.ref !== undefined ? [{ kind: entry.kind, ref: entry.ref }]
        : (entry.anyOf ?? []).map((ref) => ({ kind: entry.kind, ref })))),
      ...task.forbidden.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
    ];
    for (const { kind, ref } of refs) {
      if (kind === 'brain-evidence') continue; // validated against the seeds by validateContextGoldSet
      if (kind === 'skill-ref') {
        assert.equal(
          workspaceToolText.includes(`skill_ref: ${ref}`),
          true,
          `task '${task.id}' names skill_ref '${ref}' that no workspace tool declares`,
        );
        continue;
      }
      const file = fixtureFileFor(kind, ref);
      assert.notEqual(file, null, `task '${task.id}' names unresolvable ${kind} '${ref}'`);
      assert.equal(
        existsSync(join(CONTEXT_GOLD_WORKSPACE_DIR, file!)),
        true,
        `task '${task.id}' names ${kind} '${ref}' but ${file} does not exist`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// A5: the anyOf matcher semantics, proven on discriminating cases
// ---------------------------------------------------------------------------

function lessonFragment(id: string): ObservedFragment {
  return {
    fragment_id: `lesson:${id}`,
    kind: 'lesson',
    inclusion_reason: 'applicable-lesson',
    trust: 'approved-lesson',
    required: false,
  };
}

test('anyOf semantics: one present passes, none present fails naming the group, both present passes', () => {
  const entry = {
    kind: 'lesson' as const,
    anyOf: ['gtm/x/playbook/a', 'gtm/x/playbook/b'],
    inclusionReason: 'applicable-lesson' as const,
  };
  const onePresent = evaluateMandatoryEntry(entry, [lessonFragment('gtm/x/playbook/a')]);
  assert.equal(onePresent.ok, true);
  const otherPresent = evaluateMandatoryEntry(entry, [lessonFragment('gtm/x/playbook/b')]);
  assert.equal(otherPresent.ok, true);
  const nonePresent = evaluateMandatoryEntry(entry, [lessonFragment('gtm/x/playbook/c')]);
  assert.equal(nonePresent.ok, false);
  assert.equal(nonePresent.detail.includes('gtm/x/playbook/a'), true, 'the failure names the group');
  assert.equal(nonePresent.detail.includes('gtm/x/playbook/b'), true, 'the failure names the group');
  const bothPresent = evaluateMandatoryEntry(entry, [
    lessonFragment('gtm/x/playbook/a'),
    lessonFragment('gtm/x/playbook/b'),
  ]);
  assert.equal(bothPresent.ok, true);
  // A member present under the WRONG inclusion reason does not satisfy the group.
  const wrongReason = evaluateMandatoryEntry(entry, [{
    ...lessonFragment('gtm/x/playbook/a'),
    inclusion_reason: 'plan-referenced-guideline',
  }]);
  assert.equal(wrongReason.ok, false);
});

test('exactly-one-of ref and anyOf is schema-enforced', () => {
  const broken = JSON.parse(JSON.stringify(gold.document)) as typeof gold.document;
  const task = broken.tasks.find((entry) => entry.id === 'L11-anyof-alternatives')!;
  (task.mandatory as unknown as Array<Record<string, unknown>>).push({
    kind: 'lesson',
    ref: 'gtm/social-manager/playbook/general-prior',
    anyOf: ['gtm/social-manager/playbook/general-prior', 'gtm/social-manager/playbook/duplicate-brief'],
    inclusionReason: 'applicable-lesson',
  });
  const problems = validateContextGoldSet({ ...gold, document: broken, tasks: broken.tasks });
  assert.equal(problems.some((problem) => problem.includes('exactly one of ref or anyOf')), true, problems.join('\n'));
});
