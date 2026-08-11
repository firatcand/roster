import assert from 'node:assert/strict';
import test from 'node:test';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY, dreamWatermarkCanonical } from '../src/lib/brain/dream-contracts.ts';
import { decideLessonCandidate } from '../src/lib/brain/dream-candidates.ts';
import { normalizeLessonDecision } from '../src/lib/brain/dream-candidate-contracts.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';
import {
  candidateFacts,
  createCandidate,
  decide,
  decidedAtOf,
  observationOrdinal,
  readiness,
  recordDecision,
  seedRuns,
} from './support/dream-lifecycle-fixture.ts';

const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };
const CONTENT_HASH = `sha256:${'c'.repeat(64)}`;

function refuses(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String((error as Error).message));
    return true;
  };
}

async function citation(fixture: Awaited<ReturnType<typeof createEvidenceFixture>>, runId: string) {
  return [{
    role: 'supporting' as const,
    evidenceKind: 'completed-run' as const,
    runId,
    feedbackId: null,
    observationOrdinal: await observationOrdinal(fixture.admin, 'completed-run', runId),
  }];
}

test('promotion is bound to a human decision and advances the watermark atomically', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-promotion-test');
  try {
    // A zero cooldown so a promoted scope is immediately due again: the cooldown
    // itself is pinned by #357's readiness suite, and this suite is about the
    // BINDING.
    await registerDreamPolicy(fixture.admin, {
      ...DEFAULT_DREAM_POLICY,
      policyVersion: 'promotion.suite.v1',
      scopeKey: 'workspace',
      cooldown: 'PT0S',
      activationAssurance: 'human-confirmed',
      registeredBy: 'fixture',
    });
    await seedRuns(fixture, 6);
    const snapshot = await readiness(fixture);
    assert.equal(snapshot.status, 'due');
    const cites = await citation(fixture, 'run-0');
    const created = await createCandidate(fixture, snapshot, cites, { lessonId: 'first-lesson' });
    // Both same-file candidates are drafted over the SAME snapshot, before any
    // promotion moves the watermark out from under them.
    const sameFile = await createCandidate(fixture, snapshot, cites, {
      lessonId: 'first-lesson',
      lessonScopeKey: 'plan:social-media/manager#discovery',
    });

    await t.test('a decision bound to another candidate, verb, or scope is refused', async () => {
      const other = await createCandidate(fixture, snapshot, cites, { lessonId: 'other-lesson' });
      const wrongTarget = await recordDecision(
        fixture, 'hd-wrong-target', 'promote', other.candidateId, 'agent:social-media/manager',
      );
      await assert.rejects(
        decide(fixture, 'promote', created.candidateId, wrongTarget, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_DECISION_UNBOUND'),
      );
      const wrongVerb = await recordDecision(
        fixture, 'hd-wrong-verb', 'reject', created.candidateId, 'agent:social-media/manager',
      );
      await assert.rejects(
        decide(fixture, 'promote', created.candidateId, wrongVerb, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_DECISION_UNBOUND'),
      );
      const wrongScope = await recordDecision(
        fixture, 'hd-wrong-scope', 'promote', created.candidateId, 'plan:social-media/manager#discovery',
      );
      await assert.rejects(
        decide(fixture, 'promote', created.candidateId, wrongScope, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_DECISION_UNBOUND'),
      );
      // A decision that does not exist at all is a missing reference.
      await assert.rejects(
        decide(fixture, 'promote', created.candidateId, {
          decisionId: 'hd-nonexistent',
          actionDigest: `sha256:${'d'.repeat(64)}`,
        }, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_REF_NOT_FOUND'),
      );
    });

    await t.test('a bound promotion advances the watermark and replays byte-identically', async () => {
      const decision = await recordDecision(
        fixture, 'hd-promote-1', 'promote', created.candidateId, 'agent:social-media/manager',
      );
      const promoted = await decide(
        fixture, 'promote', created.candidateId, decision, { contentHash: CONTENT_HASH },
      );
      assert.equal(promoted.status, 'created');
      assert.equal(promoted.subjectCurrent, true);
      assert.equal(promoted.watermarkScopeKey, 'workspace');
      assert.equal(promoted.subjectSequence, 1);

      const watermark = await fixture.admin.query<{ cursor_ordinal: string; reason: string }>(
        `SELECT cursor_ordinal::text AS cursor_ordinal, reason FROM brain_evidence.dream_watermarks
          WHERE scope_key = 'workspace' ORDER BY sequence DESC LIMIT 1`,
      );
      assert.equal(Number(watermark.rows[0]!.cursor_ordinal), snapshot.frontier.ordinal);
      assert.equal(watermark.rows[0]!.reason, 'promotion');

      const replay = await decide(
        fixture, 'promote', created.candidateId, decision, { contentHash: CONTENT_HASH },
      );
      assert.equal(replay.status, 'existing');
      assert.equal(replay.subjectSequence, promoted.subjectSequence);
      assert.equal(replay.subjectCurrent, true);

      // The watermark moved, so the CONSUMED evidence is gone from the eligible
      // set and the scope is no longer due over it.
      const after = await readiness(fixture);
      assert.equal(after.watermark.ordinal, snapshot.frontier.ordinal);
      assert.equal(after.status, 'not_due');
    });

    await t.test('the row-level append-only trigger refuses editing a committed decision', async () => {
      for (const statement of [
        `UPDATE brain_evidence.lesson_decisions SET decision = 'reject'`,
        `DELETE FROM brain_evidence.lesson_decisions`,
      ]) {
        await assert.rejects(fixture.admin.query(statement), /append-only/u, statement);
      }
    });

    await t.test('a second candidate cannot govern the same lesson file', async () => {
      const decision = await recordDecision(
        fixture, 'hd-sibling', 'promote', sameFile.candidateId, 'plan:social-media/manager#discovery',
      );
      await assert.rejects(
        decide(fixture, 'promote', sameFile.candidateId, decision, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_STATE_INVALID'),
      );
      // The refusal fires BEFORE any advance: no second watermark row exists.
      const count = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.dream_watermarks`,
      );
      assert.equal(count.rows[0]!.n, '1');
    });

    await t.test('a tampered watermark field is refused field by field', async () => {
      const facts = await candidateFacts(fixture.admin, created.candidateId);
      const decidedAt = await decidedAtOf(fixture.admin, 'hd-promote-1');
      const tampering = [
        { scopeKey: 'function:social-media' },
        { cursorOrdinal: facts.frontierOrdinal + 1 },
        { policyVersion: 'acme.dream.v3' },
        { consumedCompletedRuns: facts.consumedCompletedRuns + 1 },
        { consumedFeedbackRecords: facts.consumedFeedbackRecords + 1 },
        { actorAssurance: 'host-attested' as const },
      ];
      for (const overrides of tampering) {
        const canonical = normalizeLessonDecision(fixture.workspaceId, {
          decision: 'promote',
          candidateId: created.candidateId,
          humanDecisionId: 'hd-promote-1',
          actionDigest: (await recordDecision(
            fixture, 'hd-promote-1', 'promote', created.candidateId, 'agent:social-media/manager',
          )).actionDigest,
          frontierOrdinal: facts.frontierOrdinal,
          decidedAt,
          lessonQualifiedId: `${facts.lessonAgentKey}/playbook/${facts.lessonId}`,
          lessonContentHash: CONTENT_HASH,
          watermarkCanonical: dreamWatermarkCanonical({
            scopeKey: facts.scopeKey,
            cursorOrdinal: facts.frontierOrdinal,
            policyVersion: facts.policyVersion,
            reason: 'promotion',
            consumedCompletedRuns: facts.consumedCompletedRuns,
            consumedFeedbackRecords: facts.consumedFeedbackRecords,
            actorAssurance: 'human-confirmed',
            ...overrides,
          }),
        }).canonical;
        await assert.rejects(
          decideLessonCandidate(fixture.runtime, canonical),
          // A tampered advance either fails the field-by-field comparison or,
          // for the same decision identity, the byte-compare replay guard --
          // both refuse without mutating.
          (error: unknown) => {
            const code = (error as { code?: string }).code;
            assert.ok(
              code === 'BRAIN_DREAM_SNAPSHOT_STALE' || code === 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT',
              `${JSON.stringify(overrides)}: ${String(code)}`,
            );
            return true;
          },
          JSON.stringify(overrides),
        );
      }
    });

    await t.test('a retire names the committed promotion identity and moves the governor', async () => {
      const wrongHash = await recordDecision(
        fixture, 'hd-retire-wrong', 'retire', created.candidateId, 'agent:social-media/manager',
      );
      await assert.rejects(
        decide(fixture, 'retire', created.candidateId, wrongHash, {
          contentHash: `sha256:${'9'.repeat(64)}`,
        }),
        refuses('BRAIN_DREAM_DECISION_UNBOUND'),
      );

      const decision = await recordDecision(
        fixture, 'hd-retire-1', 'retire', created.candidateId, 'agent:social-media/manager',
      );
      const retired = await decide(
        fixture, 'retire', created.candidateId, decision, { contentHash: CONTENT_HASH },
      );
      assert.equal(retired.status, 'created');
      assert.equal(retired.subjectCurrent, true);
      assert.equal(retired.subjectSequence, 2);
      assert.equal(retired.watermarkScopeKey, null);

      // The retired promote REPLAY is no longer the governor, so the CLI does no
      // filesystem work for it -- that is what stops a stale replay resurrecting
      // a retired lesson.
      const promoteReplay = await decide(fixture, 'promote', created.candidateId, {
        decisionId: 'hd-promote-1',
        actionDigest: (await recordDecision(
          fixture, 'hd-promote-1', 'promote', created.candidateId, 'agent:social-media/manager',
        )).actionDigest,
      }, { contentHash: CONTENT_HASH });
      assert.equal(promoteReplay.status, 'existing');
      assert.equal(promoteReplay.subjectCurrent, false);
    });

    await t.test('a rejected sibling never strands a committed promote replay', async () => {
      // The governor comparison is restricted to the MATERIALIZATION ledger, so
      // a sibling's reject cannot flip a committed promote's replay verdict.
      await seedRuns(fixture, 6, {}, 'later');
      const later = await readiness(fixture);
      const laterCites = await citation(fixture, 'later-0');
      // Both candidates are drafted over the SAME snapshot: a promotion advances
      // the watermark, and a create over a consumed snapshot is refused.
      const successor = await createCandidate(fixture, later, laterCites, { lessonId: 'first-lesson' });
      const sibling = await createCandidate(fixture, later, laterCites, { lessonId: 'unrelated' });
      const promote = await recordDecision(
        fixture, 'hd-successor', 'promote', successor.candidateId, 'agent:social-media/manager',
      );
      const promoted = await decide(
        fixture, 'promote', successor.candidateId, promote, { contentHash: CONTENT_HASH },
      );
      assert.equal(promoted.subjectCurrent, true);

      const rejection = await recordDecision(
        fixture, 'hd-sibling-reject', 'reject', sibling.candidateId, 'agent:social-media/manager',
      );
      await decide(fixture, 'reject', sibling.candidateId, rejection);

      const replay = await decide(
        fixture, 'promote', successor.candidateId, promote, { contentHash: CONTENT_HASH },
      );
      assert.equal(replay.status, 'existing');
      assert.equal(replay.subjectCurrent, true, 'a sibling reject must not strand this promotion');
    });

    await t.test('the transition table refuses every unavailable move', async () => {
      await seedRuns(fixture, 6, {}, 'transition');
      const current = await readiness(fixture);
      const cites2 = await citation(fixture, 'transition-0');
      const open = await createCandidate(fixture, current, cites2, { lessonId: 'transition-check' });
      // retire requires `promoted`.
      const retire = await recordDecision(
        fixture, 'hd-bad-retire', 'retire', open.candidateId, 'agent:social-media/manager',
      );
      await assert.rejects(
        decide(fixture, 'retire', open.candidateId, retire, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_STATE_INVALID'),
      );
      // reject then promote: promote requires `open`.
      const reject = await recordDecision(
        fixture, 'hd-transition-reject', 'reject', open.candidateId, 'agent:social-media/manager',
      );
      await decide(fixture, 'reject', open.candidateId, reject);
      const promote = await recordDecision(
        fixture, 'hd-transition-promote', 'promote', open.candidateId, 'agent:social-media/manager',
      );
      await assert.rejects(
        decide(fixture, 'promote', open.candidateId, promote, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_STATE_INVALID'),
      );
    });
  } finally {
    await fixture.close();
  }
});

test('a promotion is re-proved against current policy and real time', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-promotion-revalidate');
  try {
    await seedRuns(fixture, 6);
    const snapshot = await readiness(fixture);
    const cites = await citation(fixture, 'run-0');
    const created = await createCandidate(fixture, snapshot, cites, { lessonId: 'revalidated' });
    const decision = await recordDecision(
      fixture, 'hd-revalidate', 'promote', created.candidateId, 'agent:social-media/manager',
    );

    await t.test('a policy registered between create and promote refuses the promotion', async () => {
      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'stricter.dream.v1',
        scopeKey: 'workspace',
        minCompletedRuns: 5,
        activationAssurance: 'human-confirmed',
        registeredBy: 'fixture',
      });
      await assert.rejects(
        decide(fixture, 'promote', created.candidateId, decision, { contentHash: CONTENT_HASH }),
        refuses('BRAIN_DREAM_SNAPSHOT_STALE'),
      );
    });

    await t.test('a promotion whose evidence aged out is refused at promote time', async () => {
      // A candidate that proved due-ness at create, then real time moved past
      // the evidence window: `clock_timestamp()` is what catches it, so a
      // transaction opened before expiry cannot promote after it.
      const aged = await createEvidenceFixture('dream-promotion-aged');
      try {
        await seedRuns(aged, 6);
        const snap = await readiness(aged);
        const cites = [{
          role: 'supporting' as const,
          evidenceKind: 'completed-run' as const,
          runId: 'run-0',
          feedbackId: null,
          observationOrdinal: await observationOrdinal(aged.admin, 'completed-run', 'run-0'),
        }];
        const candidate = await createCandidate(aged, snap, cites, { lessonId: 'ages-out' });
        const decision = await recordDecision(
          aged, 'hd-aged', 'promote', candidate.candidateId, 'agent:social-media/manager',
        );
        await aged.admin.query(
          `ALTER TABLE brain_evidence.evidence_observations DISABLE TRIGGER evidence_observations_immutable`,
        );
        await aged.admin.query(
          `UPDATE brain_evidence.evidence_observations SET recorded_at = now() - interval '400 days'`,
        );
        await aged.admin.query(
          `ALTER TABLE brain_evidence.evidence_observations ENABLE TRIGGER evidence_observations_immutable`,
        );
        await assert.rejects(
          decide(aged, 'promote', candidate.candidateId, decision, { contentHash: CONTENT_HASH }),
          refuses('BRAIN_DREAM_SNAPSHOT_STALE'),
        );
        // Nothing was advanced by the refusal.
        const watermarks = await aged.admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_evidence.dream_watermarks`,
        );
        assert.equal(watermarks.rows[0]!.n, '0');
      } finally {
        await aged.close();
      }
    });

  } finally {
    await fixture.close();
  }
});
