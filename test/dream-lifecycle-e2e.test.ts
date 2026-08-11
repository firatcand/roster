import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { scaffoldWorkspace } from '../src/lib/workspace-registry.ts';
import { hashWorkspaceBytes, readWorkspaceFile, readWorkspaceText } from '../src/lib/workspace-io.ts';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY } from '../src/lib/brain/dream-contracts.ts';
import { listDreamCandidates, loadDreamCandidate } from '../src/lib/brain/dream-candidates.ts';
import { recordHumanDecision } from '../src/lib/brain/evidence-store.ts';
import { evidenceActionDigest } from '../src/lib/brain/evidence-identity.ts';
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

    await t.test('an UNREADABLE path is red, never the healthy retired state', async () => {
      // Both "absent" and "unregistered" are the DESIRED retired states, so a
      // read failure that collapsed into them would report a retired subject
      // with a symlink, a directory, or a refused read as HEALTHY.
      const paths = resolveLessonPaths(root, 'social-media/manager', 'shorter-openers');
      mkdirSync(join(root, paths.lessonPath));
      try {
        const report = await auditLessonDrift(fixture.runtime, root);
        assert.equal(report.ok, false, 'an unreadable retired path must be RED');
        assert.deepEqual(report.findings.map((finding) => finding.code), ['lesson-unreadable']);
        assert.match(report.findings[0]!.detail, /could not be read/u);
      } finally {
        rmSync(join(root, paths.lessonPath), { recursive: true, force: true });
      }
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

// --- the fence-loss and interleaving matrix -------------------------------
//
// Every schedule below kills the fence's BACKEND from the admin connection --
// the unpreventable class the transaction-local timeouts cannot neutralize --
// and asserts the two claims the design actually makes: no phase whose fence
// was lost is ever reported as SUCCESS, and no stale phase ever damages a
// successor's completed materialization.

async function killFenceBackend(fixture: EvidenceFixture): Promise<number> {
  // Targeted through pg_stat_activity: the fence is the only session holding an
  // ADVISORY lock while idle in transaction, because that is exactly what
  // hold_dream_subject_lock leaves behind for the filesystem phase.
  const killed = await fixture.admin.query<{ pid: number }>(
    `SELECT DISTINCT a.pid
       FROM pg_stat_activity a
       JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'advisory'
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND a.state = 'idle in transaction'`,
  );
  for (const row of killed.rows) {
    await fixture.admin.query(`SELECT pg_terminate_backend($1)`, [row.pid]);
  }
  return killed.rows.length;
}

function withUncaughtProbe(): { readonly seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const onUncaught = (error: unknown): void => { seen.push(error); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  return {
    seen,
    stop: () => {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUncaught);
    },
  };
}

async function openCandidate(
  fixture: EvidenceFixture,
  lessonId: string,
  overrides: Record<string, unknown> = {},
  seedPrefix = 'run',
): Promise<string> {
  const snapshot = await readiness(fixture);
  const created = await createCandidate(fixture, snapshot, [{
    role: 'supporting',
    evidenceKind: 'completed-run',
    runId: `${seedPrefix}-0`,
    feedbackId: null,
    observationOrdinal: await observationOrdinal(fixture.admin, 'completed-run', `${seedPrefix}-0`),
  }], { lessonId, ...overrides });
  return created.candidateId;
}

test('the SKILL workflow, followed literally, produces an accepted decision', options, async () => {
  const fixture = await createEvidenceFixture('dream-e2e-skill');
  const { root, cleanup } = workspace();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const candidateId = await openCandidate(fixture, 'skill-workflow');

    // STEP: `roster dream candidates list --candidate <id> --json`. The SKILL
    // tells a host to READ the decision action here rather than derive it,
    // because the target is a grouped spelling of the digest that no host can
    // reconstruct from the candidate id alone.
    const listed = await listDreamCandidates(fixture.runtime, { candidateId });
    assert.equal(listed.length, 1);
    const action = listed[0]!.decision_action.promote;
    assert.match(action.target, /^dream-candidate:(?:[0-9a-f]{4}-){16}$/u);
    assert.equal(action.target.includes('sha256:'), false);
    assert.equal(action.effect, 'dream-candidate-promote');
    assert.equal(action.scope, listed[0]!.lesson_scope_key);

    // STEP: `roster brain record decision` with those fields copied VERBATIM.
    const recorded = { ...action, params: {} };
    await recordHumanDecision(fixture.admin, {
      decisionId: 'hd-skill-workflow',
      action: recorded,
      actionSummary: 'approve the drafted lesson',
      requestedDecision: 'approval',
      answer: 'approved',
      privacy: 'internal',
      trust: 'host-asserted',
      actor: {
        actorId: 'human',
        assurance: 'human-confirmed',
        decisionId: 'hd-skill-workflow',
        actionDigest: evidenceActionDigest(recorded),
      },
      decidedAt: '2026-08-11T09:00:00.000Z',
      hostProvenance: { host: 'claude' },
    });

    // STEP: `roster dream candidates promote <id> --decision <id> --action-digest <...>`.
    const candidate = await loadDreamCandidate(fixture.runtime, candidateId);
    const rendered = renderLessonContent(
      candidate.lessonId, candidate.lessonPurpose, candidate.lessonBody,
      lessonTargetScope(candidate.lessonScopeKey),
    );
    const committed = await decide(fixture, 'promote', candidateId, {
      decisionId: 'hd-skill-workflow',
      actionDigest: evidenceActionDigest(recorded),
    }, { contentHash: rendered.contentHash });
    assert.equal(committed.status, 'created', 'the documented workflow must be ACCEPTED');

    const outcome = await withSubjectFence({
      pool: fixture.runtime,
      root,
      candidateId,
      expectedDecision: 'promote',
      expectedSubjectSequence: committed.subjectSequence,
      phase: async (context) => await materializeLesson({ root, candidate, context }),
    });
    assert.equal(outcome.outcome, 'completed');

    // And the spelling the SKILL used to teach is REFUSED, so the fix is not
    // cosmetic: a host following the old text could never have promoted.
    const legacy = { target: candidateId, effect: 'dream-candidate-reject', scope: candidate.lessonScopeKey, params: {} };
    await assert.rejects(
      recordHumanDecision(fixture.admin, {
        decisionId: 'hd-skill-legacy',
        action: legacy,
        actionSummary: 'reject the drafted lesson',
        requestedDecision: 'approval',
        answer: 'rejected',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: {
          actorId: 'human',
          assurance: 'human-confirmed',
          decisionId: 'hd-skill-legacy',
          actionDigest: evidenceActionDigest(legacy),
        },
        decidedAt: '2026-08-11T09:00:00.000Z',
        hostProvenance: { host: 'claude' },
      }),
      /looks like a credential/u,
    );
  } finally {
    cleanup();
    await fixture.close();
  }
});

test('a fence lost BEFORE the phase touches no byte and reports UNVERIFIED', options, async () => {
  const fixture = await createEvidenceFixture('dream-e2e-kill-pre');
  const { root, cleanup } = workspace();
  const probe = withUncaughtProbe();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const candidateId = await openCandidate(fixture, 'killed-early');
    const candidate = await loadDreamCandidate(fixture.runtime, candidateId);
    const rendered = renderLessonContent(
      candidate.lessonId, candidate.lessonPurpose, candidate.lessonBody,
      lessonTargetScope(candidate.lessonScopeKey),
    );
    const decision = await recordDecision(
      fixture, 'hd-kill-pre', 'promote', candidateId, candidate.lessonScopeKey,
    );
    const committed = await decide(fixture, 'promote', candidateId, decision, {
      contentHash: rendered.contentHash,
    });

    let phaseRan = false;
    const outcome = await withSubjectFence({
      pool: fixture.runtime,
      root,
      candidateId,
      expectedDecision: 'promote',
      expectedSubjectSequence: committed.subjectSequence,
      // The exact window: the fence is open, the phase lock is held, and the
      // backend dies before the first filesystem mutation.
      hooks: {
        afterPhaseLock: async () => {
          assert.equal(await killFenceBackend(fixture), 1, 'the fence backend must have been killed');
        },
      },
      phase: async (context) => {
        phaseRan = true;
        return await materializeLesson({ root, candidate, context });
      },
    });

    assert.equal(outcome.outcome, 'unverified');
    assert.equal((outcome as { stage: string }).stage, 'pre-phase');
    assert.equal(phaseRan, false, 'the phase must not run on a fence already lost');
    const paths = resolveLessonPaths(root, candidate.lessonAgentKey, candidate.lessonId);
    assert.equal(existsSync(join(root, paths.lessonPath)), false, 'ZERO mutations');
    assert.equal(
      readWorkspaceText(root, paths.agentPath).includes(candidate.lessonId),
      false,
      'no registration either',
    );
    // The phase lock is released on every path, so the re-run is not blocked.
    assert.equal(existsSync(join(root, '.roster/state/locks/dream-phase')), false);

    // The decision is durable, so the SAME command converges.
    const retry = await promote(fixture, root, candidateId, 'hd-kill-pre');
    assert.equal(retry.outcome, 'completed');
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, paths.lessonPath)), rendered.contentHash);

    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(probe.seen, [], 'a terminated checked-out client must never crash the process');
  } finally {
    probe.stop();
    cleanup();
    await fixture.close();
  }
});

test('a fence lost DURING the phase reports UNVERIFIED and the re-run converges', options, async () => {
  const fixture = await createEvidenceFixture('dream-e2e-kill-mid');
  const { root, cleanup } = workspace();
  const probe = withUncaughtProbe();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const candidateId = await openCandidate(fixture, 'killed-mid');
    const candidate = await loadDreamCandidate(fixture.runtime, candidateId);
    const rendered = renderLessonContent(
      candidate.lessonId, candidate.lessonPurpose, candidate.lessonBody,
      lessonTargetScope(candidate.lessonScopeKey),
    );
    const decision = await recordDecision(
      fixture, 'hd-kill-mid', 'promote', candidateId, candidate.lessonScopeKey,
    );
    const committed = await decide(fixture, 'promote', candidateId, decision, {
      contentHash: rendered.contentHash,
    });

    const outcome = await withSubjectFence({
      pool: fixture.runtime,
      root,
      candidateId,
      expectedDecision: 'promote',
      expectedSubjectSequence: committed.subjectSequence,
      phase: async (context) => {
        // Killed BETWEEN filesystem sub-steps: the stub and its registration are
        // already published, the body replacement has not happened yet.
        const result = await materializeLesson({
          root,
          candidate,
          context,
          hooks: {
            afterScaffold: async () => {
              assert.equal(await killFenceBackend(fixture), 1, 'the fence backend must have been killed');
            },
          },
        });
        return result;
      },
    });

    assert.equal(outcome.outcome, 'unverified');
    assert.equal((outcome as { stage: string }).stage, 'post-phase');
    const paths = resolveLessonPaths(root, candidate.lessonAgentKey, candidate.lessonId);
    // The residue is exactly the enumerated bounded class: hash-gated writes
    // that already landed. Nothing outside the lesson's own path moved.
    assert.equal(existsSync(join(root, paths.lessonPath)), true);
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, paths.lessonPath)), rendered.contentHash);

    const retry = await promote(fixture, root, candidateId, 'hd-kill-mid');
    assert.equal(retry.outcome, 'completed');
    assert.equal((retry as { value: { status: string } }).value.status, 'converged');
    assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);

    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(probe.seen, []);
  } finally {
    probe.stop();
    cleanup();
    await fixture.close();
  }
});

test('a stale retire can never damage a successor, in either schedule', options, async (t) => {
  for (const variant of ['byte-identical', 'different-bytes'] as const) {
    await t.test(`B promotes ${variant} content while A's retire fence is dead`, async () => {
      const fixture = await createEvidenceFixture(`dream-e2e-stale-${variant.slice(0, 6)}`);
      const { root, cleanup } = workspace();
      try {
        await zeroCooldown(fixture);
        await seedRuns(fixture, 6);
        // A promotes and materializes.
        const aId = await openCandidate(fixture, 'contested');
        const a = await loadDreamCandidate(fixture.runtime, aId);
        const aRendered = renderLessonContent(
          a.lessonId, a.lessonPurpose, a.lessonBody, lessonTargetScope(a.lessonScopeKey),
        );
        assert.equal((await promote(fixture, root, aId, 'hd-a-promote')).outcome, 'completed');

        // A's retire decision commits, and its fence dies BEFORE its phase.
        const retire = await recordDecision(fixture, 'hd-a-retire', 'retire', aId, a.lessonScopeKey);
        const retireCommitted = await decide(fixture, 'retire', aId, retire, {
          contentHash: aRendered.contentHash,
        });
        const staleOutcome = await withSubjectFence({
          pool: fixture.runtime,
          root,
          candidateId: aId,
          expectedDecision: 'retire',
          expectedSubjectSequence: retireCommitted.subjectSequence,
          hooks: {
            afterPhaseLock: async () => {
              assert.equal(await killFenceBackend(fixture), 1, 'the fence backend must have been killed');
            },
          },
          phase: async () => await retireLesson({
            root, candidate: a, lessonContentHash: aRendered.contentHash,
          }),
        });
        assert.equal(staleOutcome.outcome, 'unverified');
        assert.equal((staleOutcome as { stage: string }).stage, 'pre-phase');

        // B now promotes over the same lesson file. In the byte-identical
        // variant its content hashes EQUAL A's, which is precisely the case a
        // hash-based fence would get wrong -- ordering is what decides here.
        await seedRuns(fixture, 6, {}, 'later');
        const bId = await openCandidate(
          fixture,
          'contested',
          variant === 'byte-identical'
            ? {}
            : { lessonBody: 'A different body from B.', lessonPurpose: 'B purpose.' },
          'later',
        );
        const b = await loadDreamCandidate(fixture.runtime, bId);
        const bRendered = renderLessonContent(
          b.lessonId, b.lessonPurpose, b.lessonBody, lessonTargetScope(b.lessonScopeKey),
        );
        assert.equal(
          bRendered.contentHash === aRendered.contentHash,
          variant === 'byte-identical',
          'the variant must actually differ in bytes',
        );
        assert.equal((await promote(fixture, root, bId, 'hd-b-promote')).outcome, 'completed');

        const paths = resolveLessonPaths(root, b.lessonAgentKey, b.lessonId);
        // A's stale retire phase runs LAST. Its fence is dead, so the pre-phase
        // verification refuses before touching anything.
        const replay = await withSubjectFence({
          pool: fixture.runtime,
          root,
          candidateId: aId,
          expectedDecision: 'retire',
          expectedSubjectSequence: retireCommitted.subjectSequence,
          phase: async () => await retireLesson({
            root, candidate: a, lessonContentHash: aRendered.contentHash,
          }),
        });
        // Superseded (B's promote is the governor now) — either way, no phase.
        assert.equal(replay.outcome, 'superseded');
        assert.equal(
          hashWorkspaceBytes(readWorkspaceFile(root, paths.lessonPath)),
          bRendered.contentHash,
          "B's file must survive intact",
        );
        assert.match(
          readWorkspaceText(root, paths.agentPath),
          new RegExp(b.lessonId, 'u'),
          "B's membership must survive intact",
        );
        assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);
      } finally {
        cleanup();
        await fixture.close();
      }
    });
  }
});

test('two concurrent dream phases serialize on the phase lock', options, async () => {
  const fixture = await createEvidenceFixture('dream-e2e-two-phase');
  const { root, cleanup } = workspace();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const firstId = await openCandidate(fixture, 'first-phase');
    await seedRuns(fixture, 6, {}, 'later');
    // A DIFFERENT subject, so the two phases share no database lock at all --
    // the local phase lock is the only thing that can serialize them.
    const secondId = await openCandidate(fixture, 'second-phase', {}, 'later');

    const first = await loadDreamCandidate(fixture.runtime, firstId);
    const second = await loadDreamCandidate(fixture.runtime, secondId);
    const firstRendered = renderLessonContent(
      first.lessonId, first.lessonPurpose, first.lessonBody, lessonTargetScope(first.lessonScopeKey),
    );
    const secondRendered = renderLessonContent(
      second.lessonId, second.lessonPurpose, second.lessonBody, lessonTargetScope(second.lessonScopeKey),
    );
    const firstDecision = await recordDecision(
      fixture, 'hd-first-phase', 'promote', firstId, first.lessonScopeKey,
    );
    const firstCommitted = await decide(fixture, 'promote', firstId, firstDecision, {
      contentHash: firstRendered.contentHash,
    });
    const secondDecision = await recordDecision(
      fixture, 'hd-second-phase', 'promote', secondId, second.lessonScopeKey,
    );
    const secondCommitted = await decide(fixture, 'promote', secondId, secondDecision, {
      contentHash: secondRendered.contentHash,
    });

    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let secondError: unknown;

    const holder = withSubjectFence({
      pool: fixture.runtime,
      root,
      candidateId: firstId,
      expectedDecision: 'promote',
      expectedSubjectSequence: firstCommitted.subjectSequence,
      phase: async (context) => {
        const result = await materializeLesson({ root, candidate: first, context });
        // The phase lock is still held here; the competitor runs concurrently.
        await held;
        return result;
      },
    });

    // Concurrently: a second phase on a different subject.
    const competitor = (async () => {
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      try {
        return await withSubjectFence({
          pool: fixture.runtime,
          root,
          candidateId: secondId,
          expectedDecision: 'promote',
          expectedSubjectSequence: secondCommitted.subjectSequence,
          phase: async (context) =>
            await materializeLesson({ root, candidate: second, context }),
        });
      } catch (error) {
        secondError = error;
        return null;
      } finally {
        release();
      }
    })();

    const [firstOutcome, secondOutcome] = await Promise.all([holder, competitor]);
    assert.equal(firstOutcome.outcome, 'completed');
    assert.equal(secondOutcome, null, 'the second phase must not run while the first holds the lock');
    assert.equal((secondError as { code?: string }).code, 'WORKSPACE_BUSY');
    assert.equal(
      (secondError as { details: { lockPath: string } }).details.lockPath,
      '.roster/state/locks/dream-phase',
    );

    const secondPaths = resolveLessonPaths(root, second.lessonAgentKey, second.lessonId);
    assert.equal(existsSync(join(root, secondPaths.lessonPath)), false, 'the busy phase mutated nothing');

    // After release, the same run converges.
    const retry = await promote(fixture, root, secondId, 'hd-second-phase');
    assert.equal(retry.outcome, 'completed');
    assert.equal(
      hashWorkspaceBytes(readWorkspaceFile(root, secondPaths.lessonPath)),
      secondRendered.contentHash,
    );
    assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);
  } finally {
    cleanup();
    await fixture.close();
  }
});

test('A-first: a successor waits out a dying phase, then converges its residue', options, async () => {
  const fixture = await createEvidenceFixture('dream-e2e-a-first');
  const { root, cleanup } = workspace();
  const probe = withUncaughtProbe();
  try {
    await zeroCooldown(fixture);
    await seedRuns(fixture, 6);
    const aId = await openCandidate(fixture, 'a-first-lesson');
    const a = await loadDreamCandidate(fixture.runtime, aId);
    const aRendered = renderLessonContent(
      a.lessonId, a.lessonPurpose, a.lessonBody, lessonTargetScope(a.lessonScopeKey),
    );
    const aDecision = await recordDecision(fixture, 'hd-a-first', 'promote', aId, a.lessonScopeKey);
    const aCommitted = await decide(fixture, 'promote', aId, aDecision, {
      contentHash: aRendered.contentHash,
    });

    // A DIFFERENT subject, so only the phase lock can order these two.
    await seedRuns(fixture, 6, {}, 'later');
    const bId = await openCandidate(fixture, 'b-second-lesson', {}, 'later');
    const b = await loadDreamCandidate(fixture.runtime, bId);
    const bRendered = renderLessonContent(
      b.lessonId, b.lessonPurpose, b.lessonBody, lessonTargetScope(b.lessonScopeKey),
    );
    const bDecision = await recordDecision(fixture, 'hd-b-second', 'promote', bId, b.lessonScopeKey);
    const bCommitted = await decide(fixture, 'promote', bId, bDecision, {
      contentHash: bRendered.contentHash,
    });

    let releaseA = (): void => {};
    const aHeld = new Promise<void>((resolve) => { releaseA = resolve; });
    let bError: unknown;

    // A starts its phase FIRST and its fence dies mid-phase, while it still
    // holds the local phase lock.
    const aRun = withSubjectFence({
      pool: fixture.runtime,
      root,
      candidateId: aId,
      expectedDecision: 'promote',
      expectedSubjectSequence: aCommitted.subjectSequence,
      phase: async (context) => {
        const result = await materializeLesson({
          root,
          candidate: a,
          context,
          hooks: {
            afterScaffold: async () => {
              assert.equal(await killFenceBackend(fixture), 1, 'A’s fence backend must have been killed');
            },
          },
        });
        await aHeld;
        return result;
      },
    });

    const bRun = (async () => {
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      try {
        return await withSubjectFence({
          pool: fixture.runtime,
          root,
          candidateId: bId,
          expectedDecision: 'promote',
          expectedSubjectSequence: bCommitted.subjectSequence,
          phase: async (context) => await materializeLesson({ root, candidate: b, context }),
        });
      } catch (error) {
        bError = error;
        return null;
      } finally {
        releaseA();
      }
    })();

    const [aOutcome, bOutcome] = await Promise.all([aRun, bRun]);
    // A's fence is gone, so A is UNVERIFIED — never success — and B was excluded
    // from the workspace for the whole of A's phase.
    assert.equal(aOutcome.outcome, 'unverified');
    assert.equal(bOutcome, null);
    assert.equal((bError as { code?: string }).code, 'WORKSPACE_BUSY');
    const bPaths = resolveLessonPaths(root, b.lessonAgentKey, b.lessonId);
    assert.equal(existsSync(join(root, bPaths.lessonPath)), false);

    // After A ends, both re-runs converge — A's residue included.
    assert.equal((await promote(fixture, root, bId, 'hd-b-second')).outcome, 'completed');
    assert.equal((await promote(fixture, root, aId, 'hd-a-first')).outcome, 'completed');
    const aPaths = resolveLessonPaths(root, a.lessonAgentKey, a.lessonId);
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, aPaths.lessonPath)), aRendered.contentHash);
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, bPaths.lessonPath)), bRendered.contentHash);
    assert.equal((await auditLessonDrift(fixture.runtime, root)).ok, true);

    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(probe.seen, []);
  } finally {
    probe.stop();
    cleanup();
    await fixture.close();
  }
});
