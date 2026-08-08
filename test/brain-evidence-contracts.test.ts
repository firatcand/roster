import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { RosterError } from '../src/lib/errors.ts';
import { canonicalSourceJson } from '../src/lib/brain/source-contracts.ts';
import {
  EVIDENCE_OUTCOMES,
  MAX_EVIDENCE_SOURCES,
  normalizeCompletedRun,
  normalizeFeedback,
  normalizeHumanDecision,
  normalizeRunArtifact,
  type CompletedRunInput,
  type FeedbackInput,
  type HumanDecisionInput,
  type RunArtifactInput,
} from '../src/lib/brain/evidence-contracts.ts';
import {
  EVIDENCE_LOCK_DOMAINS,
  derivePromotionId,
  derivePromotionSourceKey,
  evidenceActionDigest,
  evidenceLockFrame,
  evidenceRecordFingerprint,
  evidenceSummaryHash,
} from '../src/lib/brain/evidence-identity.ts';

const ACTOR = {
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'evidence-contracts',
} as const;

const REQUEST_HASH = `sha256:${'a'.repeat(64)}`;

function runInput(overrides: Partial<CompletedRunInput> = {}): CompletedRunInput {
  return {
    runId: 'run-2026-08-08-001',
    functionId: 'social-media',
    agentId: 'manager',
    planId: 'discovery',
    host: 'codex',
    hostVersion: '0.51.0',
    requestSummary: 'Draft the weekly launch post.',
    requestHash: REQUEST_HASH,
    startedAt: '2026-08-08T10:00:00.000Z',
    completedAt: '2026-08-08T10:04:30.000Z',
    outcome: 'succeeded',
    privacy: 'internal',
    trust: 'host-asserted',
    sources: [
      { kind: 'brain-source-version', sourceVersionId: `sha256:${'b'.repeat(64)}`, summary: 'brand guide' },
      { kind: 'external', locator: { provider: 'notion', page: 'launch-brief' } },
    ],
    tools: [{ toolUseId: 'social-publish', skillRef: 'vendor:buffer', summary: 'scheduled one post' }],
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-contracts' },
    ...overrides,
  } as CompletedRunInput;
}

function artifactInput(overrides: Partial<RunArtifactInput> = {}): RunArtifactInput {
  return {
    runId: 'run-2026-08-08-001',
    artifactId: 'post-draft.md',
    sha256: 'c'.repeat(64),
    byteLength: 2048,
    mediaType: 'text/markdown',
    pointer: { kind: 'external', locator: { provider: 'notion', block: 'abc123' } },
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-contracts' },
    ...overrides,
  } as RunArtifactInput;
}

function feedbackInput(overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    feedbackId: 'feedback-001',
    runId: 'run-2026-08-08-001',
    signal: 'positive',
    summary: 'The draft matched the brand voice.',
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-contracts' },
    ...overrides,
  } as FeedbackInput;
}

function decisionInput(overrides: Partial<HumanDecisionInput> = {}): HumanDecisionInput {
  return {
    decisionId: 'decision-001',
    action: {
      target: 'buffer:queue',
      effect: 'publish',
      scope: 'social-media/manager',
      params: { channel: 'linkedin', at: '2026-08-09T09:00:00.000Z' },
    },
    actionSummary: 'Publish the approved LinkedIn post tomorrow morning.',
    requestedDecision: 'approval',
    answer: 'approved',
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    decidedAt: '2026-08-08T10:05:00.000Z',
    hostProvenance: { host: 'codex', surface: 'chat' },
    relatedRunId: 'run-2026-08-08-001',
    ...overrides,
  } as HumanDecisionInput;
}

function rejects(fn: () => unknown, code = 'BRAIN_EVIDENCE_INPUT_INVALID'): void {
  assert.throws(fn, (error: unknown) => error instanceof RosterError && error.code === code);
}

test('evidence contracts bound every durable field and close every vocabulary', () => {
  assert.deepEqual([...EVIDENCE_OUTCOMES], ['succeeded', 'failed', 'partial', 'aborted']);
  for (const forbidden of ['pending', 'running', 'in-progress', 'awaiting', 'queued']) {
    assert.equal((EVIDENCE_OUTCOMES as readonly string[]).includes(forbidden), false);
    rejects(() => normalizeCompletedRun(runInput({ outcome: forbidden as never })));
  }

  rejects(() => normalizeCompletedRun(runInput({ trust: 'legacy-unverified' as never })));
  rejects(() => normalizeCompletedRun(runInput({ trust: 'brain-structured' as never })));
  rejects(() => normalizeCompletedRun(runInput({ privacy: 'confidential' as never })));
  rejects(() => normalizeCompletedRun(runInput({
    actor: { actorId: 'anonymous', assurance: 'caller-asserted' } as never,
  })));
  rejects(() => normalizeCompletedRun(runInput({ runId: '' })));
  rejects(() => normalizeCompletedRun(runInput({ runId: 'run id with spaces' })));
  rejects(() => normalizeCompletedRun(runInput({ functionId: 'Social_Media' })));
  rejects(() => normalizeCompletedRun(runInput({ requestHash: 'sha1:deadbeef' })));
  rejects(() => normalizeCompletedRun(runInput({ startedAt: 'yesterday' })));
  rejects(() => normalizeCompletedRun(runInput({
    startedAt: '2026-08-08T10:05:00.000Z',
    completedAt: '2026-08-08T10:00:00.000Z',
  })));
  rejects(() => normalizeCompletedRun(runInput({ requestSummary: 'x'.repeat(4097) })));
  rejects(() => normalizeCompletedRun(runInput({
    sources: Array.from({ length: MAX_EVIDENCE_SOURCES + 1 }, () => ({
      kind: 'external' as const,
      locator: { provider: 'notion' },
    })),
  })));
  rejects(() => normalizeCompletedRun({ ...runInput(), extra: 1 } as never));

  rejects(() => normalizeRunArtifact(artifactInput({ byteLength: -1 })));
  rejects(() => normalizeRunArtifact(artifactInput({ byteLength: 1.5 })));
  rejects(() => normalizeRunArtifact(artifactInput({ sha256: 'sha256:' + 'c'.repeat(64) })));
  rejects(() => normalizeRunArtifact(artifactInput({
    pointer: { kind: 'brain-object', locator: {} } as never,
  })));

  // Shared normalizers answer in the evidence taxonomy, never the source one.
  rejects(() => normalizeCompletedRun(runInput({ provenance: 5 })));
  rejects(() => normalizeCompletedRun(runInput({ provenance: ['not', 'an', 'object'] })));
  rejects(() => normalizeCompletedRun(runInput({ actor: { assurance: 'host-attested' } as never })));
  rejects(() => normalizeCompletedRun(runInput({
    actor: { actorId: 'codex', assurance: 'host-attested', host: 'gemini', sessionId: 's' } as never,
  })));

  rejects(() => normalizeFeedback(feedbackInput({ signal: 'neutral' as never })));
  rejects(() => normalizeHumanDecision(decisionInput({ answer: 'maybe' as never })));
  rejects(() => normalizeHumanDecision(decisionInput({ requestedDecision: 'vote' as never })));
});

test('evidence contracts refuse credential-shaped text and control characters', () => {
  rejects(() => normalizeCompletedRun(runInput({
    requestSummary: 'use ghp_0123456789abcdefghijABCDEF to publish',
  })));
  rejects(() => normalizeFeedback(feedbackInput({
    summary: 'token xoxb-1234567890-abcdefghij leaked',
  })));
  rejects(() => normalizeHumanDecision(decisionInput({
    actionSummary: 'approve with sk-abcdefghijklmnopqrstuvwx',
  })));
  rejects(() => normalizeCompletedRun(runInput({
    provenance: { note: 'AKIAIOSFODNN7EXAMPLE' },
  })));
  rejects(() => normalizeCompletedRun(runInput({ requestSummary: 'line one\nline two' })));
});

test('evidence contracts refuse bare long hex in prose and JSON but keep typed digests', () => {
  // Free text and arbitrary JSON: a bare 32/40/64-hex blob is credential-shaped.
  rejects(() => normalizeCompletedRun(runInput({ requestSummary: `token ${'f'.repeat(64)} inline` })));
  rejects(() => normalizeCompletedRun(runInput({ requestSummary: `token ${'0'.repeat(32)} inline` })));
  rejects(() => normalizeCompletedRun(runInput({ requestSummary: `token ${'A'.repeat(40)} inline` })));
  rejects(() => normalizeCompletedRun(runInput({ provenance: { leaked: 'a'.repeat(64) } })));
  rejects(() => normalizeCompletedRun(runInput({ provenance: { nested: { deep: ['b'.repeat(48)] } } })));
  rejects(() => normalizeCompletedRun(runInput({
    sources: [{ kind: 'external', locator: { id: 'c'.repeat(32) } }],
  })));
  rejects(() => normalizeCompletedRun(runInput({
    tools: [{ toolUseId: 'social-publish', summary: `used ${'d'.repeat(64)}` }],
  })));
  rejects(() => normalizeFeedback(feedbackInput({ summary: `hash ${'e'.repeat(64)}` })));
  rejects(() => normalizeHumanDecision(decisionInput({ actionSummary: `digest ${'f'.repeat(64)}` })));
  rejects(() => normalizeHumanDecision(decisionInput({
    action: { target: 'a'.repeat(64), effect: 'publish', scope: 'social-media', params: {} },
  })));
  rejects(() => normalizeHumanDecision(decisionInput({
    action: { target: 'queue', effect: 'publish', scope: 'social-media', params: { key: 'a'.repeat(40) } },
  })));

  // Typed digest fields carry exactly that shape and are validated by their own
  // regex, so they are never routed through the credential scan.
  const run = normalizeCompletedRun(runInput({ requestHash: `sha256:${'a'.repeat(64)}` }));
  assert.equal((JSON.parse(run.canonical) as Record<string, unknown>).request_hash, `sha256:${'a'.repeat(64)}`);
  const cited = normalizeCompletedRun(runInput({
    sources: [{ kind: 'brain-source-version', sourceVersionId: `sha256:${'b'.repeat(64)}` }],
  }));
  assert.equal(
    ((JSON.parse(cited.canonical) as { sources: { source_version_id: string }[] }).sources[0]!).source_version_id,
    `sha256:${'b'.repeat(64)}`,
  );
  const artifact = normalizeRunArtifact(artifactInput({ sha256: 'c'.repeat(64) }));
  assert.equal((JSON.parse(artifact.canonical) as Record<string, unknown>).sha256, 'c'.repeat(64));
  const feedback = normalizeFeedback(feedbackInput());
  assert.match((JSON.parse(feedback.canonical) as { summary_hash: string }).summary_hash, /^sha256:[a-f0-9]{64}$/u);
  const decision = normalizeHumanDecision(decisionInput({
    actor: {
      actorId: 'operator',
      assurance: 'human-confirmed',
      decisionId: 'decision-001',
      actionDigest: `sha256:${'a'.repeat(64)}`,
    },
  }));
  assert.match((JSON.parse(decision.canonical) as { action_digest: string }).action_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    (JSON.parse(decision.canonical) as { actor: { actionDigest: string } }).actor.actionDigest,
    `sha256:${'a'.repeat(64)}`,
  );
});

test('evidence contracts derive stable canonical text and recomputable digests', () => {
  const first = normalizeCompletedRun(runInput());
  const second = normalizeCompletedRun(runInput());
  assert.equal(first.canonical, second.canonical);
  assert.equal(first.canonical, canonicalSourceJson(JSON.parse(first.canonical)));
  assert.equal(first.canonical.includes('"workspace_id"'), false);
  assert.equal(first.canonical.includes('"recorded_at"'), false);
  assert.equal(JSON.parse(first.canonical).roster_version.length > 0, true);

  // Input key ORDER never changes the canonical bytes.
  const shuffled = Object.fromEntries(
    Object.entries(runInput()).sort(([left], [right]) => (left < right ? 1 : -1)),
  ) as CompletedRunInput;
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(runInput()));
  assert.equal(normalizeCompletedRun(shuffled).canonical, first.canonical);

  const fingerprint = evidenceRecordFingerprint('completed-run', first.canonical);
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    fingerprint,
    `sha256:${createHash('sha256')
      .update(canonicalSourceJson({
        domain: 'roster.brain.evidence.completed-run.v1',
        value: first.canonical,
      }))
      .digest('hex')}`,
  );
  assert.notEqual(fingerprint, evidenceRecordFingerprint('feedback', first.canonical));

  const feedback = normalizeFeedback(feedbackInput());
  const feedbackRecord = JSON.parse(feedback.canonical) as { summary: string; summary_hash: string };
  assert.equal(feedbackRecord.summary_hash, evidenceSummaryHash(feedbackRecord.summary));

  const decision = normalizeHumanDecision(decisionInput());
  const decisionRecord = JSON.parse(decision.canonical) as { action: unknown; action_digest: string };
  assert.equal(decisionRecord.action_digest, evidenceActionDigest(decisionRecord.action as never));
  assert.notEqual(
    decisionRecord.action_digest,
    evidenceActionDigest({ ...(decisionRecord.action as object), effect: 'delete' } as never),
  );
});

test('evidence contracts keep decision linkage hierarchical and optional', () => {
  const unlinked = normalizeHumanDecision(decisionInput({
    relatedRunId: null,
    relatedArtifactId: null,
  }));
  const record = JSON.parse(unlinked.canonical) as Record<string, unknown>;
  assert.equal(record.related_run_id, null);
  assert.equal(record.related_artifact_id, null);

  rejects(() => normalizeHumanDecision(decisionInput({
    relatedRunId: null,
    relatedArtifactId: 'post-draft.md',
  })));

  const linked = normalizeHumanDecision(decisionInput({ relatedArtifactId: 'post-draft.md' }));
  assert.equal((JSON.parse(linked.canonical) as Record<string, unknown>).related_artifact_id, 'post-draft.md');
});

test('evidence contracts hold no execution state', () => {
  const canonical = normalizeCompletedRun(runInput()).canonical;
  for (const forbidden of [
    'current_step',
    'next_action',
    'transition',
    'cursor',
    'pending',
    'awaiting',
    'approval_receipt',
    'lease',
  ]) {
    assert.equal(canonical.includes(`"${forbidden}"`), false, forbidden);
  }
});

test('evidence lock frames are length-prefixed and injective', () => {
  assert.equal(evidenceLockFrame('d', []), 'd');
  assert.equal(evidenceLockFrame('d', ['ab']), 'd:2:ab');
  assert.equal(evidenceLockFrame('d', ['ab', 'c']), 'd:2:ab:1:c');
  assert.equal(evidenceLockFrame('d', ['', '']), 'd:0::0:');
  // Without length prefixes these two component vectors would collide.
  assert.notEqual(evidenceLockFrame('d', ['a:1:b']), evidenceLockFrame('d', ['a', 'b']));
  assert.notEqual(
    evidenceLockFrame(EVIDENCE_LOCK_DOMAINS.run, ['run-1']),
    evidenceLockFrame(EVIDENCE_LOCK_DOMAINS.feedback, ['run-1']),
  );
});

test('promotion identity derives from the stable identity only', () => {
  const base = {
    evidenceKind: 'completed-run' as const,
    runId: 'run-2026-08-08-001',
    artifactId: null,
    feedbackId: null,
    decisionId: null,
  };
  const versionA = `sha256:${'1'.repeat(64)}`;
  const versionB = `sha256:${'2'.repeat(64)}`;
  const idA = derivePromotionId({ ...base, promotedSourceVersionId: versionA });
  assert.equal(idA, derivePromotionId({ ...base, promotedSourceVersionId: versionA }));
  assert.notEqual(idA, derivePromotionId({ ...base, promotedSourceVersionId: versionB }));
  assert.notEqual(idA, derivePromotionId({
    ...base,
    evidenceKind: 'feedback',
    runId: null,
    feedbackId: 'run-2026-08-08-001',
    promotedSourceVersionId: versionA,
  }));

  // The logical source key excludes the version: re-promoting one evidence item
  // adds another VERSION of the same logical source.
  const key = derivePromotionSourceKey(base);
  assert.match(key, /^evidence-promotion:[a-f0-9]{64}$/u);
  assert.equal(key, derivePromotionSourceKey({ ...base }));
  assert.notEqual(key, derivePromotionSourceKey({ ...base, runId: 'run-2026-08-08-002' }));
});
