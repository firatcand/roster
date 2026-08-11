import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY } from '../src/lib/brain/dream-contracts.ts';
import {
  listDreamCandidates,
  recordDreamCandidate,
} from '../src/lib/brain/dream-candidates.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';
import {
  createCandidate,
  decide,
  observationOrdinal,
  readiness,
  recordDecision,
  seedFeedback,
  seedRuns,
} from './support/dream-lifecycle-fixture.ts';

const WORKSPACE_ID = 'dream-candidates-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

function refuses(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String((error as Error).message));
    return true;
  };
}

test('the create broker proves the whole candidate contract before it stores anything', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await seedRuns(fixture, 6);
    await seedFeedback(fixture, 'fb-0', 'run-0', { signal: 'negative' });
    const snapshot = await readiness(fixture);
    assert.equal(snapshot.status, 'due');
    const runOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-1');

    const supporting = [{
      role: 'supporting' as const,
      evidenceKind: 'completed-run' as const,
      runId: 'run-1',
      feedbackId: null,
      observationOrdinal: runOrdinal,
    }];

    await t.test('a byte-identical replay is `existing` and a divergent one is refused', async () => {
      const first = await createCandidate(fixture, snapshot, supporting);
      assert.equal(first.status, 'created');
      const replay = await createCandidate(fixture, snapshot, supporting);
      assert.equal(replay.status, 'existing');
      assert.equal(replay.candidateId, first.candidateId);

      // The same identity with different bytes is an idempotency conflict, never
      // a silent overwrite.
      const tampered = first.canonical.replace('"lesson_purpose":"', '"lesson_purpose":"X');
      assert.notEqual(tampered, first.canonical);
      await assert.rejects(recordDreamCandidate(fixture.runtime, tampered), refuses('BRAIN_DREAM_IDEMPOTENCY_CONFLICT'));
    });

    await t.test('a citation outside the bound snapshot is refused', async () => {
      await assert.rejects(
        createCandidate(fixture, snapshot, [{
          ...supporting[0]!,
          observationOrdinal: runOrdinal + 1000,
        }], { lessonId: 'outside-snapshot' }),
        refuses('BRAIN_DREAM_SNAPSHOT_STALE'),
      );
    });

    await t.test('an unknown citation target is refused as a missing reference', async () => {
      await assert.rejects(
        createCandidate(fixture, snapshot, [{
          ...supporting[0]!,
          runId: 'run-does-not-exist',
        }], { lessonId: 'unknown-ref' }),
        refuses('BRAIN_DREAM_REF_NOT_FOUND'),
      );
    });

    await t.test('self-evidence is refused even under a permissive admin policy', async () => {
      // The drafter's own runs and the reflection agent's runs are BANNED
      // unconditionally: the exclusion list is the readiness-side occasion
      // filter, never the citation rule.
      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'permissive.dream.v1',
        excludedAgentIds: [],
        activationAssurance: 'human-confirmed',
        registeredBy: 'fixture',
      });
      await seedRuns(fixture, 1, { agentId: 'dreamer' }, 'reflection');
      await seedRuns(fixture, 1, { agentId: 'analyst' }, 'analyst');
      const permissive = await readiness(fixture);
      const reflectionOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'reflection-0');
      const analystOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'analyst-0');

      await assert.rejects(
        createCandidate(fixture, permissive, [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'reflection-0',
          feedbackId: null,
          observationOrdinal: reflectionOrdinal,
        }], { lessonId: 'self-evidence' }),
        refuses('BRAIN_DREAM_SELF_EVIDENCE'),
      );

      // A FALSE drafter claim does not help: the ban covers the reflection agent
      // regardless of who the candidate says drafted it.
      await assert.rejects(
        createCandidate(fixture, permissive, [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'reflection-0',
          feedbackId: null,
          observationOrdinal: reflectionOrdinal,
        }], { lessonId: 'false-drafter', draftedByAgentId: 'analyst' }),
        refuses('BRAIN_DREAM_SELF_EVIDENCE'),
      );

      // And citing the DRAFTER's own runs is banned too.
      await assert.rejects(
        createCandidate(fixture, permissive, [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'analyst-0',
          feedbackId: null,
          observationOrdinal: analystOrdinal,
        }], { lessonId: 'own-runs', draftedByAgentId: 'analyst' }),
        refuses('BRAIN_DREAM_SELF_EVIDENCE'),
      );

      // Feedback ON one's own run is the same citation by another name.
      await seedFeedback(fixture, 'fb-analyst', 'analyst-0', { signal: 'negative' });
      const withFeedback = await readiness(fixture);
      const ordinal = await observationOrdinal(fixture.admin, 'feedback', 'fb-analyst');
      await assert.rejects(
        createCandidate(fixture, withFeedback, [{
          role: 'supporting',
          evidenceKind: 'feedback',
          runId: null,
          feedbackId: 'fb-analyst',
          observationOrdinal: ordinal,
        }], { lessonId: 'own-feedback', draftedByAgentId: 'analyst' }),
        refuses('BRAIN_DREAM_SELF_EVIDENCE'),
      );
    });

    await t.test('secret evidence can never support a lesson and internal never a public one', async () => {
      await seedRuns(fixture, 1, { privacy: 'secret', agentId: 'ops' }, 'secret');
      const current = await readiness(fixture);
      const secretOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'secret-0');
      await assert.rejects(
        createCandidate(fixture, current, [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'secret-0',
          feedbackId: null,
          observationOrdinal: secretOrdinal,
        }], { lessonId: 'secret-cite' }),
        refuses('BRAIN_DREAM_PRIVACY_INCOMPATIBLE'),
      );

      const internalOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-2');
      await assert.rejects(
        createCandidate(fixture, current, [{
          role: 'supporting',
          evidenceKind: 'completed-run',
          runId: 'run-2',
          feedbackId: null,
          observationOrdinal: internalOrdinal,
        }], { lessonId: 'public-from-internal', privacyClass: 'public' }),
        refuses('BRAIN_DREAM_PRIVACY_INCOMPATIBLE'),
      );
    });

    await t.test('a stale watermark or a non-maximal frontier is refused', async () => {
      const current = await readiness(fixture);
      const ordinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-3');
      for (const [label, overrides] of [
        ['stale watermark', { watermarkOrdinal: 1 }],
        ['non-maximal frontier', { frontierOrdinal: ordinal }],
        ['wrong run count', { consumedCompletedRuns: 1 }],
        ['wrong feedback count', { consumedFeedbackRecords: 99 }],
      ] as const) {
        await assert.rejects(
          createCandidate(fixture, current, [{
            role: 'supporting',
            evidenceKind: 'completed-run',
            runId: 'run-3',
            feedbackId: null,
            observationOrdinal: ordinal,
          }], { lessonId: 'snapshot-drift', ...overrides }),
          (error: unknown) => {
            const code = (error as { code?: string }).code;
            // A tampered cursor breaks its own readiness key first; a tampered
            // COUNT survives that and is caught by the server-side proof.
            assert.ok(
              code === 'BRAIN_DREAM_SNAPSHOT_STALE' || code === 'BRAIN_DREAM_INPUT_INVALID',
              `${label}: ${String(code)}`,
            );
            return true;
          },
          label,
        );
      }
    });

    await t.test('supersession requires an OPEN target with the exact typed subject tuple', async () => {
      const current = await readiness(fixture);
      const ordinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-4');
      const citations = [{
        role: 'supporting' as const,
        evidenceKind: 'completed-run' as const,
        runId: 'run-4',
        feedbackId: null,
        observationOrdinal: ordinal,
      }];
      const base = await createCandidate(fixture, current, citations, { lessonId: 'revisable' });
      assert.equal(base.status, 'created');

      const revised = await createCandidate(fixture, current, citations, {
        lessonId: 'revisable',
        lessonBody: 'A revised body.',
        supersedesCandidateId: base.candidateId,
      });
      assert.equal(revised.status, 'created');

      // The superseded candidate is now a STATE, not a row edit.
      const state = await fixture.admin.query<{ state: string }>(
        `SELECT state FROM brain_evidence.dream_candidate_state WHERE candidate_id = $1`,
        [base.candidateId],
      );
      assert.equal(state.rows[0]!.state, 'superseded');

      // Superseding across target spellings is a re-create, not a revise.
      await assert.rejects(
        createCandidate(fixture, current, citations, {
          lessonId: 'revisable',
          lessonScopeKey: 'plan:social-media/manager#discovery',
          supersedesCandidateId: revised.candidateId,
        }),
        refuses('BRAIN_DREAM_INPUT_INVALID'),
      );
      // And an unknown target is a missing reference.
      await assert.rejects(
        createCandidate(fixture, current, citations, {
          lessonId: 'revisable',
          supersedesCandidateId: `sha256:${'e'.repeat(64)}`,
        }),
        refuses('BRAIN_DREAM_REF_NOT_FOUND'),
      );
    });

    await t.test('the list surfaces the same-file warning without blocking anything', async () => {
      const current = await readiness(fixture);
      const ordinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-5');
      await createCandidate(fixture, current, [{
        role: 'supporting',
        evidenceKind: 'completed-run',
        runId: 'run-5',
        feedbackId: null,
        observationOrdinal: ordinal,
      }], { lessonId: 'shorter-openers', lessonScopeKey: 'plan:social-media/manager#discovery' });

      const rows = await listDreamCandidates(fixture.runtime, { limit: 200 });
      const sameFile = rows.filter((row) =>
        row.lesson_id === 'shorter-openers' && row.warnings.some((w) => w.code === 'SAME_LESSON_FILE'));
      assert.ok(sameFile.length >= 1, JSON.stringify(rows.map((row) => row.warnings)));
      assert.match(sameFile[0]!.warnings[0]!.detail, /both cannot be promoted/u);
      // A warning is deterministic and never a refusal: the rows are still here.
      const again = await listDreamCandidates(fixture.runtime, { limit: 200 });
      assert.deepEqual(again.map((row) => row.candidate_id), rows.map((row) => row.candidate_id));
    });
  } finally {
    await fixture.close();
  }
});

test('post-rejection damping keys on the NORMALIZED subject', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-damping-test');
  try {
    await seedRuns(fixture, 6);
    const snapshot = await readiness(fixture);
    const ordinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-0');
    const citations = [{
      role: 'supporting' as const,
      evidenceKind: 'completed-run' as const,
      runId: 'run-0',
      feedbackId: null,
      observationOrdinal: ordinal,
    }];
    const created = await createCandidate(fixture, snapshot, citations, { lessonId: 'damped' });
    const decision = await recordDecision(
      fixture,
      'hd-reject-1',
      'reject',
      created.candidateId,
      'agent:social-media/manager',
    );
    const rejected = await decide(fixture, 'reject', created.candidateId, decision);
    assert.equal(rejected.status, 'created');

    await t.test('an immediate re-create over the same evidence is damped', async () => {
      const current = await readiness(fixture);
      await assert.rejects(
        createCandidate(fixture, current, citations, {
          lessonId: 'damped',
          lessonBody: 'A different body over the same evidence.',
        }),
        refuses('BRAIN_DREAM_DAMPED'),
      );
    });

    await t.test('a cross-occasion and cross-target re-create is damped identically', async () => {
      const current = await readiness(fixture);
      for (const overrides of [
        { lessonId: 'damped', scopeKey: 'agent:social-media/manager' },
        { lessonId: 'damped', lessonScopeKey: 'plan:social-media/manager#discovery' },
      ] as const) {
        const scoped = overrides.scopeKey === undefined
          ? current
          : await readiness(fixture, overrides.scopeKey);
        await assert.rejects(
          createCandidate(fixture, scoped, citations, {
            ...overrides,
            lessonBody: 'Another body.',
          }),
          refuses('BRAIN_DREAM_DAMPED'),
          JSON.stringify(overrides),
        );
      }
    });

    await t.test('one short of the policy minimum is still damped; the next arrival clears it', async () => {
      // The default policy needs 5 completed runs ABOVE the rejection frontier.
      await seedRuns(fixture, 4, {}, 'after');
      const nearly = await readiness(fixture);
      await assert.rejects(
        createCandidate(fixture, nearly, citations, { lessonId: 'damped', lessonBody: 'Body A.' }),
        refuses('BRAIN_DREAM_DAMPED'),
      );

      await seedRuns(fixture, 1, {}, 'clearing');
      const cleared = await readiness(fixture);
      const clearedOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'clearing-0');
      const result = await createCandidate(fixture, cleared, [{
        role: 'supporting',
        evidenceKind: 'completed-run',
        runId: 'clearing-0',
        feedbackId: null,
        observationOrdinal: clearedOrdinal,
      }], { lessonId: 'damped', lessonBody: 'Body B.' });
      assert.equal(result.status, 'created');
    });

    await t.test('a DIFFERENT materialized subject is never damped', async () => {
      const current = await readiness(fixture);
      const clearedOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'clearing-0');
      const other = await createCandidate(fixture, current, [{
        role: 'supporting',
        evidenceKind: 'completed-run',
        runId: 'clearing-0',
        feedbackId: null,
        observationOrdinal: clearedOrdinal,
      }], { lessonId: 'a-different-lesson' });
      assert.equal(other.status, 'created');
    });
  } finally {
    await fixture.close();
  }
});

test('the exact-key list filter selects one occasion and never widens', options, async () => {
  const fixture = await createEvidenceFixture('dream-exact-key-test');
  try {
    await seedRuns(fixture, 6, {}, 'first');
    const firstSnapshot = await readiness(fixture);
    const firstOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'first-0');
    const early = await createCandidate(fixture, firstSnapshot, [{
      role: 'supporting',
      evidenceKind: 'completed-run',
      runId: 'first-0',
      feedbackId: null,
      observationOrdinal: firstOrdinal,
    }], { lessonId: 'early-occasion' });
    assert.equal(early.status, 'created');

    // New evidence moves the frontier, so the next occasion carries a different
    // readiness key -- which is what makes the filter's exactness observable.
    await seedRuns(fixture, 6, {}, 'second');
    const secondSnapshot = await readiness(fixture);
    assert.notEqual(secondSnapshot.readiness_key, firstSnapshot.readiness_key);
    const secondOrdinal = await observationOrdinal(fixture.admin, 'completed-run', 'second-0');
    const later = await createCandidate(fixture, secondSnapshot, [{
      role: 'supporting',
      evidenceKind: 'completed-run',
      runId: 'second-0',
      feedbackId: null,
      observationOrdinal: secondOrdinal,
    }], { lessonId: 'later-occasion' });
    assert.equal(later.status, 'created');

    const all = await listDreamCandidates(fixture.runtime, { limit: 200 });
    assert.equal(all.length, 2);

    const atFirst = await listDreamCandidates(fixture.runtime, {
      readinessKey: firstSnapshot.readiness_key,
      limit: 200,
    });
    assert.deepEqual(atFirst.map((row) => row.candidate_id), [early.candidateId]);
    assert.equal(atFirst[0]!.readiness_key, firstSnapshot.readiness_key);

    const atSecond = await listDreamCandidates(fixture.runtime, {
      readinessKey: secondSnapshot.readiness_key,
      limit: 200,
    });
    assert.deepEqual(atSecond.map((row) => row.candidate_id), [later.candidateId]);

    // An occasion with nothing drafted answers empty rather than falling back to
    // the unfiltered listing: that is the branch the host reads as "draft one".
    const unknown = await listDreamCandidates(fixture.runtime, {
      readinessKey: `sha256:${'f'.repeat(64)}`,
      limit: 200,
    });
    assert.deepEqual(unknown, []);

    // The exact key composes with the other filters instead of replacing them.
    const composed = await listDreamCandidates(fixture.runtime, {
      readinessKey: firstSnapshot.readiness_key,
      state: 'promoted',
      limit: 200,
    });
    assert.deepEqual(composed, []);
  } finally {
    await fixture.close();
  }
});
