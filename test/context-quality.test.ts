import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HAS_DB } from './brain-helpers.ts';
import { loadContextGoldSet, validateContextGoldSet } from './support/context-gold.ts';
import { runContextEvaluation, type ContextTierOutcome } from './support/context-eval-runner.ts';

// #371: the end-to-end runtime context quality gate. One subtest per task per
// gate, so a failure names the exact task and the exact property it lost — no
// aggregate ever gates (acceptance criterion 5). The local tier runs inside
// plain `pnpm test` with zero infrastructure; the brain tier builds a
// throwaway Brain per cycle (PG via ROSTER_BRAIN_ADMIN_URL; the production
// object store over MinIO when ROSTER_TEST_S3_ENDPOINT is set, the in-memory
// S3-semantics store otherwise). The independent-rebuild gate inside the
// runner re-materializes (and, on the brain tier, re-seeds a fresh database
// and namespace) and compares the fixture-keyed task rows.

const gold = loadContextGoldSet();

async function assertTier(t: TestContext, outcome: ContextTierOutcome): Promise<void> {
  for (const row of outcome.tasks) {
    await t.test(`${row.id}`, async (taskContext) => {
      for (const gateResult of row.gates) {
        await taskContext.test(gateResult.name, () => {
          assert.equal(gateResult.ok, true, `${row.id}/${gateResult.name}: ${gateResult.detail}`);
        });
      }
    });
  }
  for (const gateResult of outcome.tier_gates) {
    await t.test(`tier ${gateResult.name}`, () => {
      assert.equal(gateResult.ok, true, gateResult.detail);
    });
  }
}

test('the gold set is structurally valid before any measurement', () => {
  assert.deepEqual(validateContextGoldSet(gold), []);
});

test('local context quality gold tasks', { timeout: 240_000 }, async (t) => {
  const outcome = await runContextEvaluation({ tier: 'local', gold });
  await assertTier(t, outcome.result);
});

test(
  'brain context quality gold tasks',
  { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 240_000 },
  async (t) => {
    const outcome = await runContextEvaluation({ tier: 'brain', gold, concurrency: 2 });
    await assertTier(t, outcome.result);
  },
);
