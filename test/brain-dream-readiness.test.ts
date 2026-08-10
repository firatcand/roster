import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerifiedBrainPool, deriveBrainWorkspaceAuthority } from '../src/lib/brain/workspace-authority.ts';
import { recordCompletedRun, recordFeedback } from '../src/lib/brain/evidence-store.ts';
import {
  DEFAULT_DREAM_POLICY,
  canonicalizeDreamScope,
  dreamPolicyFingerprint,
  type DreamReadinessResult,
} from '../src/lib/brain/dream-contracts.ts';
import {
  advanceDreamWatermark,
  computeDreamReadiness,
  registerDreamPolicy,
} from '../src/lib/brain/dream-readiness.ts';
import { renderDreamStatusLines } from '../src/commands/dream.ts';
import { HAS_DB } from './brain-helpers.ts';
import {
  brainConfig,
  createEvidenceFixture,
  seedFeedbackInput,
  seedRunCanonical,
  seedRunInput,
} from './support/brain-evidence-fixture.ts';

const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 240_000 };
const WORKSPACE = canonicalizeDreamScope('workspace');

// Credential-shaped identifiers are legal durable ids: run_id and feedback_id
// are validated by STABLE_ID, which contains `_`, and are never routed through
// assert_no_credential_shape. `dream status` output lands in CLI transcripts and
// host context, so none of these bytes may ever appear in it.
const CREDENTIAL_SHAPED_IDS = [
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'xoxb-1234567890-ABCDEFGHIJK',
  'a'.repeat(64),
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
] as const;

async function readiness(
  fixture: Awaited<ReturnType<typeof createEvidenceFixture>>,
  scope = WORKSPACE,
): Promise<DreamReadinessResult> {
  return await computeDreamReadiness(fixture.runtime, scope);
}

test('dream readiness accumulates below the threshold and survives a reconnect', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-readiness-a');
  try {
    await t.test('acceptance 1: below-threshold observations stay durable and later contribute', async () => {
      for (const index of [1, 2, 3]) {
        await recordCompletedRun(fixture.runtime, seedRunInput(`run-${index}`));
      }
      const partial = await readiness(fixture);
      assert.equal(partial.status, 'not_due');
      assert.equal(partial.evidence.completed_runs, 3);
      assert.equal(partial.policy.min_completed_runs, 5);

      // A fresh pool over the same durable rows: nothing that decides readiness
      // lives in process memory, so a restart cannot lose an observation.
      const authority = deriveBrainWorkspaceAuthority(
        fixture.workspaceId,
        brainConfig(fixture.workspaceId),
      );
      const reopened = createVerifiedBrainPool({ connectionString: fixture.runtimeUrl, authority });
      try {
        const afterRestart = await computeDreamReadiness(reopened, WORKSPACE);
        assert.equal(afterRestart.status, 'not_due');
        assert.equal(afterRestart.evidence.completed_runs, 3);
        assert.equal(afterRestart.readiness_key, partial.readiness_key);

        // An interleaved writer that has NOT yet committed contributes nothing,
        // and contributes everything once it does -- with no lost observation.
        const client = await reopened.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [
            seedRunCanonical('run-4'),
          ]);
          const midFlight = await computeDreamReadiness(reopened, WORKSPACE);
          assert.equal(midFlight.evidence.completed_runs, 3);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        await recordCompletedRun(fixture.runtime, seedRunInput('run-5'));
        const due = await computeDreamReadiness(reopened, WORKSPACE);
        assert.equal(due.evidence.completed_runs, 5);
        assert.equal(due.status, 'due');
        assert.equal(due.frontier.ordinal, 5);
      } finally {
        await reopened.end();
      }
    });

    await t.test('acceptance 2: equivalent checks agree and write nothing', async () => {
      const snapshot = async () => (await fixture.admin.query<{ digest: string }>(
        `SELECT (
           coalesce((SELECT string_agg(record_canonical, '|' ORDER BY run_id) FROM brain_evidence.completed_runs), '')
           || '#' || coalesce((SELECT string_agg(record_canonical, '|' ORDER BY feedback_id) FROM brain_evidence.feedback), '')
           || '#' || (SELECT count(*)::text FROM brain_evidence.evidence_observations)
           || '#' || (SELECT coalesce(max(ordinal), 0)::text FROM brain_evidence.evidence_observations)
           || '#' || (SELECT count(*)::text FROM brain_evidence.dream_policies)
           || '#' || (SELECT count(*)::text FROM brain_evidence.dream_watermarks)
           || '#' || (SELECT last_value::text || is_called::text
                        FROM brain_evidence.evidence_observation_ordinal_seq)
         ) AS digest`,
      )).rows[0]!.digest;

      const before = await snapshot();
      const sequential = [await readiness(fixture), await readiness(fixture), await readiness(fixture)];
      const concurrent = await Promise.all([readiness(fixture), readiness(fixture), readiness(fixture)]);
      const all = [...sequential, ...concurrent];
      for (const result of all) {
        assert.equal(result.status, all[0]!.status);
        assert.equal(result.readiness_key, all[0]!.readiness_key);
      }
      assert.equal(await snapshot(), before);
    });

    await t.test('acceptance 3: every named output field is present and consistent', async () => {
      const result = await readiness(fixture);
      assert.equal(result.ok, true);
      assert.equal(result.schema_version, 1);
      assert.match(result.readiness_key, /^sha256:[a-f0-9]{64}$/u);
      assert.match(result.evaluated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      assert.equal(result.workspace_id, fixture.workspaceId);
      assert.deepEqual({ ...result.scope }, {
        key: 'workspace', kind: 'workspace', function_id: null, agent_id: null, plan_id: null,
      });
      assert.equal(result.policy.version, DEFAULT_DREAM_POLICY.policyVersion);
      assert.equal(result.policy.source, 'built-in');
      assert.equal(result.policy.fingerprint, dreamPolicyFingerprint(DEFAULT_DREAM_POLICY));
      assert.equal(result.policy.evidence_window, 'P30D');
      assert.equal(result.policy.cooldown, 'PT20H');
      assert.deepEqual([...result.policy.excluded_agent_ids], ['dreamer']);
      assert.equal(result.watermark.state, 'genesis');
      assert.equal(result.watermark.ordinal, 0);
      assert.equal(result.watermark.advanced_at, null);
      assert.equal(result.evidence.window_start_bound, 'evidence-window');
      assert.equal(result.evidence.window_end, result.evaluated_at);
      assert.equal(
        result.evidence.outcomes.succeeded + result.evidence.outcomes.failed
          + result.evidence.outcomes.partial + result.evidence.outcomes.aborted,
        result.evidence.completed_runs,
      );
      assert.equal(
        result.evidence.signals.positive + result.evidence.signals.negative
          + result.evidence.signals.mixed,
        result.evidence.feedback_records,
      );
      // Self-checking snapshot bound.
      assert.equal(
        result.frontier.eligible_observations,
        result.evidence.completed_runs + result.evidence.feedback_records,
      );
      assert.deepEqual(result.reasons.map((reason) => reason.code), [
        'MIN_RUNS_MET', 'MIN_FEEDBACK_MET', 'SIGNAL_MIX_MET', 'COOLDOWN_INACTIVE',
      ]);
    });
  } finally {
    await fixture.close();
  }
});

test('the frontier is the true observed-evidence ceiling over both kinds', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-readiness-b');
  try {
    await registerDreamPolicy(fixture.admin, {
      ...DEFAULT_DREAM_POLICY,
      policyVersion: 'acme.dream.minone.v1',
      minCompletedRuns: 1,
      minFeedbackRecords: 1,
      excludedAgentIds: [],
      activationAssurance: 'human-confirmed',
      registeredBy: 'owner',
    });

    let afterRun: DreamReadinessResult;
    let afterFeedback: DreamReadinessResult;

    // B1's exact reported defect: a run alone is not_due; the feedback that
    // flips the verdict MUST move both the frontier and the activation key.
    await t.test('B1 regression: feedback flips the verdict AND re-keys the occasion', async () => {
      await recordCompletedRun(fixture.runtime, seedRunInput('run-b1'));
      afterRun = await readiness(fixture);
      assert.equal(afterRun.status, 'not_due');
      assert.equal(afterRun.frontier.ordinal, 1);

      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-b1', 'run-b1'));
      afterFeedback = await readiness(fixture);
      assert.equal(afterFeedback.status, 'due');
      assert.equal(afterFeedback.frontier.ordinal, 2);
      assert.notEqual(afterFeedback.readiness_key, afterRun.readiness_key);

      // #358's snapshot-bound tuple, run exactly as documented: it must return
      // BOTH observations, including the feedback that flipped the verdict.
      const reconstructed = await fixture.runtime.query<{ ordinal: string; evidence_kind: string }>(
        `SELECT o.ordinal::text AS ordinal, o.evidence_kind
           FROM brain_evidence.evidence_observations o
           LEFT JOIN brain_evidence.feedback f
             ON o.evidence_kind = 'feedback' AND f.feedback_id = o.evidence_id
           JOIN brain_evidence.completed_runs r
             ON r.run_id = CASE WHEN o.evidence_kind = 'completed-run'
                                THEN o.evidence_id ELSE f.run_id END
          WHERE o.ordinal > $1 AND o.ordinal <= $2
            AND o.recorded_at > $3::timestamptz AND o.recorded_at <= $4::timestamptz
            AND NOT (r.agent_id = ANY ($5::text[]))
          ORDER BY o.ordinal`,
        [
          afterFeedback.watermark.ordinal,
          afterFeedback.frontier.ordinal,
          afterFeedback.evidence.window_start,
          afterFeedback.evidence.window_end,
          [...afterFeedback.policy.excluded_agent_ids],
        ],
      );
      assert.deepEqual(reconstructed.rows.map((row) => row.evidence_kind), ['completed-run', 'feedback']);
      assert.equal(reconstructed.rows.length, afterFeedback.frontier.eligible_observations);
    });

    await t.test('B1 closure lemma: {ordinal <= frontier} can never gain a member', async () => {
      const frontier = (await readiness(fixture)).frontier.ordinal;
      const before = await fixture.admin.query<{ digest: string }>(
        `SELECT coalesce(string_agg(evidence_kind || ':' || evidence_id, '|' ORDER BY ordinal), '') AS digest
           FROM brain_evidence.evidence_observations WHERE ordinal <= $1`,
        [frontier],
      );
      await recordCompletedRun(fixture.runtime, seedRunInput('run-closure'));
      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-closure', 'run-closure'));
      const after = await fixture.admin.query<{ digest: string }>(
        `SELECT coalesce(string_agg(evidence_kind || ':' || evidence_id, '|' ORDER BY ordinal), '') AS digest
           FROM brain_evidence.evidence_observations WHERE ordinal <= $1`,
        [frontier],
      );
      assert.equal(after.rows[0]!.digest, before.rows[0]!.digest);
    });

    await t.test('B1 re-open: any arrival of either kind re-keys at a fixed watermark', async () => {
      const start = await readiness(fixture);
      const stable = await readiness(fixture);
      assert.equal(stable.readiness_key, start.readiness_key);

      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-reopen', 'run-b1'));
      const afterFeedbackOnly = await readiness(fixture);
      assert.equal(afterFeedbackOnly.watermark.ordinal, start.watermark.ordinal);
      assert.notEqual(afterFeedbackOnly.readiness_key, start.readiness_key);

      await recordCompletedRun(fixture.runtime, seedRunInput('run-reopen'));
      const afterRunOnly = await readiness(fixture);
      assert.equal(afterRunOnly.watermark.ordinal, start.watermark.ordinal);
      assert.notEqual(afterRunOnly.readiness_key, afterFeedbackOnly.readiness_key);

      for (const result of [start, afterFeedbackOnly, afterRunOnly]) {
        assert.equal(
          result.frontier.eligible_observations,
          result.evidence.completed_runs + result.evidence.feedback_records,
        );
      }
    });
  } finally {
    await fixture.close();
  }
});

test('policy resolution, scope isolation, and self-evidence exclusion', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-readiness-c');
  try {
    await t.test('an empty policy table resolves the built-in default', async () => {
      const result = await readiness(fixture);
      assert.equal(result.policy.source, 'built-in');
      assert.equal(result.policy.version, DEFAULT_DREAM_POLICY.policyVersion);
      assert.equal(result.policy.scope_key, 'workspace');
    });

    await t.test('agent beats function beats workspace, and a threshold edit re-keys', async () => {
      const scope = canonicalizeDreamScope('agent:social-media/manager');
      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.ws.v1',
        scopeKey: 'workspace',
        minCompletedRuns: 100,
        activationAssurance: 'system-derived',
        registeredBy: 'owner',
      });
      let resolved = await readiness(fixture, scope);
      assert.equal(resolved.policy.source, 'brain');
      assert.equal(resolved.policy.version, 'acme.ws.v1');
      assert.equal(resolved.policy.min_completed_runs, 100);
      const workspaceKey = resolved.readiness_key;

      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.fn.v1',
        scopeKey: 'function:social-media',
        minCompletedRuns: 50,
        activationAssurance: 'system-derived',
        registeredBy: 'owner',
      });
      resolved = await readiness(fixture, scope);
      assert.equal(resolved.policy.version, 'acme.fn.v1');
      assert.equal(resolved.policy.min_completed_runs, 50);
      assert.notEqual(resolved.readiness_key, workspaceKey);

      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.agent.v1',
        scopeKey: 'agent:social-media/manager',
        minCompletedRuns: 2,
        minFeedbackRecords: 1,
        minSignalMix: 1,
        excludedAgentIds: ['dreamer'],
        activationAssurance: 'human-confirmed',
        registeredBy: 'owner',
      });
      resolved = await readiness(fixture, scope);
      assert.equal(resolved.policy.version, 'acme.agent.v1');
      assert.equal(resolved.policy.scope_key, 'agent:social-media/manager');
      assert.equal(resolved.policy.min_completed_runs, 2);

      // A broader scope still resolves its own most-specific policy.
      const functionScope = await readiness(fixture, canonicalizeDreamScope('function:social-media'));
      assert.equal(functionScope.policy.version, 'acme.fn.v1');
      const workspaceScope = await readiness(fixture);
      assert.equal(workspaceScope.policy.version, 'acme.ws.v1');
    });

    await t.test('feedback inherits its run scope, and a foreign function never counts', async () => {
      await recordCompletedRun(fixture.runtime, seedRunInput('run-social-1'));
      await recordCompletedRun(fixture.runtime, seedRunInput('run-social-2', { outcome: 'failed' }));
      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-social', 'run-social-1', {
        signal: 'negative',
      }));
      await recordCompletedRun(fixture.runtime, seedRunInput('run-product', {
        functionId: 'product', agentId: 'manager',
      }));
      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-product', 'run-product', {
        signal: 'negative',
      }));

      const social = await readiness(fixture, canonicalizeDreamScope('function:social-media'));
      assert.equal(social.evidence.completed_runs, 2);
      assert.equal(social.evidence.feedback_records, 1);
      const product = await readiness(fixture, canonicalizeDreamScope('function:product'));
      assert.equal(product.evidence.completed_runs, 1);
      // Feedback carries no scope columns; it inherits them through its run.
      assert.equal(product.evidence.feedback_records, 1);
      const agent = await readiness(fixture, canonicalizeDreamScope('agent:social-media/manager'));
      assert.equal(agent.status, 'due');
      assert.equal(agent.evidence.completed_runs, 2);
      assert.equal(agent.evidence.signal_mix, 2);
      const plan = await readiness(fixture, canonicalizeDreamScope('plan:social-media/manager#discovery'));
      assert.equal(plan.evidence.completed_runs, 2);
      const otherPlan = await readiness(
        fixture,
        canonicalizeDreamScope('plan:social-media/manager#other'),
      );
      assert.equal(otherPlan.evidence.completed_runs, 0);
      assert.equal(otherPlan.frontier.ordinal, 0);
    });

    await t.test('a reflection run and its feedback cannot raise readiness', async () => {
      const scope = canonicalizeDreamScope('function:learning');
      await recordCompletedRun(fixture.runtime, seedRunInput('run-dreamer', {
        functionId: 'learning', agentId: 'dreamer',
      }));
      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-dreamer', 'run-dreamer', {
        signal: 'negative',
      }));
      const excluded = await readiness(fixture, scope);
      assert.equal(excluded.evidence.completed_runs, 0);
      // Feedback inherits its run's agent_id, so it is excluded with the run.
      assert.equal(excluded.evidence.feedback_records, 0);
      assert.equal(excluded.frontier.ordinal, 0);

      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.learning.v1',
        scopeKey: 'function:learning',
        minCompletedRuns: 1,
        excludedAgentIds: [],
        activationAssurance: 'human-confirmed',
        registeredBy: 'owner',
      });
      const included = await readiness(fixture, scope);
      assert.equal(included.evidence.completed_runs, 1);
      assert.equal(included.evidence.feedback_records, 1);
      assert.equal(included.status, 'due');
    });
  } finally {
    await fixture.close();
  }
});

test('the status legitimately changes when the window or the cooldown moves', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-readiness-d');
  try {
    await registerDreamPolicy(fixture.admin, {
      ...DEFAULT_DREAM_POLICY,
      policyVersion: 'acme.window.v1',
      minCompletedRuns: 1,
      evidenceWindow: 'PT1H',
      cooldown: 'PT1H',
      excludedAgentIds: [],
      activationAssurance: 'human-confirmed',
      registeredBy: 'owner',
    });
    await recordCompletedRun(fixture.runtime, seedRunInput('run-window'));

    await t.test('evidence ages out of the window at a fixed watermark', async () => {
      const fresh = await readiness(fixture);
      assert.equal(fresh.status, 'due');
      assert.equal(fresh.evidence.completed_runs, 1);

      // Age the source row past the window. The observation copies its source
      // recorded_at, so the observation must age with it.
      await fixture.admin.query(
        `ALTER TABLE brain_evidence.evidence_observations DISABLE TRIGGER evidence_observations_immutable`,
      );
      await fixture.admin.query(
        `UPDATE brain_evidence.evidence_observations SET recorded_at = now() - interval '2 hours'`,
      );
      await fixture.admin.query(
        `ALTER TABLE brain_evidence.evidence_observations ENABLE TRIGGER evidence_observations_immutable`,
      );
      const aged = await readiness(fixture);
      assert.equal(aged.status, 'not_due');
      assert.equal(aged.evidence.completed_runs, 0);
      assert.equal(aged.frontier.ordinal, 0);
      assert.deepEqual(aged.reasons.map((reason) => reason.code)[0], 'NO_ELIGIBLE_EVIDENCE');
    });

    await t.test('the promotion cooldown holds and then releases', async () => {
      await recordCompletedRun(fixture.runtime, seedRunInput('run-cooldown-1'));
      const beforeAdvance = await readiness(fixture);
      assert.equal(beforeAdvance.status, 'due');

      const advanced = await advanceDreamWatermark(fixture.admin, {
        scopeKey: 'workspace',
        cursorOrdinal: beforeAdvance.frontier.ordinal,
        policyVersion: 'acme.window.v1',
        reason: 'promotion',
        consumedCompletedRuns: beforeAdvance.evidence.completed_runs,
        consumedFeedbackRecords: beforeAdvance.evidence.feedback_records,
        actorAssurance: 'human-confirmed',
      });
      assert.equal(advanced.status, 'created');

      await recordCompletedRun(fixture.runtime, seedRunInput('run-cooldown-2'));
      const held = await readiness(fixture);
      assert.equal(held.status, 'not_due');
      assert.equal(held.cooldown.active, true);
      assert.notEqual(held.cooldown.until, null);
      assert.match(String(held.cooldown.remaining), /^PT/u);
      assert.equal(held.watermark.state, 'advanced');
      assert.equal(held.watermark.ordinal, beforeAdvance.frontier.ordinal);
      assert.equal(held.watermark.reason, 'promotion');
      assert.equal(held.evidence.window_start_bound, 'watermark');
      assert.deepEqual(held.reasons.map((reason) => reason.code).at(-1), 'COOLDOWN_ACTIVE');
      // The watermark raised the eligible floor: only evidence above it counts.
      assert.equal(held.evidence.completed_runs, 1);

      // Move the recorded promotion instant back past the cooldown.
      await fixture.admin.query(
        `ALTER TABLE brain_evidence.dream_watermarks DISABLE TRIGGER dream_watermarks_immutable`,
      );
      await fixture.admin.query(
        `UPDATE brain_evidence.dream_watermarks SET advanced_at = now() - interval '2 hours'`,
      );
      await fixture.admin.query(
        `ALTER TABLE brain_evidence.dream_watermarks ENABLE TRIGGER dream_watermarks_immutable`,
      );
      const released = await readiness(fixture);
      assert.equal(released.cooldown.active, false);
      assert.equal(released.cooldown.until, null);
      assert.equal(released.cooldown.remaining, null);
      assert.equal(released.status, 'due');
      assert.deepEqual(released.reasons.map((reason) => reason.code).at(-1), 'COOLDOWN_INACTIVE');
    });
  } finally {
    await fixture.close();
  }
});

test('no evidence identifier or content byte crosses the dream status boundary', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-readiness-e');
  try {
    await t.test('B5 part 1: credential-shaped ids recorded through the brokers', async () => {
      const [runId, feedbackId, hexId, jwtId] = CREDENTIAL_SHAPED_IDS;
      // The SUMMARIES stay safe sentinels: request_summary and feedback.summary
      // both route through assert_safe_text -> assert_no_credential_shape and
      // would be refused outright, so only the IDS carry the credential shape.
      const summary = { requestSummary: 'a safe sentinel summary' };
      const note = { summary: 'a safe sentinel note' };
      await recordCompletedRun(fixture.runtime, seedRunInput(runId!, summary));
      await recordCompletedRun(fixture.runtime, seedRunInput(hexId!, summary));
      await recordFeedback(fixture.runtime, seedFeedbackInput(feedbackId!, runId!, note));
      await recordFeedback(fixture.runtime, seedFeedbackInput(jwtId!, hexId!, note));
      const stored = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations`,
      );
      assert.equal(stored.rows[0]!.n, '4');
    });

    await t.test('B5 part 2: an admin-seeded row whose summary itself is credential-shaped', async () => {
      // Models a legacy/imported row that never passed a broker: assert_safe_text
      // never saw it, so the credential shape IS durable content here.
      await fixture.admin.query(
        `INSERT INTO brain_evidence.completed_runs (
           run_id, record_canonical, workspace_id, function_id, agent_id, plan_id,
           host, host_version, roster_version, request_summary, request_hash,
           started_at, completed_at, outcome, privacy_class, trust_class,
           actor_assurance, assurance_evidence, provenance
         ) VALUES (
           'run-legacy-import', '{}', $1, 'social-media', 'manager', NULL,
           'codex', '0.51.0', '1.0.0', $2, $3,
           now(), now(), 'failed', 'internal', 'legacy-unverified',
           'system-derived', '{}'::jsonb, '{}'::jsonb
         )`,
        [fixture.workspaceId, `leaked ${CREDENTIAL_SHAPED_IDS[0]} in a legacy summary`, `sha256:${'c'.repeat(64)}`],
      );
      const observed = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations
          WHERE evidence_id = 'run-legacy-import'`,
      );
      assert.equal(observed.rows[0]!.n, '1');
    });

    await t.test('neither output mode emits any of those byte sequences', async () => {
      const result = await readiness(fixture);
      assert.equal(result.evidence.completed_runs, 3);
      assert.equal(result.evidence.feedback_records, 2);
      const serialized = JSON.stringify(result);
      for (const secret of CREDENTIAL_SHAPED_IDS) {
        assert.equal(serialized.includes(secret), false, secret.slice(0, 12));
      }
      assert.equal(serialized.includes('legacy summary'), false);
      assert.equal(serialized.includes('run-legacy-import'), false);
      assert.equal(serialized.includes('sentinel'), false);

      const rendered = renderDreamStatusLines(result).join('\n');
      for (const secret of CREDENTIAL_SHAPED_IDS) {
        assert.equal(rendered.includes(secret), false, secret.slice(0, 12));
      }
      assert.equal(rendered.includes('legacy summary'), false);
      assert.equal(rendered.includes('run-legacy-import'), false);
      assert.equal(rendered.includes('sentinel'), false);
    });
  } finally {
    await fixture.close();
  }
});
