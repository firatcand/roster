import assert from 'node:assert/strict';
import test from 'node:test';
import { recordCompletedRun } from '../src/lib/brain/evidence-store.ts';
import {
  DEFAULT_DREAM_POLICY,
  canonicalizeDreamScope,
  dreamWatermarkCanonical,
  type DreamWatermarkAdvance,
} from '../src/lib/brain/dream-contracts.ts';
import {
  advanceDreamWatermark,
  computeDreamReadiness,
  registerDreamPolicy,
} from '../src/lib/brain/dream-readiness.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture, seedRunInput } from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'dream-watermark-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };
const WORKSPACE = canonicalizeDreamScope('workspace');
const POLICY_VERSION = 'acme.watermark.v1';

function advance(overrides: Partial<DreamWatermarkAdvance> = {}): DreamWatermarkAdvance {
  return {
    scopeKey: 'workspace',
    cursorOrdinal: 1,
    policyVersion: POLICY_VERSION,
    reason: 'promotion',
    consumedCompletedRuns: 1,
    consumedFeedbackRecords: 0,
    actorAssurance: 'human-confirmed',
    ...overrides,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

test('the dream watermark is append-only, idempotent, and never moves backward', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await registerDreamPolicy(fixture.admin, {
      ...DEFAULT_DREAM_POLICY,
      policyVersion: POLICY_VERSION,
      minCompletedRuns: 1,
      cooldown: 'PT0S',
      excludedAgentIds: [],
      activationAssurance: 'human-confirmed',
      registeredBy: 'owner',
    });
    for (const index of [1, 2, 3, 4, 5]) {
      await recordCompletedRun(fixture.runtime, seedRunInput(`run-${index}`));
    }

    await t.test('an advance raises the eligible floor and re-keys readiness', async () => {
      const before = await computeDreamReadiness(fixture.runtime, WORKSPACE);
      assert.equal(before.evidence.completed_runs, 5);
      assert.equal(before.frontier.ordinal, 5);

      const created = await advanceDreamWatermark(fixture.admin, advance({
        cursorOrdinal: 3,
        consumedCompletedRuns: 3,
      }));
      assert.deepEqual({ ...created }, { status: 'created', scopeKey: 'workspace', sequence: 1 });

      const after = await computeDreamReadiness(fixture.runtime, WORKSPACE);
      assert.equal(after.watermark.state, 'advanced');
      assert.equal(after.watermark.ordinal, 3);
      assert.equal(after.watermark.sequence, 1);
      assert.equal(after.watermark.policy_version, POLICY_VERSION);
      assert.equal(after.evidence.completed_runs, 2);
      assert.equal(after.frontier.ordinal, 5);
      assert.notEqual(after.readiness_key, before.readiness_key);
      assert.equal(after.status, 'due');
    });

    await t.test('a byte-identical replay writes nothing; a conflicting one is RBE02', async () => {
      const snapshot = async () => (await fixture.admin.query<{ digest: string }>(
        `SELECT coalesce(string_agg(sequence::text || ':' || cursor_ordinal::text || ':' || record_canonical,
                                    '|' ORDER BY sequence), '') AS digest
           FROM brain_evidence.dream_watermarks WHERE scope_key = 'workspace'`,
      )).rows[0]!.digest;
      const before = await snapshot();

      const replay = await advanceDreamWatermark(fixture.admin, advance({
        cursorOrdinal: 3,
        consumedCompletedRuns: 3,
      }));
      assert.deepEqual({ ...replay }, { status: 'existing', scopeKey: 'workspace', sequence: 1 });
      assert.equal(await snapshot(), before);

      await assert.rejects(
        advanceDreamWatermark(fixture.admin, advance({
          cursorOrdinal: 3,
          consumedCompletedRuns: 99,
        })),
        hasCode('BRAIN_DREAM_IDEMPOTENCY_CONFLICT'),
      );
      assert.equal(await snapshot(), before);
    });

    await t.test('a rewind is RBE05 and an unknown cursor is RBE03', async () => {
      await assert.rejects(
        advanceDreamWatermark(fixture.admin, advance({ cursorOrdinal: 2 })),
        hasCode('BRAIN_DREAM_WATERMARK_REWIND'),
      );
      await assert.rejects(
        advanceDreamWatermark(fixture.admin, advance({ cursorOrdinal: 4_242 })),
        hasCode('BRAIN_DREAM_REF_NOT_FOUND'),
      );
      const rows = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.dream_watermarks`,
      );
      assert.equal(rows.rows[0]!.n, '1');
    });

    await t.test('an unknown field is rejected rather than silently ignored', async () => {
      const canonical = dreamWatermarkCanonical(advance({ cursorOrdinal: 4 }));
      for (const injected of ['workspace_id', 'advanced_at', 'sequence']) {
        const payload = JSON.parse(canonical) as Record<string, unknown>;
        payload[injected] = injected === 'sequence' ? 9 : 'injected';
        await assert.rejects(
          fixture.admin.query(`SELECT * FROM brain_evidence.advance_dream_watermark($1)`, [
            JSON.stringify(payload),
          ]),
          hasCode('RBE01'),
          injected,
        );
      }
      const missing = JSON.parse(canonical) as Record<string, unknown>;
      delete missing['reason'];
      await assert.rejects(
        fixture.admin.query(`SELECT * FROM brain_evidence.advance_dream_watermark($1)`, [
          JSON.stringify(missing),
        ]),
        hasCode('RBE01'),
      );
      // Only 'promotion' is representable: #358 must supply the promotion
      // identity checks before any other reason can exist.
      const otherReason = JSON.parse(canonical) as Record<string, unknown>;
      otherReason['reason'] = 'operator';
      await assert.rejects(
        fixture.admin.query(`SELECT * FROM brain_evidence.advance_dream_watermark($1)`, [
          JSON.stringify(otherReason),
        ]),
        hasCode('RBE01'),
      );
    });

    await t.test('concurrent divergent advances leave a monotone ledger', async () => {
      const ascending = await Promise.allSettled([
        advanceDreamWatermark(fixture.admin, advance({ cursorOrdinal: 4 })),
        advanceDreamWatermark(fixture.admin, advance({ cursorOrdinal: 5 })),
      ]);
      const outcomes = ascending.map((entry) =>
        entry.status === 'fulfilled' ? entry.value.status : (entry.reason as { code?: string }).code);
      for (const outcome of outcomes) {
        assert.equal(
          outcome === 'created' || outcome === 'BRAIN_DREAM_WATERMARK_REWIND',
          true,
          String(outcome),
        );
      }
      const ledger = await fixture.admin.query<{ sequence: string; cursor_ordinal: string }>(
        `SELECT sequence::text AS sequence, cursor_ordinal::text AS cursor_ordinal
           FROM brain_evidence.dream_watermarks WHERE scope_key = 'workspace' ORDER BY sequence`,
      );
      const sequences = ledger.rows.map((row) => Number(row.sequence));
      const cursors = ledger.rows.map((row) => Number(row.cursor_ordinal));
      assert.deepEqual(sequences, sequences.map((_unused, index) => index + 1));
      for (let index = 1; index < cursors.length; index++) {
        assert.equal(cursors[index]! > cursors[index - 1]!, true, JSON.stringify(cursors));
      }
      const head = await computeDreamReadiness(fixture.runtime, WORKSPACE);
      assert.equal(head.watermark.ordinal, cursors.at(-1));
      assert.equal(head.watermark.sequence, sequences.at(-1));
    });

    await t.test('scopes carry independent watermarks', async () => {
      const scope = canonicalizeDreamScope('agent:social-media/manager');
      const created = await advanceDreamWatermark(fixture.admin, advance({
        scopeKey: 'agent:social-media/manager',
        cursorOrdinal: 1,
      }));
      assert.deepEqual({ ...created }, {
        status: 'created', scopeKey: 'agent:social-media/manager', sequence: 1,
      });
      const agent = await computeDreamReadiness(fixture.runtime, scope);
      assert.equal(agent.watermark.ordinal, 1);
      const workspace = await computeDreamReadiness(fixture.runtime, WORKSPACE);
      assert.equal(workspace.watermark.ordinal > 1, true);
    });
  } finally {
    await fixture.close();
  }
});
