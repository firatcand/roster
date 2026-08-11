import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { scaffoldWorkspace } from '../src/lib/workspace-registry.ts';
import { hashWorkspaceBytes, readWorkspaceFile, readWorkspaceText } from '../src/lib/workspace-io.ts';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY } from '../src/lib/brain/dream-contracts.ts';
import { loadDreamCandidate } from '../src/lib/brain/dream-candidates.ts';
import { lessonTargetScope } from '../src/lib/brain/dream-candidate-contracts.ts';
import {
  acquireDreamPhaseLock,
  materializeLesson,
  renderLessonContent,
  resolveLessonPaths,
  retireLesson,
  withSubjectFence,
} from '../src/lib/brain/lesson-materialize.ts';
import { auditLessonDrift } from '../src/lib/brain/lesson-drift.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture, type EvidenceFixture } from './support/brain-evidence-fixture.ts';
import {
  createCandidate,
  decide,
  observationOrdinal,
  readiness,
  recordDecision,
  seedFeedback,
  seedRuns,
} from './support/dream-lifecycle-fixture.ts';

const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-dream-e2e-'));
  writeFileSync(join(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: dream-e2e',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  scaffoldWorkspace(root, { kind: 'function', id: 'social-media', purpose: 'Social media' });
  scaffoldWorkspace(root, { kind: 'agent', id: 'manager', scope: 'function:social-media', purpose: 'Manager' });
  scaffoldWorkspace(root, { kind: 'plan', id: 'discovery', scope: 'agent:social-media/manager', purpose: 'Discovery' });
  writeFileSync(
    join(root, 'functions/social-media/agents/manager/plans/discovery.yaml'),
    YAML.stringify({
      schema_version: 2,
      id: 'discovery',
      agent: 'social-media/manager',
      purpose: 'Run discovery.',
      inputs: {},
      brain_selectors: {},
      guidelines: [],
      tool_uses: [],
      artifacts: {},
      caps: {},
      steps: [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the work.' }],
      completion: { artifacts: [], output_guidance: 'Return it.', criteria: ['Done.'] },
    }),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function zeroCooldown(fixture: EvidenceFixture): Promise<void> {
  await registerDreamPolicy(fixture.admin, {
    ...DEFAULT_DREAM_POLICY,
    policyVersion: 'e2e.dream.v1',
    scopeKey: 'workspace',
    cooldown: 'PT0S',
    activationAssurance: 'human-confirmed',
    registeredBy: 'e2e',
  });
}

async function promote(
  fixture: EvidenceFixture,
  root: string,
  candidateId: string,
  decisionId: string,
  hooks: Parameters<typeof materializeLesson>[0]['hooks'] = undefined,
): Promise<ReturnType<typeof withSubjectFence>> {
  const candidate = await loadDreamCandidate(fixture.runtime, candidateId);
  const rendered = renderLessonContent(
    candidate.lessonId,
    candidate.lessonPurpose,
    candidate.lessonBody,
    lessonTargetScope(candidate.lessonScopeKey),
  );
  const decision = await recordDecision(
    fixture, decisionId, 'promote', candidateId, candidate.lessonScopeKey,
  );
  const committed = await decide(fixture, 'promote', candidateId, decision, {
    contentHash: rendered.contentHash,
  });
  if (!committed.subjectCurrent) return { outcome: 'superseded' };
  return await withSubjectFence({
    pool: fixture.runtime,
    root,
    candidateId,
    expectedDecision: 'promote',
    expectedSubjectSequence: committed.subjectSequence,
    phase: async (context) => await materializeLesson({
      root,
      candidate,
      context,
      ...(hooks === undefined ? {} : { hooks }),
    }),
  });
}

test('the golden proof: due evidence becomes an approved lesson file, then retires', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-e2e');
  const { root, cleanup } = workspace();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    await seedFeedback(fixture, 'fb-0', 'run-0', { signal: 'negative' });

    const snapshot = await readiness(fixture);
    assert.equal(snapshot.status, 'due');
    const cites = [{
      role: 'supporting' as const,
      evidenceKind: 'completed-run' as const,
      runId: 'run-1',
      feedbackId: null,
      observationOrdinal: await observationOrdinal(fixture.admin, 'completed-run', 'run-1'),
    }];
    const created = await createCandidate(fixture, snapshot, cites, { lessonId: 'shorter-openers' });
    assert.equal(created.status, 'created');

    let lessonPath = '';
    let contentHash = '';

    await t.test('the human-approved candidate becomes a registered playbook file', async () => {
      const outcome = await promote(fixture, root, created.candidateId, 'hd-e2e-promote');
      assert.equal(outcome.outcome, 'completed');
      const result = (outcome as { value: { path: string; contentHash: string } }).value;
      lessonPath = result.path;
      contentHash = result.contentHash;
      assert.equal(lessonPath, 'functions/social-media/agents/manager/playbook/shorter-openers.md');
      assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, lessonPath)), contentHash);

      // The lesson is REGISTERED, which is what makes a later context select it.
      const agent = readWorkspaceText(root, 'functions/social-media/agents/manager/agent.yaml');
      assert.match(agent, /lessons:[\s\S]*shorter-openers/u);

      // The recorded promotion identity matches the file byte for byte.
      const stored = await fixture.admin.query<{ hash: string; qualified: string }>(
        `SELECT lesson_content_hash AS hash, lesson_qualified_id AS qualified
           FROM brain_evidence.lesson_decisions
          WHERE candidate_id = $1 AND decision = 'promote'`,
        [created.candidateId],
      );
      assert.equal(stored.rows[0]!.hash, contentHash);
      assert.equal(stored.rows[0]!.qualified, 'social-media/manager/playbook/shorter-openers');
    });

    await t.test('brain doctor reports the materialized lesson as converged', async () => {
      const report = await auditLessonDrift(fixture.runtime, root);
      assert.equal(report.ok, true, JSON.stringify(report.findings));
      assert.equal(report.subjects, 1);
    });

    await t.test('a killed run between the decision and the file converges on re-run', async () => {
      // The decision is committed and the file already matches, so the re-run is
      // an idempotent no-op that still reports success.
      const again = await promote(fixture, root, created.candidateId, 'hd-e2e-promote');
      assert.equal(again.outcome, 'completed');
      assert.equal((again as { value: { status: string } }).value.status, 'converged');
    });

    await t.test('doctor turns red when the file drifts from its governing decision', async () => {
      const paths = resolveLessonPaths(root, 'social-media/manager', 'shorter-openers');
      const original = readWorkspaceFile(root, paths.lessonPath);
      writeFileSync(join(root, paths.lessonPath), `${original.toString('utf8')}\nHand edited.\n`);
      const drifted = await auditLessonDrift(fixture.runtime, root);
      assert.equal(drifted.ok, false);
      assert.deepEqual(drifted.findings.map((finding) => finding.code), ['lesson-drifted']);
      writeFileSync(join(root, paths.lessonPath), original);
      assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);
    });

    await t.test('a retire deregisters first, removes the file, and reads green', async () => {
      const candidate = await loadDreamCandidate(fixture.runtime, created.candidateId);
      const decision = await recordDecision(
        fixture, 'hd-e2e-retire', 'retire', created.candidateId, candidate.lessonScopeKey,
      );
      const committed = await decide(fixture, 'retire', created.candidateId, decision, {
        contentHash,
      });
      assert.equal(committed.subjectCurrent, true);
      const outcome = await withSubjectFence({
        pool: fixture.runtime,
        root,
        candidateId: created.candidateId,
        expectedDecision: 'retire',
        expectedSubjectSequence: committed.subjectSequence,
        phase: async () => await retireLesson({
          root,
          candidate,
          lessonContentHash: contentHash,
        }),
      });
      assert.equal(outcome.outcome, 'completed');
      assert.equal(existsSync(join(root, lessonPath)), false);
      const agent = readWorkspaceText(root, 'functions/social-media/agents/manager/agent.yaml');
      assert.equal(agent.includes('shorter-openers'), false);
      assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);
    });

    await t.test('a stale promote replay after the retire touches nothing', async () => {
      const outcome = await promote(fixture, root, created.candidateId, 'hd-e2e-promote');
      // The retire is the governor now, so the replayed promote is a deliberate
      // NO-OP -- a retired lesson is never resurrected by a stale re-run.
      assert.equal(outcome.outcome, 'superseded');
      assert.equal(existsSync(join(root, lessonPath)), false);
    });
  } finally {
    cleanup();
    await fixture.close();
  }
});

test('the fence blocks a competing decision and the phase lock serializes phases', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-e2e-fence');
  const { root, cleanup } = workspace();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const snapshot = await readiness(fixture);
    const cites = [{
      role: 'supporting' as const,
      evidenceKind: 'completed-run' as const,
      runId: 'run-0',
      feedbackId: null,
      observationOrdinal: await observationOrdinal(fixture.admin, 'completed-run', 'run-0'),
    }];
    const first = await createCandidate(fixture, snapshot, cites, { lessonId: 'fenced-lesson' });
    const second = await createCandidate(fixture, snapshot, cites, {
      lessonId: 'fenced-lesson',
      lessonScopeKey: 'plan:social-media/manager#discovery',
    });

    await t.test('an open fence blocks a competing broker for the same subject', async () => {
      const candidate = await loadDreamCandidate(fixture.runtime, first.candidateId);
      const rendered = renderLessonContent(
        candidate.lessonId,
        candidate.lessonPurpose,
        candidate.lessonBody,
        lessonTargetScope(candidate.lessonScopeKey),
      );
      const decision = await recordDecision(
        fixture, 'hd-fence-promote', 'promote', first.candidateId, candidate.lessonScopeKey,
      );
      await decide(fixture, 'promote', first.candidateId, decision, {
        contentHash: rendered.contentHash,
      });

      // The fence transaction holds the SAME advisory frame both decide-broker
      // transactions acquire FIRST, so a competing acquisition for this subject
      // cannot proceed while it lives. A bounded statement_timeout turns "blocks
      // forever" into an observable, deterministic refusal.
      const fence = await fixture.runtime.connect();
      const competitor = await fixture.runtime.connect();
      try {
        await fence.query('BEGIN');
        await fence.query(
          `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
          [first.candidateId],
        );
        await competitor.query('BEGIN');
        await competitor.query(`SET LOCAL statement_timeout = '750ms'`);
        await assert.rejects(
          competitor.query(
            `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
            [second.candidateId],
          ),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, '57014', String((error as Error).message));
            return true;
          },
          'the second candidate shares the subject, so its fence must block',
        );
        await competitor.query('ROLLBACK');

        // The explicit BEGIN is load-bearing: under autocommit the transaction-
        // scoped lock would release at statement end and this would NOT block.
        await fence.query('COMMIT');
        await competitor.query('BEGIN');
        await competitor.query(`SET LOCAL statement_timeout = '750ms'`);
        const released = await competitor.query(
          `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
          [second.candidateId],
        );
        assert.equal(released.rows.length, 1);
        await competitor.query('ROLLBACK');
      } finally {
        await fence.query('ROLLBACK').catch(() => {});
        fence.release();
        competitor.release();
      }
    });

    await t.test('a second dream phase on ANY subject reports busy and converges after release', async () => {
      const held = acquireDreamPhaseLock(root);
      let busy: unknown;
      try {
        await withSubjectFence({
          pool: fixture.runtime,
          root,
          candidateId: first.candidateId,
          expectedDecision: 'promote',
          expectedSubjectSequence: 1,
          phase: async () => 'never runs',
        });
      } catch (error) {
        busy = error;
      } finally {
        held.release();
      }
      assert.equal((busy as { code?: string }).code, 'WORKSPACE_BUSY');
      // After release the same run converges.
      const outcome = await promote(fixture, root, first.candidateId, 'hd-fence-promote');
      assert.equal(outcome.outcome, 'completed');
      assert.equal(
        existsSync(join(root, 'functions/social-media/agents/manager/playbook/fenced-lesson.md')),
        true,
      );
    });
  } finally {
    cleanup();
    await fixture.close();
  }
});
