// Runs the ONE shared context evaluation runner the gold-set suites use, writes
// the schema-versioned result manifest, and GENERATES the dated Markdown report
// from that manifest. The JSON is the diffable ground truth; the Markdown is
// prose.
//
//   pnpm eval:context                                  # local tier only
//   ROSTER_BRAIN_ADMIN_URL=<admin url> pnpm eval:context   # + brain tier
//
// Adding ROSTER_TEST_S3_ENDPOINT (plus AWS test credentials) backs the brain
// tier with the production ContentAddressedBrainObjectStore over a real
// S3-compatible service; otherwise the in-memory S3-semantics store backs it
// and the manifest records which physical store ran.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_EVAL_DOCS_DIR,
  lintContextGoldArtifacts,
  loadContextGoldSet,
  validateContextGoldSet,
} from '../test/support/context-gold.ts';
import {
  CONTEXT_REDUCTION_THRESHOLD,
  composeContextManifest,
  runContextEvaluation,
  type ContextEvaluationOutcome,
  type ContextResultManifest,
  type ContextTaskRow,
  type ContextTierOutcome,
} from '../test/support/context-eval-runner.ts';

type Row = readonly (string | number)[];

function table(headers: readonly string[], rows: readonly Row[]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => String(cell)).join(' | ')} |`),
  ].join('\n');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

const CORRECTION_HINTS: Readonly<Record<string, string>> = {
  'cli-contract': 'inspect the CLI invocation contract: exit code, stderr, single-line JSON',
  recall: 'restore the missing mandatory fragment or repair its inclusion reason at the authored source',
  exclusion: 'remove the leaked fragment from the closure or repair the product exclusion surface it should appear on',
  'budget-accounting': 'reconcile the budget counters against the declared expectation; a product accounting defect is filed as its own issue',
  diagnostics: 'reconcile the emitted diagnostic codes with the declared closed set',
  explanations: 'restore the canonical explanation for the named inclusion reason',
  'trust-separation': 'repair the structural trust class of the named fragment kind',
  'host-structure': 'regenerate the vendor-skill map; both host locators must be deep-equal host-native entries',
  citation: 'repair the citation envelope or the content addressed by it',
  'embedding-optional': 'the retrieval echo must surface the embedding mode as not-used with the registry empty',
  determinism: 'two identical invocations diverged — a product nondeterminism defect is filed as its own issue',
  'host-equivalence': 'host-shaped environment deltas changed the bundle — an equivalence defect is filed as its own issue',
  'explain-toggle': 'the explain toggle changed more than explanations and their derived size accounting',
  'step-hint': 'the step hint changed the fragment set rather than only optional ordering',
  'legacy-optin': 'repair the legacy opt-in pair: absent without the flag, floored and unpromoted with it',
  reduction: 'the bundle exceeded 40 % of the frozen eager baseline; reduce closure weight or reassess the fixture composition',
  'independent-rebuild': 'a fresh materialize+seed+measure cycle disagreed under the declared projection — a nondeterminism defect is filed as its own issue',
  'explanation-vocabulary': 'an inclusion reason outside the closed thirteen-reason vocabulary was observed',
  'local-reason-subset': 'a Brain-only inclusion reason surfaced on the local tier',
  'brain-reasons-observed': 'the brain tier never observed both selector reasons; check the corpus seeding',
};

function taskTable(tier: ContextTierOutcome): string {
  return table(
    ['task', 'family', 'gates', 'bundle tokens', 'reduction vs eager'],
    tier.tasks.map((row) => [
      row.id,
      row.family,
      row.gates.every((entry) => entry.ok) ? `${row.gates.length} pass` : `FAIL (${row.gates.filter((entry) => !entry.ok).length})`,
      row.bundle_tokens ?? 'n/a (fatal-envelope task)',
      row.reduction === null ? 'n/a' : `${percent(row.reduction)}${row.ratio_gated ? ' (gated)' : ''}`,
    ]),
  );
}

function tierGateTable(tier: ContextTierOutcome): string {
  return table(
    ['tier gate', 'result', 'detail'],
    tier.tier_gates.map((entry) => [entry.name, entry.ok ? 'pass' : 'FAIL', entry.detail]),
  );
}

function failingGates(tier: ContextTierOutcome): Array<{ row: ContextTaskRow; gateName: string; detail: string }> {
  const failures: Array<{ row: ContextTaskRow; gateName: string; detail: string }> = [];
  for (const row of tier.tasks) {
    for (const entry of row.gates) {
      if (!entry.ok) failures.push({ row, gateName: entry.name, detail: entry.detail });
    }
  }
  return failures;
}

function correctionsSection(tiers: readonly ContextTierOutcome[]): string {
  const taskFailures = tiers.flatMap((tier) => failingGates(tier).map((failure) => ({ tier: tier.tier, ...failure })));
  const tierFailures = tiers.flatMap((tier) => tier.tier_gates
    .filter((entry) => !entry.ok)
    .map((entry) => ({ tier: tier.tier, gateName: entry.name, detail: entry.detail })));
  if (taskFailures.length === 0 && tierFailures.length === 0) {
    return '## Targeted corrections\n\nNone required: every task gate and every tier gate passed.';
  }
  const rows = [
    ...taskFailures.map((failure) => [
      `${failure.tier}/${failure.row.id}`,
      failure.gateName,
      failure.detail,
      CORRECTION_HINTS[failure.gateName] ?? 'inspect the gate detail',
    ]),
    ...tierFailures.map((failure) => [
      `${failure.tier} (tier gate)`,
      failure.gateName,
      failure.detail,
      CORRECTION_HINTS[failure.gateName] ?? 'inspect the tier gate detail',
    ]),
  ];
  return `## Targeted corrections

Failures block the representative workflow proof (#360 / P2-T12 depends on this gate).
Each row names the task (or the tier-level gate), the lost property, the closed reason
observed, and the correction direction — never an aggregate.

${table(['task', 'gate', 'observed', 'correction hint'], rows)}`;
}

function renderMarkdown(manifest: ContextResultManifest, tiers: readonly ContextTierOutcome[], date: string): string {
  const git = manifest['git'] as { commit: string; dirty: boolean };
  const environment = manifest['environment'] as Record<string, unknown>;
  const config = manifest['config'] as Record<string, unknown>;
  const header = git.dirty
    ? '> **NON-AUTHORITATIVE RUN.** The working tree was dirty when this manifest was produced, so the\n'
      + '> recorded commit does not identify the code that ran. Re-run from a clean tree before citing\n'
      + '> these numbers in a decision.\n\n'
    : '';

  const tierSections = tiers.map((tier) => `### Tier \`${tier.tier}\`

${tier.tier === 'brain'
    ? `Physical object store: \`${tier.physical_store}\` (the logical namespace stays the registry's AWS-default namespace either way; the manifest records which physical store backed the run). PostgreSQL ${tier.postgres ?? 'n/a'}.`
    : 'Zero infrastructure: the local tier runs the CLI against the materialized checked-in workspace only.'}

${taskTable(tier)}

${tierGateTable(tier)}`).join('\n\n');

  const gatedRows = tiers.flatMap((tier) => tier.tasks.filter((row) => row.ratio_gated && row.reduction !== null));
  const worst = gatedRows.reduce<ContextTaskRow | null>(
    (current, row) => (current === null || row.reduction! < current.reduction! ? row : current),
    null,
  );

  return `# Runtime context quality — ${date}

${header}Generated from \`${date}.json\` by \`pnpm eval:context\`. The JSON manifest is the ground
truth; this document is prose and tables derived from it.

- commit: \`${git.commit}\`${git.dirty ? ' (dirty)' : ''}
- gold fixture: \`${(manifest['fixture'] as { sha256: string }).sha256}\`
- workspace fixture: \`${(manifest['workspace_fixture'] as { sha256: string }).sha256}\`
- environment: node ${String(environment['node'])}, ${String(environment['os'])}, PostgreSQL ${String(environment['postgres'] ?? 'n/a')}, physical object store \`${String(environment['physical_store'])}\`
- frozen eager baseline: ${String(config['baseline_tokens'])} tokens; reduction gate: bundle ≤ ${percent(CONTEXT_REDUCTION_THRESHOLD)} of baseline (≥ 60 % reduction) on ${(config['ratio_gated_tasks'] as string[]).length} gated tasks${worst === null ? '' : `; tightest margin: \`${worst.id}\` at ${percent(worst.reduction!)}`}

## Scope boundary

This report discharges the **bundle-level** half of the release-gate sentence in
\`spec/CONTEXT.md\` ("Context quality passes required recall, exclusion, citation,
determinism, and at least 60 percent token reduction"): mandatory fragment recall,
explicit exclusion, bundle-level citation completeness, determinism, cross-host
equivalence, and the ≥ 60 % token reduction against the frozen eager baseline.

**#353** owns the retrieval layer (its own gold sets, metrics, and capability
dispositions live in \`docs/evals/retrieval-quality/\`). **#360 (P2-T12)** consumes this
gate: a failure here blocks the representative workflow proof. **#368** records final
capability decisions. See \`docs/evals/context-quality/README.md\` for method,
definitions, and reproduction.

## Results

${tierSections}

${correctionsSection(tiers)}
`;
}

async function main(): Promise<void> {
  const gold = loadContextGoldSet();
  const problems = validateContextGoldSet(gold);
  if (problems.length > 0) {
    process.stderr.write(`gold set is invalid:\n${problems.join('\n')}\n`);
    process.exit(1);
  }

  const outcomes: ContextEvaluationOutcome[] = [];
  outcomes.push(await runContextEvaluation({ tier: 'local', gold }));
  const hasDb = (process.env['ROSTER_BRAIN_ADMIN_URL'] ?? '').length > 0;
  if (hasDb) outcomes.push(await runContextEvaluation({ tier: 'brain', gold, concurrency: 2 }));
  else process.stderr.write('ROSTER_BRAIN_ADMIN_URL not set — the brain tier was skipped\n');

  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const tiers = outcomes.map((outcome) => outcome.result);
  const manifest = composeContextManifest({ gold, tiers, generatedAt });

  mkdirSync(CONTEXT_EVAL_DOCS_DIR, { recursive: true });
  writeFileSync(join(CONTEXT_EVAL_DOCS_DIR, `${date}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(CONTEXT_EVAL_DOCS_DIR, `${date}.md`), renderMarkdown(manifest, tiers, date));

  const findings = lintContextGoldArtifacts();
  if (findings.length > 0) {
    process.stderr.write(`privacy lint failed on the generated artifacts:\n${JSON.stringify(findings, null, 2)}\n`);
    process.exit(3);
  }

  const failures = tiers.flatMap((tier) => [
    ...tier.tasks.flatMap((row) => row.gates.filter((entry) => !entry.ok)
      .map((entry) => `${tier.tier}/${row.id}/${entry.name}: ${entry.detail}`)),
    ...tier.tier_gates.filter((entry) => !entry.ok).map((entry) => `${tier.tier}/${entry.name}: ${entry.detail}`),
  ]);
  process.stdout.write(`wrote docs/evals/context-quality/${date}.json and ${date}.md\n`);
  if (failures.length > 0) {
    process.stderr.write(`gate failures:\n${failures.join('\n')}\n`);
    process.exit(4);
  }
}

await main();
