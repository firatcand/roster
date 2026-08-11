import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseWorkspaceRegistry } from '../../src/lib/workspace-record.ts';
import { tombstoneBrainSource } from '../../src/lib/brain/source-lifecycle.ts';
import {
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_RETRIEVAL_FILTER_REASONS,
  type ContextRetrievalFilterReason,
} from '../../src/lib/workspace-context.ts';
import {
  createRetrievalCorpus,
  ingestCorpusSource,
  runtimeUrlFor,
  type RetrievalCorpus,
} from './brain-retrieval-corpus.ts';
import {
  HAS_TEST_S3,
  createMinioTransportStore,
  freshMinioBucketName,
} from './minio-brain-object-store.ts';
import {
  buildContextGoldWorkspace,
  type ContextGoldRegistryVariant,
  type ContextGoldWorkspaceFixture,
} from '../fixtures/context-gold-workspace/_setup.ts';
import {
  REPOSITORY_ROOT,
  estimatedTokens,
  evaluateMandatoryEntry,
  fragmentRefMatches,
  type ContextGoldForbidden,
  type ContextGoldSeed,
  type ContextGoldSet,
  type ContextGoldTask,
  type ContextGoldTier,
  type ObservedFragment,
} from './context-gold.ts';

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1;
export const CONTEXT_REDUCTION_THRESHOLD = 0.4;
export const CONTEXT_DEFAULT_BUDGET_TOKENS = 12_000;

// §15 nonblocking fold (a): the reduction gate applies to exactly these tasks.
// B1–B5 keep recall/exclusion/citation/accounting gates without ratio gates.
export const RATIO_GATED_TASK_IDS: readonly string[] = Object.freeze([
  'L1-full-closure-recall',
  'L2-agent-only-target',
  'L3-duplicate-lesson-exclusion',
  'L4-sibling-scope-exclusion',
  'L5-cross-function-isolation',
  'L6-lesson-budget-exhaustion',
  'L9-sparse-agent-coverage',
  'B6-representative-full-task',
]);

// The manifest positions that legitimately differ between two independent
// rebuilds of one commit. Every other position must compare equal.
export const CONTEXT_MANIFEST_COMPARISON_EXCLUSIONS: readonly string[] = Object.freeze([
  '/generated_at',
  '/environment',
  '/timings',
  '/tiers/local/timings',
  '/tiers/brain/timings',
]);

export const CONTEXT_HARNESS_FILES: readonly string[] = Object.freeze([
  'test/support/privacy-lint.ts',
  'test/support/context-gold.ts',
  'test/support/context-eval-runner.ts',
  'test/fixtures/context-gold-workspace/_setup.ts',
  'scripts/context-eval-report.ts',
]);

// The product's closed EXPLANATIONS table (workspace-context.ts), pinned here
// verbatim: explanation stability means these exact strings are observed for
// every inclusion reason a tier produces. A product wording change fails this
// suite loudly and becomes a reviewed harness update.
export const CANONICAL_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  'target-function': 'Selected function policy is mandatory for the exact target.',
  'target-agent': 'Selected agent policy is mandatory for the exact target.',
  'selected-plan-root': 'The host explicitly selected this complete root plan.',
  'nested-plan-closure': 'A selected plan statically references this nested plan.',
  'agent-default-guideline': 'The selected agent declares this default guideline.',
  'plan-referenced-guideline': 'A plan in the selected closure references this guideline.',
  'applicable-lesson': 'This approved lesson applies to the selected agent and plan closure.',
  'plan-tool-step': 'A tool step in the selected closure names this effective tool guidance.',
  'tool-skill-ref': 'Selected tool guidance names this canonical vendor skill reference.',
  'selector-match': 'This cited evidence matches an authored context selector.',
  'required-selector-match': 'This cited evidence matches a required-intent authored selector.',
  'host-query': 'The host supplied this bounded task query.',
  'host-step-hint': 'The host supplied this optional relevance hint.',
});

// A8: selector reasons are Brain-only; the local tier must observe a strict
// subset that never contains them, and the brain tier must observe both.
export const BRAIN_ONLY_INCLUSION_REASONS: readonly string[] = Object.freeze([
  'selector-match',
  'required-selector-match',
]);

const EXPECTED_TRUST_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  function: 'authored-policy',
  agent: 'authored-policy',
  plan: 'authored-policy',
  guideline: 'authored-policy',
  lesson: 'approved-lesson',
  'tool-use': 'authored-policy',
  'skill-ref': 'vendor-instruction',
});

const CITATION_FIELDS: readonly string[] = Object.freeze([
  'logical_source_id',
  'source_version_id',
  'object_id',
  'extractor_id',
  'extractor_version',
  'locator',
  'content_hash',
]);

const BIN = resolve(REPOSITORY_ROOT, 'src', 'bin', 'roster.ts');

export type GateResult = Readonly<{ name: string; ok: boolean; detail: string }>;

export type ContextTaskRow = Readonly<{
  id: string;
  family: string;
  tier: ContextGoldTier;
  registry_variant: ContextGoldRegistryVariant;
  exit_status: number;
  bundle_tokens: number | null;
  baseline_tokens: number;
  reduction: number | null;
  ratio_gated: boolean;
  gates: readonly GateResult[];
}>;

export type ContextTierOutcome = Readonly<{
  tier: ContextGoldTier;
  physical_store: 'none' | 'in-memory' | 'minio';
  postgres: string | null;
  tasks: readonly ContextTaskRow[];
  tier_gates: readonly GateResult[];
  timings: Readonly<{ evaluation_ms: number }>;
}>;

type CliRun = Readonly<{ status: number; stdout: string; stderr: string }>;

type SeedRevisionRecord = Readonly<{ sourceVersionId: string; chunkIds: readonly string[] }>;

type SeedIndex = Readonly<{
  byStableKey: ReadonlyMap<string, { finalVersionId: string; revisions: ReadonlyMap<string, SeedRevisionRecord> }>;
  byRevisionKey: ReadonlyMap<string, SeedRevisionRecord>;
}>;

type TierContext = Readonly<{
  tier: ContextGoldTier;
  gold: ContextGoldSet;
  brainUrl: string | null;
  seedIndex: SeedIndex | null;
  codexHome: string;
}>;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function taskEnv(
  shape: 'claude' | 'codex',
  brainUrl: string | null,
  codexHome: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CODEX_HOME'];
  delete env['ROSTER_BRAIN_URL'];
  env['FORCE_COLOR'] = '0';
  env['NO_COLOR'] = '1';
  if (shape === 'claude') {
    env['CLAUDECODE'] = '1';
    env['TZ'] = 'UTC';
    env['LANG'] = 'C';
  } else {
    env['CODEX_HOME'] = codexHome;
    env['TZ'] = 'Asia/Tokyo';
    env['LANG'] = 'en_US.UTF-8';
  }
  if (brainUrl !== null) env['ROSTER_BRAIN_URL'] = brainUrl;
  return env;
}

function contextArgs(task: ContextGoldTask, overrides: Readonly<{
  explain?: boolean;
  stepHint?: string | null;
  includeLegacyUnverified?: boolean;
}> = {}): string[] {
  const explain = overrides.explain ?? task.explain ?? true;
  const stepHint = overrides.stepHint === undefined ? task.stepHint ?? null : overrides.stepHint;
  const includeLegacy = overrides.includeLegacyUnverified ?? task.includeLegacyUnverified ?? false;
  return [
    'context',
    task.target,
    '--query',
    task.query,
    ...(stepHint === null ? [] : ['--step', stepHint]),
    ...(task.budgetTokens === undefined ? [] : ['--budget', String(task.budgetTokens)]),
    ...(explain ? ['--explain'] : []),
    ...(includeLegacy ? ['--include-legacy-unverified'] : []),
    '--json',
  ];
}

function spawnContext(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CliRun> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`context invocation timed out: ${args.join(' ')}`));
    }, 120_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolvePromise({ status: status ?? -1, stdout, stderr });
    });
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Bundle introspection
// ---------------------------------------------------------------------------

type Bundle = Record<string, unknown>;

function bundleFragments(bundle: Bundle): ObservedFragment[] {
  const agent = bundle['agent'] as Record<string, Record<string, unknown>>;
  const plan = bundle['plan'] as { definitions: readonly Record<string, unknown>[] };
  const sections = [
    agent['function'],
    agent['agent'],
    ...plan.definitions,
    ...(bundle['guidelines'] as readonly Record<string, unknown>[]),
    ...(bundle['lessons'] as readonly Record<string, unknown>[]),
    ...(bundle['brain_evidence'] as readonly Record<string, unknown>[]),
    ...(bundle['tool_uses'] as readonly Record<string, unknown>[]),
    ...(bundle['skill_refs'] as readonly Record<string, unknown>[]),
  ];
  return sections.map((fragment) => ({
    fragment_id: String(fragment!['fragment_id']),
    kind: String(fragment!['kind']),
    inclusion_reason: String(fragment!['inclusion_reason']),
    trust: String(fragment!['trust']),
    required: Boolean(fragment!['required']),
    ...(fragment!['kind'] === 'brain-evidence'
      ? { citationSourceVersionId: String((fragment!['citation'] as Record<string, unknown>)['source_version_id']) }
      : {}),
  }));
}

function fragmentIdSets(bundle: Bundle): Record<string, readonly string[]> {
  const agent = bundle['agent'] as Record<string, Record<string, unknown>>;
  const ids = (entries: readonly Record<string, unknown>[]): string[] => (
    entries.map((entry) => String(entry['fragment_id'])).sort()
  );
  return {
    agent: ids([agent['function']!, agent['agent']!]),
    plans: ids((bundle['plan'] as { definitions: readonly Record<string, unknown>[] }).definitions),
    guidelines: ids(bundle['guidelines'] as readonly Record<string, unknown>[]),
    lessons: ids(bundle['lessons'] as readonly Record<string, unknown>[]),
    brain_evidence: ids(bundle['brain_evidence'] as readonly Record<string, unknown>[]),
    tool_uses: ids(bundle['tool_uses'] as readonly Record<string, unknown>[]),
    skill_refs: ids(bundle['skill_refs'] as readonly Record<string, unknown>[]),
  };
}

function diagnosticsOf(bundle: Bundle): readonly Record<string, unknown>[] {
  return bundle['diagnostics'] as readonly Record<string, unknown>[];
}

function budgetOf(bundle: Bundle): Record<string, unknown> {
  return bundle['budget'] as Record<string, unknown>;
}

function evidenceFilteredEcho(bundle: Bundle): Record<string, number> {
  const echo = diagnosticsOf(bundle).find((entry) => entry['code'] === 'CONTEXT_EVIDENCE_FILTERED');
  if (echo === undefined) return {};
  const details = echo['details'] as Record<string, unknown>;
  return (details['filtered'] as Record<string, number> | undefined) ?? {};
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Expected evidence accounting derived from the seeds file (fixture-stable)
// ---------------------------------------------------------------------------

// The gold seeds all carry the gtm root plan's selector phrases and its plan
// scope label, so they enter exactly the pre-candidate pools of tasks that
// target the gtm root plan. This is stated fixture knowledge, not replicated
// retrieval logic: the runner never re-implements the membership predicate.
function seedsApplicable(task: ContextGoldTask): boolean {
  return task.target === 'gtm/social-manager#opportunity-discovery';
}

function expectedFilteredBreakdown(
  seeds: readonly ContextGoldSeed[],
  seedIndex: SeedIndex,
  task: ContextGoldTask,
): Record<ContextRetrievalFilterReason, number> {
  const expected = Object.fromEntries(CONTEXT_RETRIEVAL_FILTER_REASONS.map((reason) => [reason, 0])) as
    Record<ContextRetrievalFilterReason, number>;
  if (!seedsApplicable(task)) return expected;
  const optIn = task.includeLegacyUnverified ?? false;
  for (const seed of seeds) {
    const records = seedIndex.byStableKey.get(seed.stableKey)!;
    for (const [index, revision] of seed.revisions.entries()) {
      const record = records.revisions.get(revision.fixtureVersionKey)!;
      const chunkCount = record.chunkIds.length;
      if (index < seed.revisions.length - 1) {
        expected['superseded'] += chunkCount;
        continue;
      }
      if (seed.finalDisposition === 'tombstoned') expected['tombstoned'] += chunkCount;
      else if ((seed.privacy ?? 'internal') === 'secret') expected['privacy-incompatible'] += chunkCount;
      else if ((seed.trust ?? 'brain-extract-untrusted') === 'legacy-unverified' && !optIn) {
        expected['legacy-unverified'] += chunkCount;
      }
    }
  }
  return expected;
}

// ---------------------------------------------------------------------------
// Per-task gates
// ---------------------------------------------------------------------------

function gate(name: string, ok: boolean, detail: string): GateResult {
  return { name, ok, detail };
}

function parsedBundle(run: CliRun): Bundle | null {
  try {
    const parsed = JSON.parse(run.stdout) as Bundle;
    return typeof parsed === 'object' && parsed !== null && !('ok' in parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cliContractGate(task: ContextGoldTask, run: CliRun): GateResult {
  const lines = run.stdout.trimEnd().split('\n').length;
  if (task.registryVariant === 'partial') {
    let envelope: Record<string, unknown> | null = null;
    try {
      envelope = JSON.parse(run.stdout) as Record<string, unknown>;
    } catch {
      envelope = null;
    }
    const ok = run.status !== 0
      && lines === 1
      && envelope !== null
      && envelope['ok'] === false
      && envelope['code'] === 'BRAIN_CONFIGURATION_INCOMPLETE'
      && Array.isArray((envelope['details'] as Record<string, unknown> | undefined)?.['missing'])
      && !('schema_version' in (envelope ?? {}));
    return gate('cli-contract', ok, ok
      ? `nonzero exit with the closed BRAIN_CONFIGURATION_INCOMPLETE envelope (missing: ${JSON.stringify((envelope!['details'] as Record<string, unknown>)['missing'])})`
      : `expected the fatal partial-configuration envelope, saw status ${run.status}`);
  }
  const bundle = parsedBundle(run);
  const ok = run.status === 0 && run.stderr === '' && lines === 1 && bundle !== null;
  return gate('cli-contract', ok, ok
    ? 'exit 0, empty stderr, one-line JSON bundle'
    : `status ${run.status}, stderr ${run.stderr.length} bytes, ${lines} stdout lines`);
}

function recallGate(
  task: ContextGoldTask,
  bundle: Bundle,
  seedIndex: SeedIndex | null,
): GateResult {
  const fragments = bundleFragments(bundle);
  const resolveSeed = (stableKey: string): string | undefined => (
    seedIndex?.byStableKey.get(stableKey)?.finalVersionId
  );
  const failures: string[] = [];
  for (const entry of task.mandatory) {
    const verdict = evaluateMandatoryEntry(entry, fragments, resolveSeed);
    if (!verdict.ok) failures.push(verdict.detail);
  }
  return gate('recall', failures.length === 0, failures.length === 0
    ? `${task.mandatory.length} mandatory fragments present with their declared inclusion reasons`
    : failures.join('; '));
}

function forbiddenAbsent(
  entry: ContextGoldForbidden,
  fragments: readonly ObservedFragment[],
  seedIndex: SeedIndex | null,
): boolean {
  if (entry.kind === 'brain-evidence') {
    const record = seedIndex?.byStableKey.get(entry.ref);
    const revision = seedIndex?.byRevisionKey.get(entry.ref);
    const versionIds = new Set<string>();
    if (record !== undefined) for (const value of record.revisions.values()) versionIds.add(value.sourceVersionId);
    if (revision !== undefined) versionIds.add(revision.sourceVersionId);
    return !fragments.some((fragment) => fragment.kind === 'brain-evidence'
      && fragment.citationSourceVersionId !== undefined
      && versionIds.has(fragment.citationSourceVersionId));
  }
  return !fragments.some((fragment) => fragmentRefMatches(entry.kind, entry.ref, fragment));
}

function exclusionGate(
  task: ContextGoldTask,
  bundle: Bundle,
  seedIndex: SeedIndex | null,
): GateResult {
  const fragments = bundleFragments(bundle);
  const diagnostics = diagnosticsOf(bundle);
  const filtered = evidenceFilteredEcho(bundle);
  const failures: string[] = [];
  for (const entry of task.forbidden) {
    if (!forbiddenAbsent(entry, fragments, seedIndex)) {
      failures.push(`forbidden ${entry.kind} '${entry.ref}' leaked into the bundle`);
      continue;
    }
    if (entry.rationale === 'product-diagnostic') {
      const expected = entry.expect as { diagnostic: string; reason: string };
      const found = diagnostics.some((diagnostic) => {
        if (diagnostic['code'] !== expected.diagnostic) return false;
        const details = diagnostic['details'] as Record<string, unknown>;
        const subject = expected.diagnostic === 'CONTEXT_LESSON_EXCLUDED'
          ? details['lesson_id']
          : details['candidate_id'];
        return subject === entry.ref && details['reason'] === expected.reason;
      });
      if (!found) {
        failures.push(`no ${expected.diagnostic} diagnostic names '${entry.ref}' with reason '${expected.reason}'`);
      }
    } else if (entry.rationale === 'prefiltered') {
      const expected = entry.expect as { filtered: ContextRetrievalFilterReason };
      if ((filtered[expected.filtered] ?? 0) < 1) {
        failures.push(`the retrieval echo reports no '${expected.filtered}' filtering for '${entry.ref}'`);
      }
    }
  }
  return gate('exclusion', failures.length === 0, failures.length === 0
    ? `${task.forbidden.length} forbidden refs absent through their declared closed surfaces`
    : failures.join('; '));
}

function budgetAccountingGate(
  task: ContextGoldTask,
  bundle: Bundle,
  tier: TierContext,
): GateResult {
  const budget = budgetOf(bundle);
  const failures: string[] = [];
  const expectScalar = (field: string, expected: number | undefined): void => {
    if (expected === undefined) return;
    if (budget[field] !== expected) failures.push(`${field} = ${String(budget[field])}, expected ${expected}`);
  };
  const expect = task.budgetExpect ?? {};
  expectScalar('required_selectors_unmatched', expect.requiredSelectorsUnmatched);
  expectScalar('required_selectors_truncated', expect.requiredSelectorsTruncated);
  expectScalar('lessons_scope_ineligible', expect.lessonsScopeIneligible);
  expectScalar('lessons_duplicate', expect.lessonsDuplicate);
  expectScalar('candidate_diagnostics_omitted', expect.candidateDiagnosticsOmitted);
  expectScalar('lesson_diagnostics_omitted', expect.lessonDiagnosticsOmitted);
  expectScalar('retrieval_report_omitted', expect.retrievalReportOmitted);
  if (expect.lessonsBudgetExhausted !== undefined) {
    const observed = budget['lessons_budget_exhausted'] as number;
    if (typeof expect.lessonsBudgetExhausted === 'number') {
      if (observed !== expect.lessonsBudgetExhausted) {
        failures.push(`lessons_budget_exhausted = ${observed}, expected ${expect.lessonsBudgetExhausted}`);
      }
    } else if (observed < expect.lessonsBudgetExhausted.atLeast) {
      failures.push(`lessons_budget_exhausted = ${observed}, expected at least ${expect.lessonsBudgetExhausted.atLeast}`);
    }
  }
  const exclusions = budget['exclusions'] as Record<string, number>;
  if (tier.tier === 'local') {
    // No evidence exists on the local tier, so the whole closed exclusion map
    // must be zero unless a task explicitly declares otherwise.
    for (const reason of CONTEXT_EXCLUSION_REASONS) {
      const expected = expect.exclusions?.[reason] ?? 0;
      if (exclusions[reason] !== expected) failures.push(`exclusions.${reason} = ${exclusions[reason]}, expected ${expected}`);
    }
  } else if (expect.exclusions !== undefined) {
    for (const [reason, expected] of Object.entries(expect.exclusions)) {
      if (exclusions[reason] !== expected) failures.push(`exclusions.${reason} = ${exclusions[reason]}, expected ${expected}`);
    }
  }
  // Brain-tier evidence accounting exactness (the #355 pairing rule): the
  // echo's breakdown equals the seed-derived expectation exactly, and
  // evidence_prefiltered equals the breakdown sum.
  if (tier.tier === 'brain' && tier.seedIndex !== null) {
    const expected = expectedFilteredBreakdown(tier.gold.seeds, tier.seedIndex, task);
    const nonZero = Object.fromEntries(Object.entries(expected).filter(([, count]) => count > 0));
    const observed = evidenceFilteredEcho(bundle);
    if (stableStringify(observed) !== stableStringify(nonZero)) {
      failures.push(`filtered breakdown ${JSON.stringify(observed)} != expected ${JSON.stringify(nonZero)}`);
    }
    const sum = Object.values(expected).reduce((total, count) => total + count, 0);
    if (budget['evidence_prefiltered'] !== sum) {
      failures.push(`evidence_prefiltered = ${String(budget['evidence_prefiltered'])}, expected ${sum}`);
    }
  } else if (tier.tier === 'local' && budget['evidence_prefiltered'] !== 0) {
    failures.push(`evidence_prefiltered = ${String(budget['evidence_prefiltered'])}, expected 0`);
  }
  return gate('budget-accounting', failures.length === 0, failures.length === 0
    ? 'budget counters and exclusion accounting match the declared expectations exactly'
    : failures.join('; '));
}

function diagnosticsGate(task: ContextGoldTask, bundle: Bundle): GateResult {
  if (task.diagnosticsExpect === undefined) return gate('diagnostics', true, 'no diagnostics expectation declared');
  const observed = [...new Set(diagnosticsOf(bundle).map((entry) => String(entry['code'])))].sort();
  const expected = [...task.diagnosticsExpect].sort();
  const ok = stableStringify(observed) === stableStringify(expected);
  return gate('diagnostics', ok, ok
    ? `distinct diagnostic codes exactly [${expected.join(', ')}]`
    : `observed [${observed.join(', ')}], expected [${expected.join(', ')}]`);
}

function explanationGate(task: ContextGoldTask, bundle: Bundle): GateResult {
  const explain = task.explain ?? true;
  if (!explain) return gate('explanations', true, 'task runs with explain disabled');
  const failures: string[] = [];
  for (const entry of bundle['provenance'] as readonly Record<string, unknown>[]) {
    const reason = String(entry['inclusion_reason']);
    const explanation = entry['explanation'];
    if (typeof explanation !== 'string' || explanation.length === 0) {
      failures.push(`provenance '${String(entry['fragment_id'])}' carries no explanation`);
      continue;
    }
    if (CANONICAL_EXPLANATIONS[reason] !== explanation) {
      failures.push(`reason '${reason}' explained as '${explanation}'`);
    }
  }
  return gate('explanations', failures.length === 0, failures.length === 0
    ? 'every provenance entry carries the canonical explanation for its inclusion reason'
    : failures.join('; '));
}

function trustSeparationGate(bundle: Bundle): GateResult {
  const failures: string[] = [];
  for (const fragment of bundleFragments(bundle)) {
    if (fragment.kind === 'brain-evidence') continue;
    const expected = EXPECTED_TRUST_BY_KIND[fragment.kind];
    if (expected !== undefined && fragment.trust !== expected) {
      failures.push(`${fragment.fragment_id} carries trust '${fragment.trust}', expected '${expected}'`);
    }
  }
  for (const entry of bundle['provenance'] as readonly Record<string, unknown>[]) {
    if (String(entry['fragment_id']).startsWith('request:') && entry['trust'] !== 'host-asserted') {
      failures.push(`${String(entry['fragment_id'])} carries trust '${String(entry['trust'])}', expected 'host-asserted'`);
    }
  }
  return gate('trust-separation', failures.length === 0, failures.length === 0
    ? 'every fragment kind carries its structural trust class'
    : failures.join('; '));
}

function hostStructureGate(bundle: Bundle): GateResult {
  const failures: string[] = [];
  for (const fragment of bundle['skill_refs'] as readonly Record<string, unknown>[]) {
    const hosts = (fragment['content'] as Record<string, unknown>)['hosts'] as Record<string, Record<string, unknown>>;
    const keys = Object.keys(hosts).sort();
    if (stableStringify(keys) !== stableStringify(['claude', 'codex'])) {
      failures.push(`${String(fragment['fragment_id'])} hosts keys are [${keys.join(', ')}]`);
      continue;
    }
    const claude = hosts['claude']!;
    const codex = hosts['codex']!;
    if (claude['kind'] !== 'host-native' || codex['kind'] !== 'host-native') {
      failures.push(`${String(fragment['fragment_id'])} carries a non-host-native locator`);
    } else if (stableStringify(claude) !== stableStringify(codex)) {
      failures.push(`${String(fragment['fragment_id'])} host locators differ`);
    }
  }
  return gate('host-structure', failures.length === 0, failures.length === 0
    ? 'every skill-ref carries exactly {claude, codex} with deep-equal host-native locators'
    : failures.join('; '));
}

function citationGate(bundle: Bundle): GateResult {
  const failures: string[] = [];
  for (const entry of bundle['brain_evidence'] as readonly Record<string, unknown>[]) {
    const citation = entry['citation'] as Record<string, unknown>;
    const keys = Object.keys(citation);
    if (stableStringify(keys) !== stableStringify(CITATION_FIELDS)) {
      failures.push(`citation fields [${keys.join(', ')}]`);
      continue;
    }
    const content = String(entry['content']);
    const expected = `sha256:${sha256Hex(content)}`;
    if (citation['content_hash'] !== expected) {
      failures.push(`content hash mismatch for ${String(entry['fragment_id'])}`);
    }
  }
  return gate('citation', failures.length === 0, failures.length === 0
    ? 'every delivered candidate carries the seven-field envelope and re-verifies sha256(content)'
    : failures.join('; '));
}

function embeddingOptionalGate(bundle: Bundle): GateResult {
  const echo = diagnosticsOf(bundle).find((entry) => entry['code'] === 'CONTEXT_EVIDENCE_FILTERED');
  if (echo === undefined) return gate('embedding-optional', false, 'no retrieval echo to prove the embedding mode surfaced');
  const details = echo['details'] as Record<string, unknown>;
  const modes = (details['modes'] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const embedding = modes['embedding'];
  const ok = embedding !== undefined && embedding['status'] !== 'used';
  return gate('embedding-optional', ok, ok
    ? `embedding mode surfaced as '${String(embedding!['status'])}' with every gate passing`
    : `embedding mode status: ${JSON.stringify(embedding)}`);
}

function reductionGate(
  bundle: Bundle,
  run: CliRun,
  baselineTokens: number,
  priorGates: readonly GateResult[],
): { gateResult: GateResult; measuredTokens: number; reduction: number } {
  const reported = budgetOf(bundle)['total_tokens'] as number;
  const observed = estimatedTokens(Buffer.byteLength(run.stdout.trimEnd(), 'utf8'));
  const measuredTokens = Math.max(reported, observed);
  const reduction = 1 - measuredTokens / baselineTokens;
  // Reduction is read only after recall/exclusion/coverage pass, so the
  // "without required-context loss" clause is structural.
  const prerequisitesPassed = priorGates.every((entry) => entry.ok);
  const ok = prerequisitesPassed && measuredTokens <= CONTEXT_REDUCTION_THRESHOLD * baselineTokens;
  return {
    gateResult: gate('reduction', ok, prerequisitesPassed
      ? `${measuredTokens} bundle tokens vs ${baselineTokens} eager tokens — ${(reduction * 100).toFixed(1)} % reduction (gate ≥ 60 %)`
      : 'not evaluated: a recall/exclusion/accounting gate failed first'),
    measuredTokens,
    reduction,
  };
}

// --- L7 (A8'): the explain toggle changes explanation bytes and their derived
// size accounting, and NOTHING else.
const EXPLAIN_PROJECTION_BUDGET_FIELDS: readonly string[] = Object.freeze([
  'mandatory_bytes',
  'mandatory_tokens',
  'optional_bytes',
  'optional_tokens',
  'total_bytes',
  'total_tokens',
  'remaining_tokens',
]);

export function explainComparisonProjection(bundle: Bundle): Bundle {
  const copy = JSON.parse(JSON.stringify(bundle)) as Bundle;
  delete (copy['request'] as Record<string, unknown>)['explain'];
  for (const entry of copy['provenance'] as Record<string, unknown>[]) delete entry['explanation'];
  const budget = copy['budget'] as Record<string, unknown>;
  for (const field of EXPLAIN_PROJECTION_BUDGET_FIELDS) delete budget[field];
  return copy;
}

function explainToggleGate(onRun: CliRun, offRun: CliRun): GateResult {
  const on = parsedBundle(onRun);
  const off = parsedBundle(offRun);
  if (on === null || off === null) return gate('explain-toggle', false, 'one of the paired runs produced no bundle');
  const failures: string[] = [];
  const onBudget = budgetOf(on);
  const explanationBytes = (on['provenance'] as readonly Record<string, unknown>[])
    .reduce((total, entry) => total + (typeof entry['explanation'] === 'string'
      ? Buffer.byteLength(`,"explanation":${JSON.stringify(entry['explanation'])}`, 'utf8')
      : 0), 0);
  // (i) sufficient headroom, asserted: admission cannot differ when the
  // explain-on run rejected nothing for budget and its remaining headroom
  // exceeds the whole explanation cost.
  if ((onBudget['remaining_tokens'] as number) <= estimatedTokens(explanationBytes)) {
    failures.push(`remaining_tokens ${String(onBudget['remaining_tokens'])} does not exceed the ${estimatedTokens(explanationBytes)}-token explanation cost`);
  }
  for (const field of ['lessons_budget_exhausted', 'candidate_diagnostics_omitted', 'lesson_diagnostics_omitted', 'retrieval_report_omitted']) {
    if (onBudget[field] !== 0) failures.push(`explain-on ${field} = ${String(onBudget[field])}, headroom precondition violated`);
  }
  // (ii) equality under the declared projection.
  if (stableStringify(explainComparisonProjection(on)) !== stableStringify(explainComparisonProjection(off))) {
    failures.push('projected bundles differ beyond explanations and derived size fields');
  }
  // (iii) separately pinned identities.
  if (stableStringify(fragmentIdSets(on)) !== stableStringify(fragmentIdSets(off))) {
    failures.push('fragment-id sets differ between explain modes');
  }
  if (stableStringify(diagnosticsOf(on)) !== stableStringify(diagnosticsOf(off))) {
    failures.push('diagnostics lists differ between explain modes');
  }
  if (stableStringify(onBudget['exclusions']) !== stableStringify(budgetOf(off)['exclusions'])) {
    failures.push('exclusion counter maps differ between explain modes');
  }
  for (const field of ['candidate_diagnostics_omitted', 'lesson_diagnostics_omitted']) {
    if (onBudget[field] !== budgetOf(off)[field]) failures.push(`${field} differs between explain modes`);
  }
  return gate('explain-toggle', failures.length === 0, failures.length === 0
    ? 'explain mode changes explanation bytes and their derived size accounting, and nothing else'
    : failures.join('; '));
}

function stepHintGate(hintedRun: CliRun, unhintedRun: CliRun): GateResult {
  const hinted = parsedBundle(hintedRun);
  const unhinted = parsedBundle(unhintedRun);
  if (hinted === null || unhinted === null) return gate('step-hint', false, 'one of the paired runs produced no bundle');
  const failures: string[] = [];
  if (stableStringify(fragmentIdSets(hinted)) !== stableStringify(fragmentIdSets(unhinted))) {
    failures.push('the step hint changed the fragment SET, not only ordering');
  }
  const hintProvenance = (hinted['provenance'] as readonly Record<string, unknown>[])
    .some((entry) => entry['fragment_id'] === 'request:step_hint');
  if (!hintProvenance) failures.push('the hinted run carries no request:step_hint provenance');
  const lessonsOf = (bundle: Bundle): string[] => (bundle['lessons'] as readonly Record<string, unknown>[])
    .map((entry) => String(entry['fragment_id']));
  const orderChanged = stableStringify(lessonsOf(hinted)) !== stableStringify(lessonsOf(unhinted));
  return gate('step-hint', failures.length === 0, failures.length === 0
    ? `fragment set identical; lesson ordering ${orderChanged ? 'changed (disclosed as ordering-only)' : 'unchanged'}`
    : failures.join('; '));
}

function legacyPairGate(
  withFlag: CliRun,
  withoutFlag: CliRun,
  seedIndex: SeedIndex,
  seeds: readonly ContextGoldSeed[],
): GateResult {
  const flagged = parsedBundle(withFlag);
  const plain = parsedBundle(withoutFlag);
  if (flagged === null || plain === null) return gate('legacy-optin', false, 'one of the paired runs produced no bundle');
  const failures: string[] = [];
  const legacyVersionIds = new Set(seeds
    .filter((seed) => (seed.trust ?? 'brain-extract-untrusted') === 'legacy-unverified')
    .map((seed) => seedIndex.byStableKey.get(seed.stableKey)!.finalVersionId));
  const plainEvidence = plain['brain_evidence'] as readonly Record<string, unknown>[];
  if (plainEvidence.some((entry) => legacyVersionIds.has(String((entry['citation'] as Record<string, unknown>)['source_version_id'])))) {
    failures.push('a legacy row returned without the opt-in');
  }
  const flaggedEvidence = flagged['brain_evidence'] as readonly Record<string, unknown>[];
  const index = flaggedEvidence.findIndex((entry) => legacyVersionIds.has(String((entry['citation'] as Record<string, unknown>)['source_version_id'])));
  if (index < 0) failures.push('the opt-in did not return the legacy row');
  else {
    if (flaggedEvidence[index]!['trust'] !== 'legacy-unverified') {
      failures.push('the opt-in promoted the legacy trust class');
    }
    if (!flaggedEvidence.slice(0, index).every((entry) => entry['trust'] !== 'legacy-unverified')
      || !flaggedEvidence.slice(index).every((entry) => entry['trust'] === 'legacy-unverified')) {
      failures.push('legacy evidence is not floored below every non-legacy candidate');
    }
  }
  return gate('legacy-optin', failures.length === 0, failures.length === 0
    ? 'absent without the flag; returned floored with its trust class retained under it'
    : failures.join('; '));
}

// ---------------------------------------------------------------------------
// Tier execution
// ---------------------------------------------------------------------------

type TaskMeasurement = Readonly<{
  task: ContextGoldTask;
  main: CliRun;
  repeat: CliRun | null;
  delta: CliRun | null;
  companion: CliRun | null;
}>;

async function measureTask(
  task: ContextGoldTask,
  roots: ReadonlyMap<ContextGoldRegistryVariant, string>,
  tier: TierContext,
  full: boolean,
): Promise<TaskMeasurement> {
  const variant = task.registryVariant ?? (task.tier === 'brain' ? 'brain' : 'local');
  const root = roots.get(variant)!;
  const args = contextArgs(task);
  const claudeEnv = taskEnv('claude', tier.brainUrl, tier.codexHome);
  const main = await spawnContext(root, args, claudeEnv);
  if (!full) return { task, main, repeat: null, delta: null, companion: null };
  const repeat = await spawnContext(root, args, claudeEnv);
  const delta = await spawnContext(root, args, taskEnv('codex', tier.brainUrl, tier.codexHome));
  let companion: CliRun | null = null;
  if (task.id.startsWith('L7-')) {
    companion = await spawnContext(root, contextArgs(task, { explain: false }), claudeEnv);
  } else if (task.id.startsWith('L8-')) {
    companion = await spawnContext(root, contextArgs(task, { stepHint: null }), claudeEnv);
  } else if (task.id.startsWith('B3-')) {
    companion = await spawnContext(root, contextArgs(task, { includeLegacyUnverified: false }), claudeEnv);
  }
  return { task, main, repeat, delta, companion };
}

function mainGates(task: ContextGoldTask, main: CliRun, tier: TierContext): GateResult[] {
  const gates: GateResult[] = [cliContractGate(task, main)];
  if ((task.registryVariant ?? (task.tier === 'brain' ? 'brain' : 'local')) === 'partial') return gates;
  const bundle = parsedBundle(main);
  if (bundle === null) {
    gates.push(gate('recall', false, 'no bundle to evaluate'));
    return gates;
  }
  gates.push(recallGate(task, bundle, tier.seedIndex));
  gates.push(exclusionGate(task, bundle, tier.seedIndex));
  gates.push(budgetAccountingGate(task, bundle, tier));
  gates.push(diagnosticsGate(task, bundle));
  gates.push(explanationGate(task, bundle));
  gates.push(trustSeparationGate(bundle));
  gates.push(hostStructureGate(bundle));
  if (tier.tier === 'brain') {
    gates.push(citationGate(bundle));
    gates.push(embeddingOptionalGate(bundle));
  }
  return gates;
}

function taskRow(
  measurement: TaskMeasurement,
  tier: TierContext,
  baselineTokens: number,
): ContextTaskRow {
  const { task, main } = measurement;
  const variant = task.registryVariant ?? (task.tier === 'brain' ? 'brain' : 'local');
  const gates = mainGates(task, main, tier);
  const bundle = variant === 'partial' ? null : parsedBundle(main);

  if (measurement.repeat !== null) {
    const ok = main.status === measurement.repeat.status && main.stdout === measurement.repeat.stdout;
    gates.push(gate('determinism', ok, ok
      ? 'two consecutive invocations are byte-identical'
      : 'consecutive invocations diverged'));
  }
  if (measurement.delta !== null) {
    const ok = main.status === measurement.delta.status && main.stdout === measurement.delta.stdout;
    gates.push(gate('host-equivalence', ok, ok
      ? 'claude-shaped and codex-shaped environments produce byte-identical output'
      : 'host-shaped environment deltas changed the output'));
  }
  if (measurement.companion !== null) {
    if (task.id.startsWith('L7-')) gates.push(explainToggleGate(main, measurement.companion));
    else if (task.id.startsWith('L8-')) gates.push(stepHintGate(main, measurement.companion));
    else if (task.id.startsWith('B3-') && tier.seedIndex !== null) {
      gates.push(legacyPairGate(main, measurement.companion, tier.seedIndex, tier.gold.seeds));
    }
  }

  let bundleTokens: number | null = null;
  let reduction: number | null = null;
  const ratioGated = RATIO_GATED_TASK_IDS.includes(task.id);
  if (bundle !== null) {
    const measured = reductionGate(bundle, main, baselineTokens, gates);
    bundleTokens = measured.measuredTokens;
    reduction = Math.round(measured.reduction * 1e4) / 1e4;
    if (ratioGated) gates.push(measured.gateResult);
  }
  return {
    id: task.id,
    family: task.family,
    tier: task.tier,
    registry_variant: variant,
    exit_status: main.status,
    bundle_tokens: bundleTokens,
    baseline_tokens: baselineTokens,
    reduction,
    ratio_gated: ratioGated,
    gates,
  };
}

function tierExplanationGates(measurements: readonly TaskMeasurement[], tier: TierContext): GateResult[] {
  const observedReasons = new Set<string>();
  for (const measurement of measurements) {
    const bundle = parsedBundle(measurement.main);
    if (bundle === null) continue;
    for (const entry of bundle['provenance'] as readonly Record<string, unknown>[]) {
      observedReasons.add(String(entry['inclusion_reason']));
    }
  }
  const gates: GateResult[] = [];
  const unknown = [...observedReasons].filter((reason) => CANONICAL_EXPLANATIONS[reason] === undefined);
  gates.push(gate('explanation-vocabulary', unknown.length === 0, unknown.length === 0
    ? `observed inclusion reasons are a subset of the closed thirteen-reason vocabulary (${observedReasons.size} observed)`
    : `unknown inclusion reasons observed: ${unknown.join(', ')}`));
  if (tier.tier === 'local') {
    const brainOnly = BRAIN_ONLY_INCLUSION_REASONS.filter((reason) => observedReasons.has(reason));
    gates.push(gate('local-reason-subset', brainOnly.length === 0, brainOnly.length === 0
      ? 'no Brain-only inclusion reason observed on the local tier'
      : `Brain-only reasons observed locally: ${brainOnly.join(', ')}`));
  } else {
    const missing = BRAIN_ONLY_INCLUSION_REASONS.filter((reason) => !observedReasons.has(reason));
    gates.push(gate('brain-reasons-observed', missing.length === 0, missing.length === 0
      ? 'both selector-match and required-selector-match observed on the brain tier'
      : `missing Brain reasons: ${missing.join(', ')}`));
  }
  return gates;
}

export type RunContextEvaluationOptions = Readonly<{
  tier: ContextGoldTier;
  gold: ContextGoldSet;
  concurrency?: number;
}>;

export type ContextEvaluationOutcome = Readonly<{
  result: ContextTierOutcome;
  postgresVersion: string | null;
}>;

type MaterializedTier = Readonly<{
  roots: ReadonlyMap<ContextGoldRegistryVariant, string>;
  fixtures: readonly ContextGoldWorkspaceFixture[];
  corpus: RetrievalCorpus | null;
  tierContext: TierContext;
  cleanup: () => Promise<void>;
}>;

async function seedGoldCorpus(corpus: RetrievalCorpus, seeds: readonly ContextGoldSeed[]): Promise<SeedIndex> {
  const byStableKey = new Map<string, { finalVersionId: string; revisions: Map<string, SeedRevisionRecord> }>();
  const byRevisionKey = new Map<string, SeedRevisionRecord>();
  for (const seed of seeds) {
    const revisions = new Map<string, SeedRevisionRecord>();
    let sourceId = '';
    let finalVersionId = '';
    for (const revision of seed.revisions) {
      const result = await ingestCorpusSource(corpus, {
        stableKey: seed.stableKey,
        body: revision.body,
        labels: seed.labels.map((label) => ({ ...label })),
        privacy: seed.privacy ?? 'internal',
        trust: seed.trust ?? 'brain-extract-untrusted',
      });
      revisions.set(revision.fixtureVersionKey, {
        sourceVersionId: result.sourceVersionId,
        chunkIds: result.chunkIds,
      });
      byRevisionKey.set(revision.fixtureVersionKey, {
        sourceVersionId: result.sourceVersionId,
        chunkIds: result.chunkIds,
      });
      sourceId = result.sourceId;
      finalVersionId = result.sourceVersionId;
    }
    if (seed.finalDisposition === 'tombstoned') {
      await tombstoneBrainSource(corpus.adminPool, {
        sourceId,
        requestKey: `context-gold-tombstone-${seed.stableKey}`,
        actor: { actorId: 'context-gold', assurance: 'host-attested', host: 'codex', sessionId: 'context-gold' },
        reason: 'gold fixture tombstone',
        provenance: { fixture: 'context-gold' },
      });
    }
    byStableKey.set(seed.stableKey, { finalVersionId, revisions });
  }
  return { byStableKey, byRevisionKey };
}

async function materializeTier(tier: ContextGoldTier, gold: ContextGoldSet): Promise<MaterializedTier> {
  const codexHome = mkdtempSync(join(tmpdir(), 'roster-context-gold-codex-home-'));
  const roots = new Map<ContextGoldRegistryVariant, string>();
  const fixtures: ContextGoldWorkspaceFixture[] = [];
  const variants: ContextGoldRegistryVariant[] = tier === 'brain'
    ? ['brain']
    : [...new Set(gold.tasks.filter((task) => task.tier === 'local')
        .map((task) => task.registryVariant ?? 'local'))];
  for (const variant of variants) {
    const fixture = buildContextGoldWorkspace({ registry: variant });
    fixtures.push(fixture);
    roots.set(variant, fixture.root);
  }

  let corpus: RetrievalCorpus | null = null;
  let brainUrl: string | null = null;
  let seedIndex: SeedIndex | null = null;
  if (tier === 'brain') {
    // The identity is DERIVED from the materialized workspace through the
    // production parse, never restated (the #355 pattern): if the registry
    // parse and the authority derivation disagree about a defaulted field,
    // bootstrap and retrieval land on different namespace fingerprints and the
    // whole tier fails loudly.
    const registry = parseWorkspaceRegistry(readFileSync(join(roots.get('brain')!, 'roster.yaml'), 'utf8'));
    corpus = await createRetrievalCorpus({
      workspaceId: registry.workspace_id,
      brainConfig: registry.brain!,
      ...(HAS_TEST_S3
        ? {
            objectStore: async () => createMinioTransportStore(registry.brain!, freshMinioBucketName()),
          }
        : {}),
    });
    brainUrl = runtimeUrlFor(corpus);
    seedIndex = await seedGoldCorpus(corpus, gold.seeds);
  }

  return {
    roots,
    fixtures,
    corpus,
    tierContext: { tier, gold, brainUrl, seedIndex, codexHome },
    cleanup: async () => {
      if (corpus !== null) await corpus.close();
      for (const fixture of fixtures) fixture.cleanup();
      rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

// The rebuild-comparison core: everything a fresh materialization (and, on the
// brain tier, a fresh database and object namespace) must reproduce exactly.
// Rows are keyed by task id and gate details are built from fixture-stable
// keys, never from minted identifiers or temporary paths. Cross-run gates
// (determinism, host-equivalence, the paired-companion contracts) are cycle-1
// facts about REPEATED invocations, so the rebuild compares the main-run gates.
const MAIN_GATE_NAMES: ReadonlySet<string> = new Set([
  'cli-contract',
  'recall',
  'exclusion',
  'budget-accounting',
  'diagnostics',
  'explanations',
  'trust-separation',
  'host-structure',
  'citation',
  'embedding-optional',
  'reduction',
]);

function rebuildCore(rows: readonly ContextTaskRow[]): unknown {
  return rows.map((row) => ({
    id: row.id,
    exit_status: row.exit_status,
    bundle_tokens: row.bundle_tokens,
    reduction: row.reduction,
    gates: row.gates.filter((entry) => MAIN_GATE_NAMES.has(entry.name)),
  }));
}

export async function runContextEvaluation(options: RunContextEvaluationOptions): Promise<ContextEvaluationOutcome> {
  const startedAt = Date.now();
  const gold = options.gold;
  const tasks = gold.tasks.filter((task) => task.tier === options.tier);
  const baselineTokens = gold.baseline.totals.tokens;
  const concurrency = options.concurrency ?? 4;

  const first = await materializeTier(options.tier, gold);
  let postgresVersion: string | null = null;
  let rows: ContextTaskRow[];
  let measurements: TaskMeasurement[];
  try {
    if (first.corpus !== null) {
      const version = await first.corpus.adminPool.query<{ server_version: string }>('SHOW server_version');
      postgresVersion = version.rows[0]!.server_version;
    }
    measurements = await mapWithConcurrency(tasks, concurrency, (task) => (
      measureTask(task, first.roots, first.tierContext, true)
    ));
    rows = measurements.map((measurement) => taskRow(measurement, first.tierContext, baselineTokens));
  } finally {
    await first.cleanup();
  }

  // Independent rebuild: a second full materialize+seed+measure cycle from
  // scratch must reproduce the rebuild core exactly.
  const second = await materializeTier(options.tier, gold);
  let rebuildOk: boolean;
  let rebuildDetail: string;
  try {
    const secondMeasurements = await mapWithConcurrency(tasks, concurrency, (task) => (
      measureTask(task, second.roots, second.tierContext, false)
    ));
    const secondRows = secondMeasurements.map((measurement) => (
      taskRow(measurement, second.tierContext, baselineTokens)
    ));
    rebuildOk = stableStringify(rebuildCore(rows)) === stableStringify(rebuildCore(secondRows));
    rebuildDetail = rebuildOk
      ? 'two independent materialize+seed+measure cycles agree on every task row'
      : 'independent rebuild produced different task rows';
  } finally {
    await second.cleanup();
  }

  const tierGates: GateResult[] = [
    ...tierExplanationGates(measurements, first.tierContext),
    gate('independent-rebuild', rebuildOk, rebuildDetail),
  ];

  return {
    result: {
      tier: options.tier,
      physical_store: options.tier === 'brain' ? (HAS_TEST_S3 ? 'minio' : 'in-memory') : 'none',
      postgres: postgresVersion,
      tasks: rows,
      tier_gates: tierGates,
      timings: { evaluation_ms: Date.now() - startedAt },
    },
    postgresVersion,
  };
}

// ---------------------------------------------------------------------------
// Result manifest
// ---------------------------------------------------------------------------

export type ContextResultManifest = Readonly<Record<string, unknown>>;

function gitDescribe(root: string): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: '0'.repeat(40), dirty: true };
  }
}

export function contextHarnessDigests(root: string = REPOSITORY_ROOT): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const file of CONTEXT_HARNESS_FILES) {
    try {
      digests[file] = `sha256:${sha256Hex(readFileSync(join(root, file)))}`;
    } catch {
      digests[file] = 'sha256:absent';
    }
  }
  return digests;
}

export type ComposeContextManifestOptions = Readonly<{
  gold: ContextGoldSet;
  tiers: readonly ContextTierOutcome[];
  generatedAt: string;
  root?: string;
}>;

export function composeContextManifest(options: ComposeContextManifestOptions): ContextResultManifest {
  const root = options.root ?? REPOSITORY_ROOT;
  const git = gitDescribe(root);
  const tiers: Record<string, unknown> = {};
  let wallClockMs = 0;
  for (const tier of options.tiers) {
    tiers[tier.tier] = tier;
    wallClockMs += tier.timings.evaluation_ms;
  }
  const workspaceFiles = Object.fromEntries(options.gold.baseline.files
    .map((file) => [file.path, `sha256:${file.sha256}`]));
  return {
    schema_version: CONTEXT_MANIFEST_SCHEMA_VERSION,
    kind: 'context_quality_manifest',
    generated_at: options.generatedAt,
    authoritative: !git.dirty,
    git: { commit: git.commit, dirty: git.dirty },
    fixture: { files: options.gold.files, sha256: options.gold.sha256 },
    workspace_fixture: {
      files: workspaceFiles,
      sha256: `sha256:${sha256Hex(stableStringify(workspaceFiles))}`,
    },
    harness: contextHarnessDigests(root),
    config: {
      estimator: options.gold.baseline.estimator,
      default_budget_tokens: CONTEXT_DEFAULT_BUDGET_TOKENS,
      reduction_threshold: CONTEXT_REDUCTION_THRESHOLD,
      baseline_tokens: options.gold.baseline.totals.tokens,
      ratio_gated_tasks: [...RATIO_GATED_TASK_IDS],
    },
    environment: {
      node: process.version,
      os: `${process.platform}-${process.arch}`,
      kind: process.env['CI'] === undefined ? 'dev' : 'ci',
      postgres: options.tiers.find((tier) => tier.postgres !== null)?.postgres ?? null,
      physical_store: options.tiers.find((tier) => tier.tier === 'brain')?.physical_store ?? 'none',
    },
    comparison_exclusions: [...CONTEXT_MANIFEST_COMPARISON_EXCLUSIONS],
    tiers,
    timings: { wall_clock_ms: wallClockMs },
    corpus: {
      seeds: options.gold.seeds.length,
      revisions: options.gold.seeds.reduce((total, seed) => total + seed.revisions.length, 0),
      tasks: {
        local: options.gold.tasks.filter((task) => task.tier === 'local').length,
        brain: options.gold.tasks.filter((task) => task.tier === 'brain').length,
      },
    },
  };
}

function removePointer(value: Record<string, unknown>, pointer: string): void {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let cursor: Record<string, unknown> | undefined = value;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = cursor?.[segment];
    if (next === null || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  if (cursor !== undefined) delete cursor[segments.at(-1)!];
}

export function contextManifestComparisonProjection(manifest: ContextResultManifest): ContextResultManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  for (const pointer of CONTEXT_MANIFEST_COMPARISON_EXCLUSIONS) removePointer(copy, pointer);
  return copy;
}
