import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTEXT_EXCLUSION_REASONS,
  CONTEXT_RETRIEVAL_FILTER_REASONS,
  type ContextExclusionReason,
  type ContextFragmentKind,
  type ContextInclusionReason,
  type ContextRetrievalFilterReason,
} from '../../src/lib/workspace-context.ts';
import {
  lintPrivacyArtifacts,
  type PrivacyLintFinding,
  type PrivacyLintTables,
} from './privacy-lint.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPOSITORY_ROOT = join(HERE, '..', '..');
export const CONTEXT_GOLD_DIR = join(REPOSITORY_ROOT, 'test', 'fixtures', 'context-gold');
export const CONTEXT_GOLD_WORKSPACE_DIR = join(REPOSITORY_ROOT, 'test', 'fixtures', 'context-gold-workspace');
export const CONTEXT_EVAL_DOCS_DIR = join(REPOSITORY_ROOT, 'docs', 'evals', 'context-quality');

// The lint's allowlist of synthetic workspace identities lives HERE, not in the
// fixture: an identity that leaked into a gold task must not be able to bless
// itself by appearing in the fixture's own declaration (`validateContextGoldSet`
// asserts the declared set is a subset of this constant).
export const CONTEXT_SYNTHETIC_WORKSPACE_IDS: readonly string[] = Object.freeze(['context-gold-workspace']);

export const CONTEXT_GOLD_WORKSPACE_ID = 'context-gold-workspace';

export const CONTEXT_GOLD_TIERS = ['local', 'brain'] as const;
export type ContextGoldTier = (typeof CONTEXT_GOLD_TIERS)[number];

export const CONTEXT_GOLD_FAMILIES = ['recall', 'exclusion', 'budget', 'coverage', 'contract'] as const;
export type ContextGoldFamily = (typeof CONTEXT_GOLD_FAMILIES)[number];

export const CONTEXT_GOLD_REGISTRY_VARIANTS = ['local', 'brain', 'partial'] as const;
export type ContextGoldRegistryVariant = (typeof CONTEXT_GOLD_REGISTRY_VARIANTS)[number];

// A6: the evaluator's own closed rationale vocabulary. `outside-closure` is an
// EVALUATOR assertion of structural absence (Roster emits no diagnostic for
// never-selectable artifacts and none is invented); the other two pair with a
// product-emitted closed surface.
export const CONTEXT_FORBIDDEN_RATIONALES = ['outside-closure', 'product-diagnostic', 'prefiltered'] as const;
export type ContextForbiddenRationale = (typeof CONTEXT_FORBIDDEN_RATIONALES)[number];

const CONTEXT_INCLUSION_REASONS: readonly ContextInclusionReason[] = Object.freeze([
  'target-function',
  'target-agent',
  'selected-plan-root',
  'nested-plan-closure',
  'agent-default-guideline',
  'plan-referenced-guideline',
  'applicable-lesson',
  'plan-tool-step',
  'tool-skill-ref',
  'selector-match',
  'required-selector-match',
  'host-query',
  'host-step-hint',
]);

const CONTEXT_FRAGMENT_KINDS: readonly ContextFragmentKind[] = Object.freeze([
  'function',
  'agent',
  'plan',
  'guideline',
  'lesson',
  'brain-evidence',
  'tool-use',
  'skill-ref',
]);

export type ContextGoldMandatory = Readonly<{
  kind: ContextFragmentKind;
  // EXACTLY ONE of `ref` / `anyOf` (A5; schema-enforced). `ref` is the
  // qualified id; tool-use ⇒ the effective tool id (matched on the
  // `tool-use:<id>:` prefix — the semantic hash is derived, not authored);
  // skill-ref ⇒ the canonical skill_ref; brain-evidence ⇒ the seed stableKey.
  ref?: string;
  anyOf?: readonly string[];
  inclusionReason: ContextInclusionReason;
}>;

export type ContextGoldForbiddenExpect =
  | 'not-selectable'
  | Readonly<{ diagnostic: 'CONTEXT_LESSON_EXCLUDED' | 'CONTEXT_EVIDENCE_EXCLUDED'; reason: string }>
  | Readonly<{ filtered: ContextRetrievalFilterReason }>;

export type ContextGoldForbidden = Readonly<{
  kind: ContextFragmentKind;
  ref: string;
  rationale: ContextForbiddenRationale;
  expect: ContextGoldForbiddenExpect;
}>;

export type ContextGoldBudgetExpect = Readonly<{
  requiredSelectorsUnmatched?: number;
  requiredSelectorsTruncated?: number;
  lessonsScopeIneligible?: number;
  lessonsDuplicate?: number;
  lessonsBudgetExhausted?: number | Readonly<{ atLeast: number }>;
  candidateDiagnosticsOmitted?: number;
  lessonDiagnosticsOmitted?: number;
  retrievalReportOmitted?: 0 | 1;
  exclusions?: Readonly<Partial<Record<ContextExclusionReason, number>>>;
}>;

export type ContextGoldTask = Readonly<{
  id: string;
  tier: ContextGoldTier;
  family: ContextGoldFamily;
  target: string;
  query: string;
  stepHint?: string;
  budgetTokens?: number;
  explain?: boolean;
  includeLegacyUnverified?: boolean;
  registryVariant?: ContextGoldRegistryVariant;
  mandatory: readonly ContextGoldMandatory[];
  forbidden: readonly ContextGoldForbidden[];
  budgetExpect?: ContextGoldBudgetExpect;
  diagnosticsExpect?: readonly string[];
  notes: string;
}>;

export type ContextGoldSeedRevision = Readonly<{
  fixtureVersionKey: string;
  body: string;
}>;

export type ContextGoldSeed = Readonly<{
  stableKey: string;
  labels: readonly Readonly<{ workspace: string; function?: string; agent?: string; plan?: string }>[];
  privacy?: 'public' | 'internal' | 'secret';
  trust?: 'brain-extract-untrusted' | 'legacy-unverified';
  finalDisposition: 'current' | 'tombstoned';
  revisions: readonly ContextGoldSeedRevision[];
}>;

export type EagerBaselineFile = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  tokens: number;
}>;

export type EagerBaseline = Readonly<{
  schemaVersion: number;
  workspaceFixture: string;
  estimator: string;
  composition: Readonly<{ include: readonly string[]; exclude: readonly string[] }>;
  files: readonly EagerBaselineFile[];
  totals: Readonly<{ files: number; bytes: number; tokens: number }>;
}>;

export type ContextGoldDocument = Readonly<{
  schemaVersion: number;
  workspaceFixture: string;
  identities: Readonly<{ workspaceIds: readonly string[] }>;
  tasks: readonly ContextGoldTask[];
}>;

export type ContextGoldSeedDocument = Readonly<{
  schemaVersion: number;
  seeds: readonly ContextGoldSeed[];
}>;

export type ContextGoldSet = Readonly<{
  document: ContextGoldDocument;
  tasks: readonly ContextGoldTask[];
  seeds: readonly ContextGoldSeed[];
  baseline: EagerBaseline;
  files: Readonly<Record<string, string>>;
  sha256: string;
}>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Stable-key canonical JSON so a re-serialisation with different key order can
// never change the fixture digest the manifest records.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

export function loadContextGoldSet(dir: string = CONTEXT_GOLD_DIR): ContextGoldSet {
  const document = readJson(join(dir, 'tasks.json')) as ContextGoldDocument;
  const seedDocument = readJson(join(dir, 'brain-seeds.json')) as ContextGoldSeedDocument;
  const baseline = readJson(join(dir, 'eager-baseline.json')) as EagerBaseline;
  const files: Record<string, string> = {};
  for (const name of ['tasks.json', 'brain-seeds.json', 'eager-baseline.json']) {
    files[name] = `sha256:${digest(canonicalJson(readJson(join(dir, name))))}`;
  }
  const sha256 = `sha256:${digest(canonicalJson({ baseline, document, seeds: seedDocument.seeds }))}`;
  return Object.freeze({
    document,
    tasks: document.tasks,
    seeds: seedDocument.seeds,
    baseline,
    files: Object.freeze(files),
    sha256,
  });
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

const LESSON_EXCLUSION_REASONS = ['scope-ineligible', 'duplicate'] as const;

function validateForbiddenEntry(task: ContextGoldTask, entry: ContextGoldForbidden, problems: string[]): void {
  const where = `task '${task.id}' forbidden '${entry.ref}'`;
  if (!CONTEXT_FRAGMENT_KINDS.includes(entry.kind)) problems.push(`${where} declares unknown kind '${entry.kind}'`);
  if (!CONTEXT_FORBIDDEN_RATIONALES.includes(entry.rationale)) {
    problems.push(`${where} declares unknown rationale '${entry.rationale}'`);
  }
  if (entry.rationale === 'outside-closure') {
    if (entry.expect !== 'not-selectable') problems.push(`${where}: outside-closure requires expect 'not-selectable'`);
    return;
  }
  if (entry.rationale === 'product-diagnostic') {
    if (typeof entry.expect !== 'object' || entry.expect === null || !('diagnostic' in entry.expect)) {
      problems.push(`${where}: product-diagnostic requires a diagnostic expectation`);
      return;
    }
    const { diagnostic, reason } = entry.expect;
    if (diagnostic === 'CONTEXT_LESSON_EXCLUDED') {
      if (!(LESSON_EXCLUSION_REASONS as readonly string[]).includes(reason)) {
        problems.push(`${where}: lesson exclusion reason '${reason}' is outside the closed vocabulary`);
      }
    } else if (diagnostic === 'CONTEXT_EVIDENCE_EXCLUDED') {
      if (!(CONTEXT_EXCLUSION_REASONS as readonly string[]).includes(reason)) {
        problems.push(`${where}: evidence exclusion reason '${reason}' is outside the closed vocabulary`);
      }
    } else {
      problems.push(`${where}: unknown diagnostic '${String(diagnostic)}'`);
    }
    return;
  }
  if (typeof entry.expect !== 'object' || entry.expect === null || !('filtered' in entry.expect)) {
    problems.push(`${where}: prefiltered requires a filtered expectation`);
    return;
  }
  if (!(CONTEXT_RETRIEVAL_FILTER_REASONS as readonly string[]).includes(entry.expect.filtered)) {
    problems.push(`${where}: filter reason '${entry.expect.filtered}' is outside the closed vocabulary`);
  }
}

export function validateContextGoldSet(gold: ContextGoldSet): string[] {
  const problems: string[] = [];
  if (gold.document.schemaVersion !== 1) problems.push('tasks schemaVersion must be 1');
  if (gold.document.workspaceFixture !== CONTEXT_GOLD_WORKSPACE_ID) {
    problems.push(`workspaceFixture must be '${CONTEXT_GOLD_WORKSPACE_ID}'`);
  }
  for (const workspaceId of gold.document.identities.workspaceIds) {
    if (!CONTEXT_SYNTHETIC_WORKSPACE_IDS.includes(workspaceId)) {
      problems.push(`declared workspace identity '${workspaceId}' is outside the synthetic allowlist`);
    }
  }

  const seedKeys = new Set<string>();
  const revisionKeys = new Set<string>();
  for (const seed of gold.seeds) {
    if (seedKeys.has(seed.stableKey)) problems.push(`duplicate seed stableKey '${seed.stableKey}'`);
    seedKeys.add(seed.stableKey);
    if (seed.revisions.length === 0) problems.push(`seed '${seed.stableKey}' has no revisions`);
    for (const revision of seed.revisions) {
      if (revisionKeys.has(revision.fixtureVersionKey)) {
        problems.push(`duplicate fixtureVersionKey '${revision.fixtureVersionKey}'`);
      }
      revisionKeys.add(revision.fixtureVersionKey);
      if (revision.body.length === 0) problems.push(`revision '${revision.fixtureVersionKey}' has an empty body`);
    }
    if (seed.labels.length === 0) problems.push(`seed '${seed.stableKey}' carries no retrieval label`);
    for (const label of seed.labels) {
      if (!CONTEXT_SYNTHETIC_WORKSPACE_IDS.includes(label.workspace)) {
        problems.push(`seed '${seed.stableKey}' labels a non-synthetic workspace`);
      }
    }
    if (!['current', 'tombstoned'].includes(seed.finalDisposition)) {
      problems.push(`seed '${seed.stableKey}' declares unknown finalDisposition '${seed.finalDisposition}'`);
    }
  }

  const taskIds = new Set<string>();
  for (const task of gold.tasks) {
    if (taskIds.has(task.id)) problems.push(`duplicate task id '${task.id}'`);
    taskIds.add(task.id);
    if (!CONTEXT_GOLD_TIERS.includes(task.tier)) problems.push(`task '${task.id}' declares unknown tier '${task.tier}'`);
    if (!CONTEXT_GOLD_FAMILIES.includes(task.family)) {
      problems.push(`task '${task.id}' declares unknown family '${task.family}'`);
    }
    const variant = task.registryVariant ?? (task.tier === 'brain' ? 'brain' : 'local');
    if (!CONTEXT_GOLD_REGISTRY_VARIANTS.includes(variant)) {
      problems.push(`task '${task.id}' declares unknown registryVariant '${variant}'`);
    }
    if (task.tier === 'brain' && variant !== 'brain') {
      problems.push(`task '${task.id}' is brain-tier and must use the brain registry variant`);
    }
    if (variant === 'partial') {
      // The partial variant proves the closed fatal envelope: no bundle exists
      // for fragment expectations to bind to.
      if (task.mandatory.length !== 0 || task.forbidden.length !== 0) {
        problems.push(`task '${task.id}' uses the partial registry and must declare no fragment expectations`);
      }
      continue;
    }
    if (task.mandatory.length === 0) problems.push(`task '${task.id}' declares no mandatory fragments`);
    if (task.forbidden.length === 0) problems.push(`task '${task.id}' declares no explicit exclusions`);
    for (const entry of task.mandatory) {
      const where = `task '${task.id}' mandatory entry`;
      if (!CONTEXT_FRAGMENT_KINDS.includes(entry.kind)) problems.push(`${where} declares unknown kind '${entry.kind}'`);
      if (!CONTEXT_INCLUSION_REASONS.includes(entry.inclusionReason)) {
        problems.push(`${where} declares unknown inclusion reason '${entry.inclusionReason}'`);
      }
      const hasRef = entry.ref !== undefined;
      const hasAnyOf = entry.anyOf !== undefined;
      if (hasRef === hasAnyOf) {
        problems.push(`${where} must carry exactly one of ref or anyOf`);
      }
      if (hasAnyOf && entry.anyOf!.length < 2) {
        problems.push(`${where} anyOf must name at least two acceptable alternatives`);
      }
      if (entry.kind === 'brain-evidence') {
        for (const ref of entry.ref !== undefined ? [entry.ref] : entry.anyOf ?? []) {
          if (!seedKeys.has(ref)) problems.push(`${where} names unknown seed stableKey '${ref}'`);
        }
      }
    }
    for (const entry of task.forbidden) {
      validateForbiddenEntry(task, entry, problems);
      if (entry.kind === 'brain-evidence'
        && (entry.rationale === 'prefiltered' || entry.rationale === 'product-diagnostic')) {
        if (!revisionKeys.has(entry.ref)) {
          problems.push(`task '${task.id}' forbidden entry names unknown fixtureVersionKey '${entry.ref}'`);
        }
      }
      if (entry.kind === 'brain-evidence' && entry.rationale === 'outside-closure' && !seedKeys.has(entry.ref)) {
        problems.push(`task '${task.id}' forbidden entry names unknown seed stableKey '${entry.ref}'`);
      }
    }
    if (task.budgetExpect?.exclusions !== undefined) {
      for (const reason of Object.keys(task.budgetExpect.exclusions)) {
        if (!(CONTEXT_EXCLUSION_REASONS as readonly string[]).includes(reason)) {
          problems.push(`task '${task.id}' budgetExpect names unknown exclusion reason '${reason}'`);
        }
      }
    }
  }

  if (gold.baseline.schemaVersion !== 1) problems.push('eager-baseline schemaVersion must be 1');
  if (gold.baseline.workspaceFixture !== CONTEXT_GOLD_WORKSPACE_ID) {
    problems.push('eager-baseline workspaceFixture must name the context-gold workspace');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The FROZEN eager-load baseline (§6 + A4)
// ---------------------------------------------------------------------------

// A4 composition rule: the denominator is exactly the authored instruction
// bytes under functions/** and tools/** (playbooks included) — nothing else.
// ROSTER.md is shared activation bytes both the eager and the bounded host
// read, so it cancels and appears on neither side; roster.yaml /
// roster.brain.yaml are registry configuration and _setup.ts is harness code —
// none of them are instruction bytes, and excluding them SHRINKS the baseline,
// hardening the gate.
export const EAGER_BASELINE_COMPOSITION = Object.freeze({
  include: Object.freeze(['functions/**', 'tools/**']),
  exclude: Object.freeze(['ROSTER.md', 'roster.yaml', 'roster.brain.yaml', '_setup.ts']),
});

export function estimatedTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function listFilesRecursive(dir: string, prefix: string): Array<{ relative: string; absolute: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: Array<{ relative: string; absolute: string }> = [];
  for (const entry of entries.sort()) {
    const absolute = join(dir, entry);
    const relative = prefix.length === 0 ? entry : `${prefix}/${entry}`;
    if (statSync(absolute).isDirectory()) files.push(...listFilesRecursive(absolute, relative));
    else files.push({ relative, absolute });
  }
  return files;
}

export function computeEagerBaseline(
  workspaceDir: string = CONTEXT_GOLD_WORKSPACE_DIR,
): EagerBaseline {
  const files: EagerBaselineFile[] = [];
  for (const top of ['functions', 'tools']) {
    for (const file of listFilesRecursive(join(workspaceDir, top), top)) {
      const bytes = readFileSync(file.absolute);
      files.push({
        path: file.relative,
        sha256: digest(bytes),
        bytes: bytes.byteLength,
        tokens: estimatedTokens(bytes.byteLength),
      });
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    schemaVersion: 1,
    workspaceFixture: CONTEXT_GOLD_WORKSPACE_ID,
    estimator: 'utf8-bytes-ceil-div-4/context-canonical-json-v1',
    composition: EAGER_BASELINE_COMPOSITION,
    files,
    // Ceil-of-sum ≤ sum-of-ceils: the conservative direction for the gate.
    totals: { files: files.length, bytes: totalBytes, tokens: estimatedTokens(totalBytes) },
  };
}

// ---------------------------------------------------------------------------
// Fragment matching (A5 anyOf semantics included)
// ---------------------------------------------------------------------------

export type ObservedFragment = Readonly<{
  fragment_id: string;
  kind: string;
  inclusion_reason: string;
  trust: string;
  required: boolean;
  citationSourceVersionId?: string;
}>;

export function fragmentRefMatches(kind: ContextFragmentKind, ref: string, fragment: ObservedFragment): boolean {
  if (fragment.kind !== kind) return false;
  if (kind === 'tool-use') return fragment.fragment_id.startsWith(`tool-use:${ref}:`);
  return fragment.fragment_id === `${kind}:${ref}`;
}

export type MandatoryVerdict = Readonly<{ ok: boolean; detail: string }>;

export function evaluateMandatoryEntry(
  entry: ContextGoldMandatory,
  fragments: readonly ObservedFragment[],
  resolveSeedRef?: (stableKey: string) => string | undefined,
): MandatoryVerdict {
  const refs = entry.ref !== undefined ? [entry.ref] : [...(entry.anyOf ?? [])];
  const matches = fragments.filter((fragment) => refs.some((ref) => {
    if (entry.kind === 'brain-evidence') {
      const versionId = resolveSeedRef?.(ref);
      return versionId !== undefined
        && fragment.kind === 'brain-evidence'
        && fragment.citationSourceVersionId === versionId;
    }
    return fragmentRefMatches(entry.kind, ref, fragment);
  }));
  if (matches.length === 0) {
    return {
      ok: false,
      detail: entry.ref !== undefined
        ? `missing mandatory ${entry.kind} '${entry.ref}'`
        : `anyOf group [${refs.join(', ')}] has no present member`,
    };
  }
  const reasonMatch = matches.find((fragment) => fragment.inclusion_reason === entry.inclusionReason);
  if (reasonMatch === undefined) {
    return {
      ok: false,
      detail: `${entry.kind} '${refs.join('|')}' present with inclusion_reason `
        + `'${matches[0]!.inclusion_reason}', expected '${entry.inclusionReason}'`,
    };
  }
  return { ok: true, detail: `${entry.kind} '${refs.join('|')}' present as ${entry.inclusionReason}` };
}

// ---------------------------------------------------------------------------
// Hermetic privacy lint over the three #371 artifact directories
// ---------------------------------------------------------------------------

// Validated digest-typed JSON positions in the #371 artifacts. A value here is
// exempt ONLY after its exact shape validates.
const CONTEXT_DIGEST_POINTERS: readonly RegExp[] = Object.freeze([
  /^\/files\/\d+\/sha256$/u,
  /^\/fixture\/sha256$/u,
  /^\/fixture\/files\/[^/]+$/u,
  /^\/workspace_fixture\/sha256$/u,
  /^\/workspace_fixture\/files\/[^/]+$/u,
  /^\/harness\/[^/]+$/u,
]);

const CONTEXT_COMMIT_POINTERS: readonly RegExp[] = Object.freeze([/^\/git\/commit$/u]);

// The #371 schemas' own long identifiers, exempted from the entropy rule.
const CONTEXT_SCHEMA_VOCABULARY: ReadonlySet<string> = new Set([
  'fixtureVersionKey',
  'includeLegacyUnverified',
  'requiredSelectorsUnmatched',
  'requiredSelectorsTruncated',
  'candidateDiagnosticsOmitted',
  'lessonDiagnosticsOmitted',
  'lessonsBudgetExhausted',
  'lessonsScopeIneligible',
  'retrievalReportOmitted',
  'required_selectors_unmatched',
  'required_selectors_truncated',
  'candidate_diagnostics_omitted',
  'lesson_diagnostics_omitted',
  'lessons_budget_exhausted',
  'lessons_scope_ineligible',
  'retrieval_report_omitted',
  'context_quality_manifest',
  'L6-lesson-budget-exhaustion',
  'B4-evidence-budget-exhaustion',
]);

export const CONTEXT_GOLD_LINT_TABLES: PrivacyLintTables = Object.freeze({
  digestPointers: CONTEXT_DIGEST_POINTERS,
  commitPointers: CONTEXT_COMMIT_POINTERS,
  schemaVocabulary: CONTEXT_SCHEMA_VOCABULARY,
  workspaceAllowlist: CONTEXT_SYNTHETIC_WORKSPACE_IDS,
});

// Scope-pinned to exactly the three #371 directories — never the lint module,
// never `docs/evals/retrieval-quality/` (#353 owns its own scan), never the
// wider tree.
export function contextPrivacyLintScope(root: string = REPOSITORY_ROOT): readonly string[] {
  return Object.freeze([
    join(root, 'test', 'fixtures', 'context-gold'),
    join(root, 'test', 'fixtures', 'context-gold-workspace'),
    join(root, 'docs', 'evals', 'context-quality'),
  ]);
}

export function lintContextGoldArtifacts(root: string = REPOSITORY_ROOT): PrivacyLintFinding[] {
  return lintPrivacyArtifacts({
    root,
    scanDirs: contextPrivacyLintScope(root),
    tables: CONTEXT_GOLD_LINT_TABLES,
  });
}
