import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import { scaffoldWorkspace, validateWorkspace } from '../src/lib/workspace-registry.ts';
import {
  ensureWorkspaceDirectory,
  hashWorkspaceBytes,
  publishCreateOnly,
  readWorkspaceFile,
  replaceWorkspaceFile,
  withWorkspaceLock,
} from '../src/lib/workspace-io.ts';
import { addYamlMembership, removeYamlMembership, renderMarkdownDefinition } from '../src/lib/workspace-record.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import type { VerifiedBrainPool } from '../src/lib/brain/workspace-authority.ts';
import type { DreamCandidateBinding } from '../src/lib/brain/dream-candidates.ts';
import {
  DREAM_PHASE_LOCK_PATH,
  LessonMaterializationConflict,
  acquireDreamPhaseLock,
  isLessonLifecycleConflict,
  materializeLesson,
  preflightLessonTarget,
  isFenceConnectionFailure,
  repairUnregisteredResidue,
  repairWrongScopeRegistration,
  renderLessonContent,
  resolveLessonPaths,
  retireLesson,
  withSubjectFence,
  type FenceContext,
  type RepairContext,
  type SubjectCandidate,
} from '../src/lib/brain/lesson-materialize.ts';
import { lessonTargetScope } from '../src/lib/brain/dream-candidate-contracts.ts';

const CANDIDATE_ID = `sha256:${'a'.repeat(64)}`;
const OTHER_CANDIDATE_ID = `sha256:${'b'.repeat(64)}`;

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-lesson-'));
  writeFileSync(join(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: lesson-test',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  scaffoldWorkspace(root, { kind: 'function', id: 'growth', purpose: 'Growth' });
  scaffoldWorkspace(root, { kind: 'agent', id: 'sdr', scope: 'function:growth', purpose: 'SDR' });
  scaffoldWorkspace(root, { kind: 'plan', id: 'outbound', scope: 'agent:growth/sdr', purpose: 'Outbound' });
  // The scaffolded plan is a DRAFT; a promote validates the whole target agent,
  // so the fixture authors a complete plan rather than leaving one that fails.
  writeFileSync(
    join(root, 'functions/growth/agents/sdr/plans/outbound.yaml'),
    YAML.stringify({
      schema_version: 2,
      id: 'outbound',
      agent: 'growth/sdr',
      purpose: 'Run outbound.',
      inputs: {},
      brain_selectors: {},
      guidelines: [],
      tool_uses: [],
      artifacts: {},
      caps: {},
      steps: [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the work.' }],
      completion: {
        artifacts: [],
        output_guidance: 'Return the result.',
        criteria: ['The work is complete.'],
      },
    }),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The playbook slot is created by scaffold on the real path; a test that plants
// residue there has to create it the same way first.
function plant(root: string, path: string, content: string): void {
  ensureWorkspaceDirectory(root, path.slice(0, path.lastIndexOf('/')));
  withWorkspaceLock(root, () => publishCreateOnly(root, path, content));
}

function candidate(overrides: Partial<DreamCandidateBinding> = {}): DreamCandidateBinding {
  return Object.freeze({
    candidateId: CANDIDATE_ID,
    scopeKey: 'workspace',
    lessonScopeKey: 'agent:growth/sdr',
    lessonAgentKey: 'growth/sdr',
    lessonId: 'shorter-openers',
    lessonPurpose: 'Open with one sentence about the prospect.',
    lessonBody: 'Lead with the prospect.\n\nKeep it under 60 words.',
    policyVersion: 'roster.dream.default.v1',
    watermarkOrdinal: 0,
    frontierOrdinal: 9,
    consumedCompletedRuns: 7,
    consumedFeedbackRecords: 2,
    state: 'promoted',
    ...overrides,
  });
}

function context(overrides: Partial<FenceContext['fence']> = {}, subjects: FenceContext['subjectCandidates'] = []): FenceContext {
  return Object.freeze({
    fence: Object.freeze({
      lessonAgentKey: 'growth/sdr',
      lessonId: 'shorter-openers',
      governorCandidateId: CANDIDATE_ID,
      governorDecision: 'promote' as const,
      governorSubjectSequence: 1,
      retiredContentHashes: Object.freeze([]),
      ...overrides,
    }),
    subjectCandidates: subjects,
  });
}

test('rendering is deterministic and the hash is the hash of the published file', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const scope = lessonTargetScope(binding.lessonScopeKey);
    const first = renderLessonContent(binding.lessonId, binding.lessonPurpose, binding.lessonBody, scope);
    const second = renderLessonContent(binding.lessonId, binding.lessonPurpose, binding.lessonBody, scope);
    assert.equal(first.content, second.content);
    assert.equal(first.contentHash, second.contentHash);
    assert.notEqual(first.contentHash, first.stubHash);

    const result = await materializeLesson({ root, candidate: binding, context: context() });
    assert.equal(result.status, 'created');
    assert.equal(result.path, 'functions/growth/agents/sdr/playbook/shorter-openers.md');
    assert.equal(result.qualifiedId, 'growth/sdr/playbook/shorter-openers');
    assert.equal(result.contentHash, first.contentHash);
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), first.contentHash);

    // Re-running converges to the identical bytes and reports it as such.
    const replay = await materializeLesson({ root, candidate: binding, context: context() });
    assert.equal(replay.status, 'converged');
    assert.deepEqual(replay.repairs, []);
  } finally {
    cleanup();
  }
});

test('a crash between the stub publish and the body replace resumes from the stub', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    // Exactly the state scaffoldWorkspace leaves behind: the stub is published
    // and registered, but the body was never written.
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: binding.lessonId,
      scope: binding.lessonScopeKey,
      purpose: binding.lessonPurpose,
    });
    const result = await materializeLesson({ root, candidate: binding, context: context() });
    assert.equal(result.status, 'created');
    const rendered = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), rendered.contentHash);
  } finally {
    cleanup();
  }
});

test('foreign bytes at the target are preserved and reported, never overwritten', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    // A human-authored, unregistered file matching NO recorded content.
    plant(root, paths.lessonPath, '---\nschema_version: 2\n---\n\n# Someone else\n');
    const before = readWorkspaceFile(root, paths.lessonPath);

    await assert.rejects(
      materializeLesson({ root, candidate: binding, context: context() }),
      (error: unknown) => {
        assert.ok(isLessonLifecycleConflict(error), String(error));
        assert.equal(error.code, 'LESSON_MATERIALIZATION_CONFLICT');
        return true;
      },
    );
    assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), before);
  } finally {
    cleanup();
  }
});

test('a predecessor governor retired file is replaced only when its hash was recorded', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    const predecessor = renderLessonContent(
      binding.lessonId,
      'An older purpose.',
      'Older body.',
      lessonTargetScope(binding.lessonScopeKey),
    );
    plant(root, paths.lessonPath, predecessor.content);
    withWorkspaceLock(root, () => {
      const agentBytes = readWorkspaceFile(root, paths.agentPath);
      replaceWorkspaceFile(
        root,
        paths.agentPath,
        addYamlMembership(agentBytes.toString('utf8'), paths.agentPath, 'lessons', binding.lessonId),
        { expectedHash: hashWorkspaceBytes(agentBytes) },
      );
    });

    // Without the recorded retire hash, the predecessor's bytes are foreign.
    await assert.rejects(
      materializeLesson({ root, candidate: binding, context: context() }),
      (error: unknown) => isLessonLifecycleConflict(error),
    );

    // With it, the predecessor-cleanup arm converges.
    const result = await materializeLesson({
      root,
      candidate: binding,
      context: context({ retiredContentHashes: [predecessor.contentHash] }),
    });
    assert.equal(result.status, 'replaced');
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);
  } finally {
    cleanup();
  }
});

test('the widened membership-absent arm removes a recorded-derivable stub and refuses foreign bytes', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    // The F-6a residue: an UNREGISTERED stub left by a crash-interrupted repair,
    // rendered at a DIFFERENT sibling's own scope spelling. With no registration
    // present there is nothing a removal can destroy, so it converges.
    const siblingScope = lessonTargetScope('plan:growth/sdr#outbound');
    const siblingStub = renderMarkdownDefinition('lesson', binding.lessonId, 'Sibling purpose.', siblingScope);
    plant(root, paths.lessonPath, siblingStub);
    const result = await materializeLesson({
      root,
      candidate: binding,
      context: context({}, [{
        candidateId: OTHER_CANDIDATE_ID,
        lessonScopeKey: 'plan:growth/sdr#outbound',
        lessonPurpose: 'Sibling purpose.',
      }]),
    });
    assert.equal(result.repairs.includes('unregistered-residue'), true);
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);
  } finally {
    cleanup();
  }
});

test('the membership-PRESENT arm refuses a different-scope sibling stub it would deregister', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    // The registration is at PLAN scope; the governor targets AGENT scope.
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: binding.lessonId,
      scope: 'plan:growth/sdr#outbound',
      purpose: 'Sibling purpose.',
    });
    const before = readWorkspaceFile(root, paths.lessonPath);
    const agentBefore = readWorkspaceFile(root, paths.agentPath);

    // The registered entry's own stub is NOT among the prefetched candidates, so
    // provenance cannot be authenticated and BOTH the file and the registration
    // are preserved.
    await assert.rejects(
      materializeLesson({ root, candidate: binding, context: context({}, []) }),
      (error: unknown) => {
        assert.ok(isLessonLifecycleConflict(error), String(error));
        assert.equal(error.code, 'LESSON_MATERIALIZATION_CONFLICT');
        assert.equal((error as LessonMaterializationConflict).details.clause, 'c:provenance');
        return true;
      },
    );
    assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), before);
    assert.deepEqual(readWorkspaceFile(root, paths.agentPath), agentBefore);

    // With the registering candidate prefetched at its OWN scope spelling, the
    // arm authenticates the residue and re-registers under the governor's scope.
    const result = await materializeLesson({
      root,
      candidate: binding,
      context: context({}, [{
        candidateId: OTHER_CANDIDATE_ID,
        lessonScopeKey: 'plan:growth/sdr#outbound',
        lessonPurpose: 'Sibling purpose.',
      }]),
    });
    assert.equal(result.repairs.includes('wrong-scope-registration'), true);
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);
  } finally {
    cleanup();
  }
});

test('retire removes membership first, then the file, and converges on re-run', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const rendered = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    await materializeLesson({ root, candidate: binding, context: context() });
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);

    const result = await retireLesson({ root, candidate: binding, lessonContentHash: rendered.contentHash });
    assert.equal(result.status, 'retired');
    assert.equal(result.removedMembership, true);
    assert.equal(result.removedFile, true);
    assert.equal(existsSync(join(root, paths.lessonPath)), false);
    assert.equal(readWorkspaceFile(root, paths.agentPath).toString('utf8').includes(binding.lessonId), false);

    const replay = await retireLesson({ root, candidate: binding, lessonContentHash: rendered.contentHash });
    assert.equal(replay.status, 'already-absent');
  } finally {
    cleanup();
  }
});

test('retire leaves a drifted file inert and names the retirement conflict', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const rendered = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    await materializeLesson({ root, candidate: binding, context: context() });
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    // A human edited the promoted lesson after it landed.
    replaceWorkspaceFile(root, paths.lessonPath, `${rendered.content}\nEdited.\n`, {
      expectedHash: rendered.contentHash,
    });

    await assert.rejects(
      retireLesson({ root, candidate: binding, lessonContentHash: rendered.contentHash }),
      (error: unknown) => {
        assert.ok(isLessonLifecycleConflict(error), String(error));
        assert.equal(error.code, 'LESSON_RETIREMENT_CONFLICT');
        return true;
      },
    );
    // Membership removal came FIRST, so the drifted lesson is already out of
    // selection even though the file survives for a human to reconcile.
    assert.equal(existsSync(join(root, paths.lessonPath)), true);
    assert.equal(readWorkspaceFile(root, paths.agentPath).toString('utf8').includes(binding.lessonId), false);
  } finally {
    cleanup();
  }
});

test('removeYamlMembership is idempotent and leaves other members untouched', () => {
  const path = 'functions/growth/agents/sdr/agent.yaml';
  const original = [
    'schema_version: 2',
    'id: sdr',
    'function: growth',
    'purpose: SDR',
    'plans: []',
    'subagents: []',
    'guidelines: []',
    'default_guidelines: []',
    'tool_uses: []',
    'lessons:',
    '  - keep-me',
    '  - drop-me',
    '',
  ].join('\n');
  const removed = removeYamlMembership(original, path, 'lessons', 'drop-me');
  assert.equal(removed.includes('drop-me'), false);
  assert.equal(removed.includes('keep-me'), true);
  assert.equal(removeYamlMembership(removed, path, 'lessons', 'drop-me'), removed);
  assert.equal(removeYamlMembership(original, path, 'lessons', 'never-there'), original);
});

test('the workspace lock refuses an async callback loudly and consumes its rejection', async () => {
  const { root, cleanup } = fixture();
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { rejections.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.throws(
      () => withWorkspaceLock(root, () => Promise.resolve('never observed')),
      (error: unknown) => {
        assert.ok(isWorkspaceFailure(error), String(error));
        assert.equal(error.code, 'WRITE_CONFLICT');
        assert.match(error.message, /returned a promise/u);
        return true;
      },
    );
    assert.throws(
      () => withWorkspaceLock(root, () => Promise.reject(new Error('async failure'))),
      (error: unknown) => isWorkspaceFailure(error) && error.code === 'WRITE_CONFLICT',
    );
    // The guard attaches its own catch, so the abandoned promise never surfaces.
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.deepEqual(rejections, []);
    // The lock itself was released, so the next acquisition succeeds.
    assert.equal(withWorkspaceLock(root, () => 'sync'), 'sync');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    cleanup();
  }
});

test('the dream-phase lock is exclusive, records its owner, and releases cleanly', () => {
  const { root, cleanup } = fixture();
  try {
    const held = acquireDreamPhaseLock(root);
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH, 'owner.json')), true);
    const owner = JSON.parse(readFileSync(join(root, DREAM_PHASE_LOCK_PATH, 'owner.json'), 'utf8')) as {
      pid: number;
      host: string;
    };
    assert.equal(owner.pid, process.pid);
    assert.throws(
      () => acquireDreamPhaseLock(root),
      (error: unknown) => {
        assert.ok(isWorkspaceFailure(error), String(error));
        assert.equal(error.code, 'WORKSPACE_BUSY');
        assert.equal((error.details as { lockPath: string }).lockPath, DREAM_PHASE_LOCK_PATH);
        // The recorded owner is what a human uses to decide the lock is stale.
        assert.equal((error.details as { pid: number }).pid, process.pid);
        assert.match(error.remedy, /Remove '\.roster\/state\/locks\/dream-phase' manually/u);
        return true;
      },
    );
    held.release();
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), false);
    // Releasing twice is a no-op, so a `finally` release can never double-remove.
    held.release();
    acquireDreamPhaseLock(root).release();
  } finally {
    cleanup();
  }
});

test('the preflight only ever WARNS, even over bytes the phase will refuse', () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const scope = lessonTargetScope(binding.lessonScopeKey);
    assert.deepEqual(
      preflightLessonTarget(root, binding.lessonAgentKey, binding.lessonId, scope).map((w) => w.code),
      ['LESSON_UNREGISTERED'],
    );
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    plant(root, paths.lessonPath, '---\nschema_version: 2\n---\n\n# Foreign\n');
    const codes = preflightLessonTarget(root, binding.lessonAgentKey, binding.lessonId, scope)
      .map((warning) => warning.code);
    assert.deepEqual(codes, ['LESSON_FILE_PRESENT', 'LESSON_UNREGISTERED']);
    // An unknown function is not a preflight verdict either.
    assert.deepEqual(preflightLessonTarget(root, 'nope/none', 'x', scope), []);
  } finally {
    cleanup();
  }
});

type StubQuery = { text: string; values: readonly unknown[] };

function fenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lesson_agent_key: 'growth/sdr',
    lesson_id: 'shorter-openers',
    governor_candidate_id: CANDIDATE_ID,
    governor_decision: 'promote',
    governor_subject_sequence: '1',
    retired_content_hashes: [],
    ...overrides,
  };
}

function stubPool(options: {
  serverVersion?: string;
  subjectCandidates?: readonly SubjectCandidate[];
  failSubjectCandidates?: unknown;
  hold?: Record<string, unknown> | (() => never);
  verify?: (call: number) => Record<string, unknown> | null;
  onQuery?: (text: string) => void;
}): { pool: VerifiedBrainPool; queries: StubQuery[]; released: boolean[] } {
  const queries: StubQuery[] = [];
  const released: boolean[] = [];
  let verifyCalls = 0;
  const client = {
    on: () => client,
    removeListener: () => client,
    release: () => { released.push(true); },
    query: (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      options.onQuery?.(text);
      if (text.includes('server_version_num')) {
        return Promise.resolve({ rows: [{ server_version_num: options.serverVersion ?? '160000' }] });
      }
      if (text.includes('hold_dream_subject_lock')) {
        if (typeof options.hold === 'function') options.hold();
        return Promise.resolve({ rows: [options.hold ?? fenceRow()] });
      }
      if (text.includes('verify_dream_subject_governor')) {
        verifyCalls++;
        const row = options.verify === undefined ? fenceRow() : options.verify(verifyCalls);
        if (row === null) return Promise.reject(new Error('connection terminated'));
        return Promise.resolve({ rows: [row] });
      }
      if (text.includes('FROM brain_evidence.dream_candidates')) {
        if (options.failSubjectCandidates !== undefined) {
          return Promise.reject(options.failSubjectCandidates);
        }
        return Promise.resolve({
          rows: (options.subjectCandidates ?? []).map((entry) => ({
            candidate_id: entry.candidateId,
            lesson_scope_key: entry.lessonScopeKey,
            lesson_purpose: entry.lessonPurpose,
          })),
        });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as VerifiedBrainPool;
  return { pool, queries, released };
}

test('the fence opens, neutralizes its timeouts, and gates every mutation behind two checks', async () => {
  const { root, cleanup } = fixture();
  try {
    const order: string[] = [];
    const { pool, queries, released } = stubPool({
      onQuery: (text) => { order.push(text); },
    });
    const outcome = await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async () => {
        order.push('PHASE');
        assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), true);
        return 'done';
      },
    });
    assert.deepEqual(outcome, { outcome: 'completed', value: 'done' });

    const texts = queries.map((query) => query.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[1], 'SET LOCAL idle_in_transaction_session_timeout = 0');
    // PG16 does not know transaction_timeout, and SET LOCAL of an unknown GUC
    // poisons the transaction, so the gate must NOT be taken here.
    assert.equal(texts.some((text) => text.includes('transaction_timeout')), false);
    const holdAt = texts.findIndex((text) => text.includes('hold_dream_subject_lock'));
    const phaseAt = order.indexOf('PHASE');
    const preVerifyAt = order.findIndex((text) => text.includes('verify_dream_subject_governor'));
    assert.ok(holdAt >= 0);
    assert.ok(preVerifyAt >= 0 && preVerifyAt < phaseAt, 'pre-phase verification runs before the phase');
    const verifyCount = texts.filter((text) => text.includes('verify_dream_subject_governor')).length;
    assert.equal(verifyCount, 2, 'the fence verifies before AND after the phase');
    // The POST-phase check is the read-only verifier, never the lock-acquiring
    // fence: a phase-lock holder must never wait on a database lock.
    const lastFenceCall = [...texts].reverse().find((text) =>
      text.includes('hold_dream_subject_lock') || text.includes('verify_dream_subject_governor'));
    assert.match(lastFenceCall!, /verify_dream_subject_governor/u);
    assert.equal(texts.at(-1), 'COMMIT');
    assert.deepEqual(released, [true]);
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), false);
  } finally {
    cleanup();
  }
});

test('the PostgreSQL 17 branch issues the transaction_timeout override', async () => {
  const { root, cleanup } = fixture();
  try {
    const { pool, queries } = stubPool({ serverVersion: '170004' });
    await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async () => 'done',
    });
    assert.equal(
      queries.map((query) => query.text).includes('SET LOCAL transaction_timeout = 0'),
      true,
    );
  } finally {
    cleanup();
  }
});

test('a stale fence verdict no-ops before the phase lock and before any mutation', async () => {
  const { root, cleanup } = fixture();
  try {
    const { pool, queries } = stubPool({
      hold: fenceRow({ governor_candidate_id: OTHER_CANDIDATE_ID, governor_subject_sequence: '2' }),
    });
    let ran = false;
    const outcome = await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async () => { ran = true; return 'done'; },
    });
    assert.deepEqual(outcome, { outcome: 'superseded' });
    assert.equal(ran, false);
    assert.equal(queries.at(-1)!.text, 'ROLLBACK');
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), false);
  } finally {
    cleanup();
  }
});

test('a fence lost before the phase reports UNVERIFIED with ZERO mutations', async () => {
  const { root, cleanup } = fixture();
  try {
    // The exact blocker scenario: the fence dies between fence-open and the
    // phase lock, so the pre-phase verification is what must catch it.
    const { pool } = stubPool({ verify: (call) => (call === 1 ? null : fenceRow()) });
    let ran = false;
    const outcome = await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async () => { ran = true; return 'done'; },
    });
    assert.equal(outcome.outcome, 'unverified');
    assert.equal((outcome as { stage: string }).stage, 'pre-phase');
    assert.equal(ran, false);
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), false);
  } finally {
    cleanup();
  }
});

test('a fence lost during the phase reports UNVERIFIED and never reports success', async () => {
  const { root, cleanup } = fixture();
  try {
    const { pool, queries } = stubPool({ verify: (call) => (call === 1 ? fenceRow() : null) });
    const binding = candidate();
    const outcome = await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async (fenceContext) =>
        await materializeLesson({ root, candidate: binding, context: fenceContext }),
    });
    assert.equal(outcome.outcome, 'unverified');
    assert.equal((outcome as { stage: string }).stage, 'post-phase');
    assert.equal(queries.map((query) => query.text).includes('COMMIT'), false);
    // The hash-gated writes that already landed stay on disk for the convergent
    // re-run; the CLI's report is what must never claim success.
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    assert.equal(existsSync(join(root, paths.lessonPath)), true);
  } finally {
    cleanup();
  }
});

test('a busy dream-phase lock rolls the fence back, releases the client, and mutates nothing', async () => {
  const { root, cleanup } = fixture();
  const blocker = acquireDreamPhaseLock(root);
  try {
    const { pool, queries, released } = stubPool({});
    let ran = false;
    await assert.rejects(
      withSubjectFence({
        pool,
        root,
        candidateId: CANDIDATE_ID,
        expectedDecision: 'promote',
        expectedSubjectSequence: 1,
        phase: async () => { ran = true; return 'done'; },
      }),
      (error: unknown) => {
        assert.ok(isWorkspaceFailure(error), String(error));
        assert.equal(error.code, 'WORKSPACE_BUSY');
        return true;
      },
    );
    assert.equal(ran, false);
    assert.equal(queries.map((query) => query.text).includes('ROLLBACK'), true);
    assert.deepEqual(released, [true]);
  } finally {
    blocker.release();
    cleanup();
  }
});

test('the phase issues no database call from inside a workspace lock', async () => {
  const { root, cleanup } = fixture();
  try {
    // Instrumenting the REAL path, not a dummy lock: withWorkspaceLock creates
    // '.roster/state/locks/scaffold' for exactly as long as it is held, so a
    // query issued while that directory exists IS a database call inside a
    // workspace lock. Every wrapper the materialization takes -- scaffold's own,
    // the repair arm's, and the read-arbitrate-replace one -- is covered by
    // construction, because they all use the same lock path.
    const observed: string[] = [];
    const { pool } = stubPool({
      subjectCandidates: [{
        candidateId: OTHER_CANDIDATE_ID,
        lessonScopeKey: 'plan:growth/sdr#outbound',
        lessonPurpose: 'Sibling purpose.',
      }],
      onQuery: (text) => {
        if (existsSync(join(root, '.roster/state/locks/scaffold'))) observed.push(text);
      },
    });
    const binding = candidate();
    // A run that exercises the repair arm too, so the pin covers more than the
    // clean path's single wrapper.
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: binding.lessonId,
      scope: 'plan:growth/sdr#outbound',
      purpose: 'Sibling purpose.',
    });
    await withSubjectFence({
      pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async (fenceContext) =>
        await materializeLesson({ root, candidate: binding, context: fenceContext }),
    });
    assert.deepEqual(observed, [], 'a database call was issued while a workspace lock was held');

    // The instrument itself has to be able to fail: a query deliberately issued
    // inside a wrapper is caught.
    const control: string[] = [];
    const { pool: controlPool } = stubPool({
      onQuery: (text) => {
        if (existsSync(join(root, '.roster/state/locks/scaffold'))) control.push(text);
      },
    });
    const client = await (controlPool as unknown as { connect: () => Promise<{
      query: (text: string) => Promise<unknown>;
      release: () => void;
    }> }).connect();
    withWorkspaceLock(root, () => {
      void client.query('SELECT 1 -- deliberately inside the lock');
      return null;
    });
    client.release();
    assert.deepEqual(control.map((text) => text.trim()), ['SELECT 1 -- deliberately inside the lock']);
  } finally {
    cleanup();
  }
});

// --- the repair-authentication matrix -------------------------------------
//
// Every clause is driven through the REAL arm, and every refusal asserts that
// BOTH the file and the registration survive: an arm that can delete is only
// safe if each clause it fails leaves the workspace exactly as it found it.

function repairContextFor(root: string, subjects: SubjectCandidate[] = []): RepairContext {
  const binding = candidate();
  return Object.freeze({
    root,
    paths: resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId),
    lessonId: binding.lessonId,
    targetScope: lessonTargetScope(binding.lessonScopeKey),
    expectedQualifiedId: 'growth/sdr/playbook/shorter-openers',
    governorCandidateId: CANDIDATE_ID,
    subjectCandidates: subjects,
    retiredContentHashes: [],
  });
}

function wellFormedDuplicateDetails(): Record<string, unknown> {
  return {
    kind: 'lesson',
    qualifiedId: 'growth/sdr/playbook/shorter-openers',
    existingScope: { function: 'growth', agent: 'sdr', plan: 'outbound' },
    requestedScope: { function: 'growth', agent: 'sdr' },
  };
}

function clauseOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    assert.ok(isLessonLifecycleConflict(error), String(error));
    return (error as LessonMaterializationConflict).details.clause ?? '(none)';
  }
  return '(no refusal)';
}

test('every DUPLICATE_IDENTITY clause refuses on its own and preserves both sides', () => {
  const { root, cleanup } = fixture();
  try {
    // The registered state the arm is allowed to repair: a PLAN-scoped
    // registration while the governor targets AGENT scope.
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: 'shorter-openers',
      scope: 'plan:growth/sdr#outbound',
      purpose: 'Sibling purpose.',
    });
    const context = repairContextFor(root);
    const paths = context.paths;
    const fileBefore = readWorkspaceFile(root, paths.lessonPath);
    const agentBefore = readWorkspaceFile(root, paths.agentPath);
    const preserved = (label: string): void => {
      assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), fileBefore, `${label}: file`);
      assert.deepEqual(readWorkspaceFile(root, paths.agentPath), agentBefore, `${label}: membership`);
    };

    // (a) The error itself. DUPLICATE_IDENTITY has seven raise sites; only the
    // scaffold scope-mismatch branch carries this exact four-key shape.
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['extra key', { ...wellFormedDuplicateDetails(), extra: 1 }, 'a:details-shape'],
      ['missing key', { kind: 'lesson', qualifiedId: 'x' }, 'a:details-shape'],
      ['wrong kind', { ...wellFormedDuplicateDetails(), kind: 'guideline' }, 'a:kind'],
      ['non-string qualified id', { ...wellFormedDuplicateDetails(), qualifiedId: 7 }, 'a:qualified-id'],
      ['foreign qualified id', { ...wellFormedDuplicateDetails(), qualifiedId: 'growth/other/playbook/x' }, 'a:qualified-id'],
      ['requested scope mismatch', {
        ...wellFormedDuplicateDetails(),
        requestedScope: { function: 'growth', agent: 'other' },
      }, 'a:requested-scope'],
      ['absent existing scope', { ...wellFormedDuplicateDetails(), existingScope: null }, 'a:existing-scope'],
      ['scopes equal', {
        ...wellFormedDuplicateDetails(),
        existingScope: { function: 'growth', agent: 'sdr' },
      }, 'a:scopes-equal'],
    ];
    for (const [label, details, expected] of cases) {
      assert.equal(clauseOf(() => repairWrongScopeRegistration(context, details)), expected, label);
      preserved(label);
    }

    // (c) Provenance. The registered entry's own stub is not among the
    // prefetched candidates, so nothing authenticates these bytes.
    assert.equal(
      clauseOf(() => repairWrongScopeRegistration(context, wellFormedDuplicateDetails())),
      'c:provenance',
    );
    preserved('no provenance');

    // A DIFFERENT-scope sibling's stub must be refused IN THIS ARM even though
    // the widened membership-absent arm accepts exactly those bytes: this arm
    // can destroy a registration, so it demands the REGISTERED scope's stub.
    const agentScoped = repairContextFor(root, [{
      candidateId: OTHER_CANDIDATE_ID,
      lessonScopeKey: 'agent:growth/sdr',
      lessonPurpose: 'Sibling purpose.',
    }]);
    assert.equal(
      clauseOf(() => repairWrongScopeRegistration(agentScoped, wellFormedDuplicateDetails())),
      'c:provenance',
    );
    preserved('different-scope sibling stub');

    // (d) The provenance match must not name the governor itself.
    const governorOwned = repairContextFor(root, [{
      candidateId: CANDIDATE_ID,
      lessonScopeKey: 'plan:growth/sdr#outbound',
      lessonPurpose: 'Sibling purpose.',
    }]);
    assert.equal(
      clauseOf(() => repairWrongScopeRegistration(governorOwned, wellFormedDuplicateDetails())),
      'd:registrant-is-governor',
    );
    preserved('registrant is governor');

    // (b) The re-derivation. With membership removed the arm aborts rather than
    // acting on a state that changed between the throw and the authentication.
    const agentText = readWorkspaceFile(root, paths.agentPath).toString('utf8');
    replaceWorkspaceFile(
      root,
      paths.agentPath,
      removeYamlMembership(agentText, paths.agentPath, 'lessons', 'shorter-openers'),
      { expectedHash: hashWorkspaceBytes(agentBefore) },
    );
    assert.equal(
      clauseOf(() => repairWrongScopeRegistration(context, wellFormedDuplicateDetails())),
      'b:membership-absent',
    );
    assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), fileBefore);
  } finally {
    cleanup();
  }
});

test('the membership-absent arm dispatches ONLY on the publish conflict and re-proves absence', () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    const stub = renderMarkdownDefinition(
      'lesson',
      binding.lessonId,
      'Sibling purpose.',
      lessonTargetScope('agent:growth/sdr'),
    );
    plant(root, paths.lessonPath, stub);
    const context = repairContextFor(root, [{
      candidateId: OTHER_CANDIDATE_ID,
      lessonScopeKey: 'agent:growth/sdr',
      lessonPurpose: 'Sibling purpose.',
    }]);
    const fileBefore = readWorkspaceFile(root, paths.lessonPath);

    // scaffold raises WRITE_CONFLICT for uncertain publication, a failed parent
    // replacement, and a changed lock owner too. None of those prove membership
    // is absent, and the registry deliberately PRESERVES the published child
    // when a parent commit cannot be proven — so only the publish conflict's own
    // three-key shape at THIS path may dispatch here.
    for (const [label, details] of [
      ['quarantine shape', {
        path: paths.lessonPath,
        canonicalPath: paths.lessonPath,
        quarantinePath: `${paths.lessonPath}.tmp`,
        expectedHash: 'x',
        cause: 'EIO',
        state: 'unknown',
      }],
      ['parent path', { path: paths.agentPath, expectedHash: 'x', actualHash: 'y' }],
      ['lock owner shape', { path: '.roster/state/locks/scaffold/owner.json' }],
    ] as const) {
      assert.equal(
        clauseOf(() => repairUnregisteredResidue(context, details as Record<string, unknown>)),
        label === 'parent path' ? 'x:path' : 'x:details-shape',
        label,
      );
      assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), fileBefore, label);
    }

    const publishConflict = {
      path: paths.lessonPath,
      expectedHash: `sha256:${'a'.repeat(64)}`,
      actualHash: hashWorkspaceBytes(fileBefore),
    };
    // Membership PRESENT re-proves absence and refuses, even with the right
    // shape and provably recorded-derivable bytes.
    const agentBytes = readWorkspaceFile(root, paths.agentPath);
    replaceWorkspaceFile(
      root,
      paths.agentPath,
      addYamlMembership(agentBytes.toString('utf8'), paths.agentPath, 'lessons', binding.lessonId),
      { expectedHash: hashWorkspaceBytes(agentBytes) },
    );
    assert.equal(
      clauseOf(() => repairUnregisteredResidue(context, publishConflict)),
      'x:membership-present',
    );
    assert.deepEqual(readWorkspaceFile(root, paths.lessonPath), fileBefore);

    // With membership genuinely absent the same bytes ARE removed.
    const registered = readWorkspaceFile(root, paths.agentPath);
    replaceWorkspaceFile(
      root,
      paths.agentPath,
      removeYamlMembership(registered.toString('utf8'), paths.agentPath, 'lessons', binding.lessonId),
      { expectedHash: hashWorkspaceBytes(registered) },
    );
    repairUnregisteredResidue(context, publishConflict);
    assert.equal(existsSync(join(root, paths.lessonPath)), false);
  } finally {
    cleanup();
  }
});

test('F-6a: a crash after the repair arm removes membership converges on replay', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    scaffoldWorkspace(root, {
      kind: 'lesson',
      id: binding.lessonId,
      scope: 'plan:growth/sdr#outbound',
      purpose: 'Sibling purpose.',
    });
    const sibling: SubjectCandidate[] = [{
      candidateId: OTHER_CANDIDATE_ID,
      lessonScopeKey: 'plan:growth/sdr#outbound',
      lessonPurpose: 'Sibling purpose.',
    }];

    // The crash: membership removed, the stale stub still on disk.
    await assert.rejects(
      materializeLesson({
        root,
        candidate: binding,
        context: context({}, sibling),
        hooks: { afterRepairMembershipRemoval: () => { throw new Error('F-6a: process killed'); } },
      }),
      /F-6a: process killed/u,
    );
    const agentText = readWorkspaceFile(root, paths.agentPath).toString('utf8');
    assert.equal(agentText.includes(binding.lessonId), false, 'membership was removed');
    assert.equal(existsSync(join(root, paths.lessonPath)), true, 'the stale stub survives the crash');

    // The replay reaches the membership-absent publish conflict, the widened
    // stub arm authenticates the residue, and the governor's content lands.
    const result = await materializeLesson({
      root,
      candidate: binding,
      context: context({}, sibling),
    });
    assert.deepEqual(result.repairs, ['unregistered-residue']);
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);
    assert.match(
      readWorkspaceFile(root, paths.agentPath).toString('utf8'),
      new RegExp(binding.lessonId, 'u'),
    );
  } finally {
    cleanup();
  }
});

test('multiple skipped filesystem phases converge through the DESC retired walk', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    const scope = lessonTargetScope(binding.lessonScopeKey);
    // C1 and C2 both promoted and retired with their filesystem phases skipped,
    // so the file still holds C1's bytes when C3 promotes.
    const c1 = renderLessonContent(binding.lessonId, 'C1 purpose.', 'C1 body.', scope);
    const c2 = renderLessonContent(binding.lessonId, 'C2 purpose.', 'C2 body.', scope);
    plant(root, paths.lessonPath, c1.content);
    const agentBytes = readWorkspaceFile(root, paths.agentPath);
    replaceWorkspaceFile(
      root,
      paths.agentPath,
      addYamlMembership(agentBytes.toString('utf8'), paths.agentPath, 'lessons', binding.lessonId),
      { expectedHash: hashWorkspaceBytes(agentBytes) },
    );

    const result = await materializeLesson({
      root,
      candidate: binding,
      // Newest first, exactly as the fence returns them.
      context: context({ retiredContentHashes: [c2.contentHash, c1.contentHash] }),
    });
    assert.equal(result.status, 'replaced');
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      scope,
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);
  } finally {
    cleanup();
  }
});

test('a throwing phase-lock release still releases the fence client', async () => {
  const { root, cleanup } = fixture();
  try {
    const { pool, released } = stubPool({});
    // The lock directory is removed out from under the phase, so release()'s
    // identity re-check throws. The client release must still happen, or the
    // transaction and its subject advisory lock are stranded and every later
    // pool shutdown hangs.
    await assert.rejects(
      withSubjectFence({
        pool,
        root,
        candidateId: CANDIDATE_ID,
        expectedDecision: 'promote',
        expectedSubjectSequence: 1,
        phase: async () => {
          rmSync(join(root, DREAM_PHASE_LOCK_PATH), { recursive: true, force: true });
          return 'done';
        },
      }),
    );
    assert.deepEqual(released, [true], 'the client must be released even when the lock release throws');
  } finally {
    cleanup();
  }
});

test('a REPLACED phase-lock directory is preserved, not removed', () => {
  const { root, cleanup } = fixture();
  try {
    const held = acquireDreamPhaseLock(root);
    const absolute = join(root, DREAM_PHASE_LOCK_PATH);
    const original = statSync(absolute);
    // Another writer's lock now occupies the path. Removing it would delete a
    // live lock this process never acquired, so the dev/ino gate refuses.
    rmSync(absolute, { recursive: true, force: true });
    mkdirSync(absolute, { mode: 0o700 });
    const replacement = statSync(absolute);
    assert.notEqual(replacement.ino, original.ino, 'the fixture must actually replace the directory');

    assert.throws(
      () => held.release(),
      (error: unknown) => {
        assert.ok(isWorkspaceFailure(error), String(error));
        assert.equal(error.code, 'WORKSPACE_BUSY');
        assert.equal((error.details as { lockIno: number }).lockIno, original.ino);
        return true;
      },
    );
    assert.equal(existsSync(absolute), true, "the replacement lock must be preserved");
  } finally {
    rmSync(join(root, DREAM_PHASE_LOCK_PATH), { recursive: true, force: true });
    cleanup();
  }
});

test('an unrelated invalid record never blocks a converged materialization', async () => {
  const { root, cleanup } = fixture();
  try {
    const binding = candidate();
    // A sibling plan under the SAME agent is left as an invalid draft. It is
    // nothing this promotion caused and nothing it can fix, and the validation
    // runs AFTER the mutation -- so a workspace-wide verdict would report an
    // already-converged file as an unresolvable conflict on every re-run.
    scaffoldWorkspace(root, { kind: 'plan', id: 'broken', scope: 'agent:growth/sdr', purpose: 'Broken' });
    assert.equal(validateWorkspace(root, { target: 'growth/sdr' }).ok, false, 'the fixture must be invalid');

    const result = await materializeLesson({ root, candidate: binding, context: context() });
    assert.equal(result.status, 'created');
    const expected = renderLessonContent(
      binding.lessonId,
      binding.lessonPurpose,
      binding.lessonBody,
      lessonTargetScope(binding.lessonScopeKey),
    );
    assert.equal(hashWorkspaceBytes(readWorkspaceFile(root, result.path)), expected.contentHash);

    // The lesson's OWN validity is still enforced: a corrupted lesson record is
    // this verb's to answer for, and it refuses.
    const paths = resolveLessonPaths(root, binding.lessonAgentKey, binding.lessonId);
    writeFileSync(join(root, paths.lessonPath), '---\nschema_version: 2\nid: wrong-id\nkind: lesson\npurpose: p\nscope:\n  function: growth\n  agent: sdr\n---\n\n# Wrong\n');
    await assert.rejects(
      materializeLesson({ root, candidate: binding, context: context() }),
      // Either layer may catch it first -- the registry's embedded-identity
      // check or the scoped validation -- and both are refusals that leave the
      // authored bytes in place for a human.
      /embedded identity|does not validate/u,
    );
  } finally {
    cleanup();
  }
});

test('a lost fence and a broken query are classified apart', () => {
  // Connection class: the transport is gone, so the phase is UNVERIFIED and a
  // re-run converges.
  for (const [label, error] of [
    ['class 08', { code: '08006', message: 'connection failure' }],
    ['08003', { code: '08003' }],
    ['admin shutdown', { code: '57P01' }],
    ['crash shutdown', { code: '57P02' }],
    ['cannot connect now', { code: '57P03' }],
    ['database dropped', { code: '57P04' }],
    ['client-side, no SQLSTATE', { message: 'Client has encountered a connection error and is not queryable' }],
    ['socket reset, no SQLSTATE', { message: 'read ECONNRESET' }],
  ] as const) {
    assert.equal(isFenceConnectionFailure(error, undefined), true, label);
  }
  // A captured client 'error' event is itself proof the transport failed.
  assert.equal(isFenceConnectionFailure({ code: '42501' }, new Error('terminated')), true);

  // Everything else keeps its own identity. The load-bearing vector is the
  // last one: a SERVER error whose prose merely mentions a socket must not be
  // softened into a lost fence just because the word appears.
  for (const [label, error] of [
    ['undefined relation', { code: '42P01', message: 'relation does not exist' }],
    ['insufficient privilege', { code: '42501', message: 'permission denied' }],
    ['a lifecycle refusal', { code: 'RBE08', message: 'the human decision is not bound' }],
    ['server error naming a socket', {
      code: '42501',
      message: 'permission denied for relation socket_events',
    }],
    ['non-SQLSTATE code that is not five chars', { code: 'ETIMEDOUT', message: 'nope' }],
    ['no code and no message', {}],
  ] as const) {
    assert.equal(isFenceConnectionFailure(error, undefined), false, label);
  }
});

test('the fence maps a lost prefetch to UNVERIFIED and rethrows a real defect', async () => {
  const { root, cleanup } = fixture();
  try {
    // The prefetch is the last database read before the phase lock. A lost
    // connection there is the pre-phase UNVERIFIED outcome...
    const lost = stubPool({
      failSubjectCandidates: Object.assign(new Error('terminating connection due to administrator command'), {
        code: '57P01',
      }),
    });
    let ran = false;
    const outcome = await withSubjectFence({
      pool: lost.pool,
      root,
      candidateId: CANDIDATE_ID,
      expectedDecision: 'promote',
      expectedSubjectSequence: 1,
      phase: async () => { ran = true; return 'done'; },
    });
    assert.equal(outcome.outcome, 'unverified');
    assert.equal((outcome as { stage: string }).stage, 'pre-phase');
    assert.equal(ran, false);
    assert.deepEqual(lost.released, [true]);

    // ...while a schema or permission defect keeps its own identity, because a
    // re-run will reproduce it forever and "re-run, it converges" would be a lie.
    const broken = stubPool({
      failSubjectCandidates: Object.assign(new Error('permission denied for relation dream_candidates'), {
        code: '42501',
      }),
    });
    await assert.rejects(
      withSubjectFence({
        pool: broken.pool,
        root,
        candidateId: CANDIDATE_ID,
        expectedDecision: 'promote',
        expectedSubjectSequence: 1,
        phase: async () => 'done',
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '42501');
        return true;
      },
    );
    assert.deepEqual(broken.released, [true], 'the client is released on the defect path too');
    assert.equal(existsSync(join(root, DREAM_PHASE_LOCK_PATH)), false);
  } finally {
    cleanup();
  }
});
