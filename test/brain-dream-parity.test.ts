import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDreamReadiness } from '../src/lib/brain/dream-readiness.ts';
import {
  DEFAULT_DREAM_POLICY,
  canonicalizeDreamScope,
  dreamDurationSeconds,
  dreamScopeResolutionChain,
} from '../src/lib/brain/dream-contracts.ts';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';
import { seedFeedback, seedRuns } from './support/dream-lifecycle-fixture.ts';

const WORKSPACE_ID = 'dream-parity-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

const SCOPES = [
  'workspace',
  'function:social-media',
  'agent:social-media/manager',
  'plan:social-media/manager#discovery',
] as const;

// #358 moved the readiness predicate into two server-side functions shared by
// the status read and the candidate brokers. If the SQL and the TypeScript ever
// disagree, a candidate could prove a snapshot `dream status` never reported.
test('the server-side predicate is the readiness predicate, over every scope kind', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await t.test('the built-in fallback equals DEFAULT_DREAM_POLICY on an empty policy table', async () => {
      for (const scopeKey of SCOPES) {
        const rows = await fixture.admin.query<{
          policy_source: string;
          policy_version: string;
          policy_scope_key: string;
          min_completed_runs: number;
          min_feedback_records: number;
          min_signal_mix: number;
          evidence_window_seconds: string;
          cooldown_seconds: string;
          excluded_agent_ids: string[];
        }>(
          `SELECT policy_source, policy_version, policy_scope_key, min_completed_runs,
                  min_feedback_records, min_signal_mix,
                  (extract(epoch FROM evidence_window)::bigint)::text AS evidence_window_seconds,
                  (extract(epoch FROM cooldown)::bigint)::text AS cooldown_seconds,
                  excluded_agent_ids
             FROM brain_evidence.dream_effective_policy($1)`,
          [scopeKey],
        );
        const row = rows.rows[0]!;
        assert.equal(row.policy_source, 'built-in', scopeKey);
        assert.equal(row.policy_version, DEFAULT_DREAM_POLICY.policyVersion, scopeKey);
        assert.equal(row.policy_scope_key, DEFAULT_DREAM_POLICY.scopeKey, scopeKey);
        assert.equal(row.min_completed_runs, DEFAULT_DREAM_POLICY.minCompletedRuns, scopeKey);
        assert.equal(row.min_feedback_records, DEFAULT_DREAM_POLICY.minFeedbackRecords, scopeKey);
        assert.equal(row.min_signal_mix, DEFAULT_DREAM_POLICY.minSignalMix, scopeKey);
        assert.equal(
          Number(row.evidence_window_seconds),
          dreamDurationSeconds(DEFAULT_DREAM_POLICY.evidenceWindow),
          scopeKey,
        );
        assert.equal(
          Number(row.cooldown_seconds),
          dreamDurationSeconds(DEFAULT_DREAM_POLICY.cooldown),
          scopeKey,
        );
        assert.deepEqual(row.excluded_agent_ids, [...DEFAULT_DREAM_POLICY.excludedAgentIds], scopeKey);
      }
    });

    await t.test('the SQL resolution chain equals dreamScopeResolutionChain', async () => {
      for (const scopeKey of SCOPES) {
        // Registering one policy at each ancestor and reading which one wins is
        // the OBSERVABLE form of the chain: position is the precedence.
        const expected = dreamScopeResolutionChain(canonicalizeDreamScope(scopeKey));
        for (const [index, ancestor] of expected.entries()) {
          const version = `parity.${scopeKey.replace(/[^a-z0-9]/gu, '')}.${index}.v1`;
          await registerDreamPolicy(fixture.admin, {
            ...DEFAULT_DREAM_POLICY,
            policyVersion: version,
            scopeKey: ancestor,
            minCompletedRuns: index + 1,
            activationAssurance: 'human-confirmed',
            registeredBy: 'parity',
          });
          const resolved = await fixture.admin.query<{ policy_scope_key: string }>(
            `SELECT policy_scope_key FROM brain_evidence.dream_effective_policy($1)`,
            [scopeKey],
          );
          // The MOST SPECIFIC registered ancestor always wins, which is exactly
          // the chain order the TypeScript function emits.
          assert.equal(
            resolved.rows[0]!.policy_scope_key,
            expected.slice(0, index + 1).find((key) => key === resolved.rows[0]!.policy_scope_key),
            `${scopeKey} after registering ${ancestor}`,
          );
          assert.equal(resolved.rows[0]!.policy_scope_key, expected[0], `${scopeKey}/${ancestor}`);
        }
      }
    });

    await t.test('dream_eligible over the current floor equals the readiness eligible set', async () => {
      await seedRuns(fixture, 6);
      await seedRuns(fixture, 2, { functionId: 'growth', agentId: 'sdr', planId: 'outbound' }, 'growth');
      await seedRuns(fixture, 1, { agentId: 'dreamer' }, 'reflection');
      await seedFeedback(fixture, 'fb-0', 'run-0', { signal: 'negative' });

      for (const scopeKey of SCOPES) {
        const readiness = await computeDreamReadiness(fixture.admin, canonicalizeDreamScope(scopeKey));
        const rows = await fixture.admin.query<{
          runs: string;
          feedback_records: string;
          mix: string;
          frontier: string;
        }>(
          `SELECT count(*) FILTER (WHERE evidence_kind = 'completed-run')::text AS runs,
                  count(*) FILTER (WHERE evidence_kind = 'feedback')::text AS feedback_records,
                  count(*) FILTER (
                    WHERE (evidence_kind = 'feedback' AND signal IN ('negative', 'mixed'))
                       OR (evidence_kind = 'completed-run' AND outcome IN ('failed', 'partial', 'aborted'))
                  )::text AS mix,
                  coalesce(max(ordinal), 0)::text AS frontier
             FROM brain_evidence.dream_eligible($1, now(), $2::bigint)`,
          [scopeKey, readiness.watermark.ordinal],
        );
        const row = rows.rows[0]!;
        assert.equal(Number(row.runs), readiness.evidence.completed_runs, scopeKey);
        assert.equal(Number(row.feedback_records), readiness.evidence.feedback_records, scopeKey);
        assert.equal(Number(row.mix), readiness.evidence.signal_mix, scopeKey);
        assert.equal(Number(row.frontier), readiness.frontier.ordinal, scopeKey);
      }
    });

    await t.test('the reflection agent is excluded and feedback inherits its run scope', async () => {
      const rows = await fixture.admin.query<{ agent_id: string }>(
        `SELECT DISTINCT agent_id FROM brain_evidence.dream_eligible('workspace', now(), 0)
          ORDER BY agent_id`,
      );
      // `dreamer` runs are policy-excluded; the feedback row inherits its run's
      // agent, so it never smuggles an excluded agent back in.
      assert.equal(rows.rows.some((row) => row.agent_id === 'dreamer'), false);
      assert.equal(rows.rows.some((row) => row.agent_id === 'manager'), true);
    });

    await t.test('an explicit floor removes exactly the observations at or below it', async () => {
      const all = await fixture.admin.query<{ ordinal: string }>(
        `SELECT ordinal::text AS ordinal FROM brain_evidence.dream_eligible('workspace', now(), 0)
          ORDER BY ordinal`,
      );
      const ordinals = all.rows.map((row) => Number(row.ordinal));
      assert.ok(ordinals.length >= 3);
      const floor = ordinals[1]!;
      const above = await fixture.admin.query<{ ordinal: string }>(
        `SELECT ordinal::text AS ordinal FROM brain_evidence.dream_eligible('workspace', now(), $1::bigint)
          ORDER BY ordinal`,
        [floor],
      );
      assert.deepEqual(
        above.rows.map((row) => Number(row.ordinal)),
        ordinals.filter((ordinal) => ordinal > floor),
      );
    });

    await t.test('an evaluation instant in the past ages every observation out', async () => {
      const empty = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM brain_evidence.dream_eligible('workspace', now() - interval '400 days', 0)`,
      );
      assert.equal(empty.rows[0]!.n, '0');
    });
  } finally {
    await fixture.close();
  }
});
