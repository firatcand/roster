import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../src/lib/context-args.ts';
import type { WorkspaceContext } from '../src/lib/workspace-context.ts';
import { discoverWorkspace } from '../src/lib/workspace-registry.ts';
import { buildSocialManagerContextFixture } from './fixtures/social-manager-context/_setup.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtCli = join(repoRoot, 'bin/roster.js');
const target = 'gtm/social-manager#opportunity-discovery';
const query = 'Find timely conversations about reliable AI-assisted company operations.';
const hint = 'The host is preparing the discovery shortlist.';

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
}

function runBuiltContext(root: string): { duration: number; result: WorkspaceContext } {
  const started = performance.now();
  const run = spawnSync(process.execPath, [
    builtCli,
    'context',
    target,
    '--query',
    query,
    '--step',
    hint,
    '--budget',
    String(DEFAULT_CONTEXT_BUDGET_TOKENS),
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const duration = performance.now() - started;
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.stderr, '');
  return { duration, result: JSON.parse(run.stdout) as WorkspaceContext };
}

test('representative built context CLI stays below local p95 and default-budget sizing gates', { timeout: 120_000 }, (context) => {
  const fx = buildSocialManagerContextFixture();
  try {
    const records = discoverWorkspace(fx.root, { full: true }).records;
    const exactBytes = records.reduce(
      (sum, record) => sum + Buffer.byteLength(record.content ?? '', 'utf8'),
      0,
    );
    assert.equal(records.length <= 256, true);
    assert.equal(exactBytes <= 2 * 1024 * 1024, true);

    for (let index = 0; index < 5; index++) runBuiltContext(fx.root);
    const durations: number[] = [];
    let representative: WorkspaceContext | undefined;
    for (let index = 0; index < 30; index++) {
      const measured = runBuiltContext(fx.root);
      durations.push(measured.duration);
      representative = measured.result;
    }
    const localP95 = p95(durations);
    context.diagnostic(
      `representative context: ${records.length} records, ${exactBytes} authored bytes, `
      + `${representative!.budget.mandatory_bytes} mandatory bytes / `
      + `${representative!.budget.mandatory_tokens} mandatory tokens, p95 ${localP95.toFixed(1)} ms`,
    );
    assert.equal(localP95 < 500, true, `representative context p95 ${localP95.toFixed(1)} ms exceeds 500 ms`);
    assert.equal(
      representative!.budget.mandatory_tokens <= DEFAULT_CONTEXT_BUDGET_TOKENS / 2,
      true,
      `mandatory ${representative!.budget.mandatory_tokens} exceeds half of default ${DEFAULT_CONTEXT_BUDGET_TOKENS}`,
    );
    assert.equal(representative!.budget.total_tokens <= DEFAULT_CONTEXT_BUDGET_TOKENS, true);
    context.diagnostic('the existing 3,111-record functional stress envelope remains covered by test:workspace-benchmark');
  } finally {
    fx.cleanup();
  }
});
