import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { RosterError } from '../src/lib/errors.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { canonicalSourceJson } from '../src/lib/brain/source-contracts.ts';
import { ingestBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import { createVerifiedBrainPool, deriveBrainWorkspaceAuthority } from '../src/lib/brain/workspace-authority.ts';
import {
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
  evidenceLockFrame,
  evidenceRecordFingerprint,
} from '../src/lib/brain/evidence-identity.ts';
import {
  readCompletedRun,
  readFeedback,
  readHumanDecision,
  recordCompletedRun,
  recordFeedback,
  recordHumanDecision,
  recordRunArtifact,
  verifyEvidenceRecord,
} from '../src/lib/brain/evidence-store.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';
import { brainConfig, createEvidenceFixture } from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'evidence-record-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const ACTOR = {
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'evidence-record',
} as const;

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

function sqlState(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

function runInput(runId: string, sourceVersionId: string, overrides: Partial<CompletedRunInput> = {}): CompletedRunInput {
  return {
    runId,
    functionId: 'social-media',
    agentId: 'manager',
    planId: 'discovery',
    host: 'codex',
    hostVersion: '0.51.0',
    requestSummary: 'Draft the weekly launch post.',
    requestHash: `sha256:${'a'.repeat(64)}`,
    startedAt: '2026-08-08T10:00:00.000Z',
    completedAt: '2026-08-08T10:04:30.000Z',
    outcome: 'succeeded',
    privacy: 'internal',
    trust: 'host-asserted',
    sources: [
      { kind: 'brain-source-version', sourceVersionId, summary: 'brand guide' },
      { kind: 'external', locator: { provider: 'notion', page: 'launch-brief' } },
    ],
    tools: [
      { toolUseId: 'social-publish', skillRef: 'vendor:buffer', summary: 'scheduled one post' },
      { toolUseId: 'social-research' },
    ],
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-record' },
    ...overrides,
  } as CompletedRunInput;
}

function artifactInput(runId: string, artifactId: string, overrides: Partial<RunArtifactInput> = {}): RunArtifactInput {
  return {
    runId,
    artifactId,
    sha256: 'c'.repeat(64),
    byteLength: 2048,
    mediaType: 'text/markdown',
    pointer: { kind: 'external', locator: { provider: 'notion', block: 'abc123' } },
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-record' },
    ...overrides,
  } as RunArtifactInput;
}

function feedbackInput(feedbackId: string, runId: string, overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    feedbackId,
    runId,
    signal: 'positive',
    summary: 'The draft matched the brand voice.',
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    provenance: { fixture: 'brain-evidence-record' },
    ...overrides,
  } as FeedbackInput;
}

function decisionInput(decisionId: string, overrides: Partial<HumanDecisionInput> = {}): HumanDecisionInput {
  return {
    decisionId,
    action: {
      target: 'buffer:queue',
      effect: 'publish',
      scope: 'social-media/manager',
      params: { channel: 'linkedin' },
    },
    actionSummary: 'Publish the approved LinkedIn post.',
    requestedDecision: 'approval',
    answer: 'approved',
    privacy: 'internal',
    trust: 'host-asserted',
    actor: ACTOR,
    decidedAt: '2026-08-08T10:05:00.000Z',
    hostProvenance: { host: 'codex', surface: 'chat' },
    ...overrides,
  } as HumanDecisionInput;
}

function mutateCanonical(canonical: string, mutate: (record: Record<string, unknown>) => void): string {
  const record = JSON.parse(canonical) as Record<string, unknown>;
  mutate(record);
  return canonicalSourceJson(record as never);
}

test('brain evidence brokers record portable work evidence idempotently', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    const seed = await ingestBrainSource(
      { pool: fixture.admin, objectStore: fixture.store },
      {
        requestKey: 'evidence-record-seed',
        source: { kind: 'inline-text', stableKey: 'brand-guide' },
        bytes: Buffer.from('the brand voice guide', 'utf8'),
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        mediaType: 'text/plain',
        provenance: { fixture: 'brain-evidence-record' },
      },
    );
    const sourceVersionId = seed.sourceVersionId;

    await t.test('creates, replays, and refuses a conflicting run under one identity', async () => {
      const input = runInput('run-idempotent', sourceVersionId);
      const created = await recordCompletedRun(fixture.runtime, input);
      assert.equal(created.status, 'created');
      assert.equal(created.id, 'run-idempotent');
      assert.match(created.recordFingerprint, /^sha256:[a-f0-9]{64}$/u);

      const replay = await recordCompletedRun(fixture.runtime, input);
      assert.deepEqual(replay, { ...created, status: 'existing' });

      const before = await fixture.admin.query<{ snapshot: string }>(
        `SELECT (
           coalesce((SELECT string_agg(record_canonical, '|' ORDER BY run_id) FROM brain_evidence.completed_runs), '')
           || '#' || coalesce((SELECT count(*)::text FROM brain_evidence.run_sources), '')
           || '#' || coalesce((SELECT count(*)::text FROM brain_evidence.run_tools), '')
         ) AS snapshot`,
      );
      await assert.rejects(
        recordCompletedRun(fixture.runtime, runInput('run-idempotent', sourceVersionId, {
          requestSummary: 'A different request under the same run id.',
        })),
        hasCode('BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT'),
      );
      const after = await fixture.admin.query<{ snapshot: string }>(
        `SELECT (
           coalesce((SELECT string_agg(record_canonical, '|' ORDER BY run_id) FROM brain_evidence.completed_runs), '')
           || '#' || coalesce((SELECT count(*)::text FROM brain_evidence.run_sources), '')
           || '#' || coalesce((SELECT count(*)::text FROM brain_evidence.run_tools), '')
         ) AS snapshot`,
      );
      assert.equal(after.rows[0]!.snapshot, before.rows[0]!.snapshot);
    });

    await t.test('derives workspace identity and recording time server-side', async () => {
      const input = runInput('run-derived', sourceVersionId);
      const normalized = normalizeCompletedRun(input);
      assert.equal(normalized.canonical.includes('workspace_id'), false);
      assert.equal(normalized.canonical.includes('recorded_at'), false);
      await recordCompletedRun(fixture.runtime, input);
      const row = await fixture.admin.query<{ workspace_id: string; fresh: boolean; canonical: string }>(
        `SELECT workspace_id, recorded_at > now() - interval '5 minutes' AS fresh, record_canonical AS canonical
           FROM brain_evidence.completed_runs WHERE run_id = $1`,
        ['run-derived'],
      );
      assert.equal(row.rows[0]!.workspace_id, WORKSPACE_ID);
      assert.equal(row.rows[0]!.fresh, true);
      assert.equal(row.rows[0]!.canonical, normalized.canonical);
    });

    await t.test('aggregates citations, tool uses, artifacts, and feedback links', async () => {
      const runId = 'run-aggregate';
      await recordCompletedRun(fixture.runtime, runInput(runId, sourceVersionId));
      await recordRunArtifact(fixture.runtime, artifactInput(runId, 'post-draft.md'));
      await recordRunArtifact(fixture.runtime, artifactInput(runId, 'analytics.json', {
        mediaType: 'application/json',
        sha256: 'd'.repeat(64),
      }));
      await recordFeedback(fixture.runtime, feedbackInput('feedback-aggregate', runId));

      const envelope = await readCompletedRun(fixture.runtime, runId);
      assert.notEqual(envelope, null);
      assert.equal(envelope!.workspaceId, WORKSPACE_ID);
      assert.equal(envelope!.rosterVersion.length > 0, true);
      assert.deepEqual(envelope!.sources.map((entry) => [entry.ordinal, entry.sourceKind]), [
        [0, 'brain-source-version'],
        [1, 'external'],
      ]);
      assert.equal(envelope!.sources[0]!.sourceVersionId, sourceVersionId);
      assert.deepEqual(envelope!.sources[1]!.externalLocator, { provider: 'notion', page: 'launch-brief' });
      assert.deepEqual(envelope!.tools.map((entry) => [entry.ordinal, entry.toolUseId, entry.skillRef]), [
        [0, 'social-publish', 'vendor:buffer'],
        [1, 'social-research', null],
      ]);
      assert.deepEqual(envelope!.artifacts.map((entry) => entry.artifactId), ['analytics.json', 'post-draft.md']);
      assert.deepEqual([...envelope!.feedbackIds], ['feedback-aggregate']);
      assert.equal(
        envelope!.recordFingerprint,
        evidenceRecordFingerprint('completed-run', envelope!.recordCanonical),
      );
      assert.equal(await readCompletedRun(fixture.runtime, 'run-missing'), null);
    });

    await t.test('verifies every record kind against its stored canonical text', async () => {
      const runId = 'run-verify';
      await recordCompletedRun(fixture.runtime, runInput(runId, sourceVersionId));
      await recordRunArtifact(fixture.runtime, artifactInput(runId, 'verify.md'));
      await recordFeedback(fixture.runtime, feedbackInput('feedback-verify', runId));
      await recordHumanDecision(fixture.runtime, decisionInput('decision-verify', {
        relatedRunId: runId,
        relatedArtifactId: 'verify.md',
      }));

      const run = (await readCompletedRun(fixture.runtime, runId))!;
      assert.deepEqual(verifyEvidenceRecord('completed-run', run).findings, []);
      assert.equal(verifyEvidenceRecord('completed-run', run).verified, true);
      assert.equal(verifyEvidenceRecord('run-artifact', run.artifacts[0]!).verified, true);
      const feedback = (await readFeedback(fixture.runtime, 'feedback-verify'))!;
      assert.equal(verifyEvidenceRecord('feedback', feedback).verified, true);
      const decision = (await readHumanDecision(fixture.runtime, 'decision-verify'))!;
      assert.equal(verifyEvidenceRecord('human-decision', decision).verified, true);
      assert.equal(decision.relatedArtifactId, 'verify.md');
    });

    await t.test('detects a forged embedded digest that reached the broker directly', async () => {
      const honest = normalizeHumanDecision(decisionInput('decision-forged'));
      const forged = mutateCanonical(honest.canonical, (record) => {
        record.decision_id = 'decision-forged';
        record.action_digest = `sha256:${'e'.repeat(64)}`;
      });
      await fixture.runtime.query('SELECT status, id FROM brain_evidence.record_human_decision($1)', [forged]);
      const stored = (await readHumanDecision(fixture.runtime, 'decision-forged'))!;
      const verdict = verifyEvidenceRecord('human-decision', stored);
      assert.equal(verdict.verified, false);
      assert.equal(
        verdict.findings.includes('action_digest is not the digest of the recorded action'),
        true,
        verdict.findings.join('; '),
      );

      // The honest record under the same identity conflicts loudly instead of
      // silently colliding with the forged one.
      await assert.rejects(
        recordHumanDecision(fixture.runtime, decisionInput('decision-forged')),
        hasCode('BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT'),
      );

      const summaryForged = mutateCanonical(
        normalizeFeedback(feedbackInput('feedback-forged', 'run-verify')).canonical,
        (record) => {
          record.summary_hash = `sha256:${'f'.repeat(64)}`;
        },
      );
      await fixture.runtime.query('SELECT status, id FROM brain_evidence.record_feedback($1)', [summaryForged]);
      const storedFeedback = (await readFeedback(fixture.runtime, 'feedback-forged'))!;
      assert.equal(verifyEvidenceRecord('feedback', storedFeedback).verified, false);
    });

    await t.test('maps every hostile direct broker call to a stable error code', async () => {
      const valid = normalizeCompletedRun(runInput('run-hostile', sourceVersionId)).canonical;

      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', ['not json']),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', ['[1,2,3]']),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.surprise = 'extra key';
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            delete record.outcome;
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.outcome = 'in-progress';
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.trust_class = 'legacy-unverified';
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.actor = { actorId: 'anon', assurance: 'caller-asserted' };
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.sources = Array.from({ length: 65 }, () => ({
              kind: 'external',
              source_version_id: null,
              locator: { provider: 'notion' },
              summary: null,
            }));
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.completed_at = '2026-08-08T09:00:00.000Z';
          }),
        ]),
        sqlState('RBE01'),
      );
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(valid, (record) => {
            record.run_id = 'run-hostile-fk';
            record.sources = [{
              kind: 'brain-source-version',
              source_version_id: `sha256:${'9'.repeat(64)}`,
              locator: null,
              summary: null,
            }];
          }),
        ]),
        sqlState('RBE03'),
      );
      await assert.rejects(
        recordFeedback(fixture.runtime, feedbackInput('feedback-orphan', 'run-does-not-exist')),
        hasCode('BRAIN_EVIDENCE_REF_NOT_FOUND'),
      );
      await assert.rejects(
        recordRunArtifact(fixture.runtime, artifactInput('run-does-not-exist', 'orphan.md')),
        hasCode('BRAIN_EVIDENCE_REF_NOT_FOUND'),
      );

      const orphaned = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.completed_runs WHERE run_id LIKE 'run-hostile%'`,
      );
      assert.equal(orphaned.rows[0]!.n, '0');
    });

    await t.test('refuses every unbacked actor assurance on all four brokers', async () => {
      const runId = 'run-verify';
      const canonicals: [string, string][] = [
        ['record_completed_run', normalizeCompletedRun(runInput('run-actor', sourceVersionId)).canonical],
        ['record_run_artifact', normalizeRunArtifact(artifactInput(runId, 'actor.md')).canonical],
        ['record_feedback', normalizeFeedback(feedbackInput('feedback-actor', runId)).canonical],
        ['record_human_decision', normalizeHumanDecision(decisionInput('decision-actor')).canonical],
      ];
      const unbackedActors: [string, unknown][] = [
        ['assurance with no actor at all', { assurance: 'host-attested' }],
        ['host-attested without host or session', { actorId: 'codex-session', assurance: 'host-attested' }],
        ['host-attested naming an unsupported host', {
          actorId: 'codex-session', assurance: 'host-attested', host: 'gemini', sessionId: 'evidence-record',
        }],
        ['host-attested with an empty session', {
          actorId: 'codex-session', assurance: 'host-attested', host: 'codex', sessionId: '',
        }],
        ['host-attested with an extra field', {
          actorId: 'codex-session', assurance: 'host-attested', host: 'codex', sessionId: 's', extra: 1,
        }],
        ['human-confirmed without decision evidence', { actorId: 'operator', assurance: 'human-confirmed' }],
        ['human-confirmed with a malformed action digest', {
          actorId: 'operator', assurance: 'human-confirmed', decisionId: 'decision-1', actionDigest: 'nope',
        }],
        ['caller-asserted below the record trust floor', { actorId: 'anon', assurance: 'caller-asserted' }],
        ['system-derived below the record trust floor', {
          actorId: 'roster', assurance: 'system-derived', component: 'roster',
        }],
        ['an empty actor id', {
          actorId: '', assurance: 'host-attested', host: 'codex', sessionId: 'evidence-record',
        }],
        ['an actor that is not an object', 'host-attested'],
      ];
      for (const [broker, canonical] of canonicals) {
        for (const [label, actor] of unbackedActors) {
          await assert.rejects(
            fixture.runtime.query(`SELECT * FROM brain_evidence.${broker}($1)`, [
              mutateCanonical(canonical, (record) => {
                record.actor = actor;
              }),
            ]),
            sqlState('RBE01'),
            `${broker}: ${label}`,
          );
        }
      }
      const orphaned = await fixture.admin.query<{ n: string }>(
        `SELECT (SELECT count(*)::text FROM brain_evidence.completed_runs WHERE run_id = 'run-actor')
             || (SELECT count(*)::text FROM brain_evidence.run_artifacts WHERE artifact_id = 'actor.md')
             || (SELECT count(*)::text FROM brain_evidence.feedback WHERE feedback_id = 'feedback-actor')
             || (SELECT count(*)::text FROM brain_evidence.human_decisions WHERE decision_id = 'decision-actor')
             AS n`,
      );
      assert.equal(orphaned.rows[0]!.n, '0000');
    });

    await t.test('refuses credential-shaped text on every broker, digest fields excepted', async () => {
      const runId = 'run-verify';
      const hostile = [
        'f'.repeat(64),
        '0'.repeat(32),
        'ghp_0123456789abcdefghijABCDEF',
        'AKIAIOSFODNN7EXAMPLE',
        'xoxb-1234567890-abcdefghij',
        'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM',
      ];
      for (const secret of hostile) {
        await assert.rejects(
          fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
            mutateCanonical(normalizeCompletedRun(runInput('run-secret', sourceVersionId)).canonical, (record) => {
              record.request_summary = `leaked ${secret} here`;
            }),
          ]),
          sqlState('RBE01'),
          `run/request_summary: ${secret.slice(0, 8)}`,
        );
        await assert.rejects(
          fixture.runtime.query('SELECT * FROM brain_evidence.record_run_artifact($1)', [
            mutateCanonical(normalizeRunArtifact(artifactInput(runId, 'secret.md')).canonical, (record) => {
              record.external_locator = { provider: 'notion', token: secret };
            }),
          ]),
          sqlState('RBE01'),
          `artifact/external_locator: ${secret.slice(0, 8)}`,
        );
        await assert.rejects(
          fixture.runtime.query('SELECT * FROM brain_evidence.record_feedback($1)', [
            mutateCanonical(normalizeFeedback(feedbackInput('feedback-secret', runId)).canonical, (record) => {
              record.summary = `leaked ${secret} here`;
            }),
          ]),
          sqlState('RBE01'),
          `feedback/summary: ${secret.slice(0, 8)}`,
        );
        await assert.rejects(
          fixture.runtime.query('SELECT * FROM brain_evidence.record_human_decision($1)', [
            mutateCanonical(normalizeHumanDecision(decisionInput('decision-secret')).canonical, (record) => {
              record.action_summary = `leaked ${secret} here`;
            }),
          ]),
          sqlState('RBE01'),
          `decision/action_summary: ${secret.slice(0, 8)}`,
        );
      }
      await assert.rejects(
        fixture.runtime.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
          mutateCanonical(normalizeCompletedRun(runInput('run-secret', sourceVersionId)).canonical, (record) => {
            record.provenance = { note: 'a'.repeat(48) };
          }),
        ]),
        sqlState('RBE01'),
      );

      // The typed digest fields carry the same shape and must still be accepted.
      const accepted = await recordCompletedRun(fixture.runtime, runInput('run-digest-ok', sourceVersionId, {
        requestHash: `sha256:${'9'.repeat(64)}`,
      }));
      assert.equal(accepted.status, 'created');
      const leaked = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.completed_runs WHERE run_id = 'run-secret'`,
      );
      assert.equal(leaked.rows[0]!.n, '0');
    });

    await t.test('serializes concurrent racers on the length-prefixed advisory lock', async () => {
      const equivalent = runInput('run-race-equivalent', sourceVersionId);
      const results = await Promise.all([
        recordCompletedRun(fixture.runtime, equivalent),
        recordCompletedRun(fixture.runtime, equivalent),
        recordCompletedRun(fixture.runtime, equivalent),
      ]);
      assert.equal(results.filter((entry) => entry.status === 'created').length, 1);
      assert.equal(results.filter((entry) => entry.status === 'existing').length, 2);

      const divergent = await Promise.allSettled([
        recordCompletedRun(fixture.runtime, runInput('run-race-divergent', sourceVersionId, {
          requestSummary: 'first racer',
        })),
        recordCompletedRun(fixture.runtime, runInput('run-race-divergent', sourceVersionId, {
          requestSummary: 'second racer',
        })),
      ]);
      assert.equal(divergent.filter((entry) => entry.status === 'fulfilled').length, 1);
      const rejected = divergent.find((entry) => entry.status === 'rejected');
      assert.equal(hasCode('BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT')((rejected as PromiseRejectedResult).reason), true);

      const children = await fixture.admin.query<{ sources: string; tools: string }>(
        `SELECT (SELECT count(*)::text FROM brain_evidence.run_sources WHERE run_id = $1) AS sources,
                (SELECT count(*)::text FROM brain_evidence.run_tools WHERE run_id = $1) AS tools`,
        ['run-race-equivalent'],
      );
      assert.deepEqual(children.rows[0], { sources: '2', tools: '2' });
    });

    await t.test('reproduces the TypeScript lock frame byte-for-byte in SQL', async () => {
      const vectors: [string, string[]][] = [
        [EVIDENCE_LOCK_DOMAINS.run, ['run-2026-08-08-001']],
        [EVIDENCE_LOCK_DOMAINS.artifact, ['run-2026-08-08-001', 'post-draft.md']],
        [EVIDENCE_LOCK_DOMAINS.feedback, ['feedback-001']],
        [EVIDENCE_LOCK_DOMAINS.decision, ['decision-001']],
        [EVIDENCE_LOCK_DOMAINS.promotion, ['completed-run', 'run-1', '', '', '', `sha256:${'1'.repeat(64)}`]],
        [EVIDENCE_LOCK_DOMAINS.promotion, ['feedback', '', '', 'a:1:b', '', `sha256:${'2'.repeat(64)}`]],
        [EVIDENCE_LOCK_DOMAINS.run, []],
      ];
      for (const [domain, components] of vectors) {
        const rendered = await fixture.admin.query<{ frame: string; key: string }>(
          `SELECT brain_evidence.lock_frame($1, $2::text[]) AS frame,
                  brain_evidence.lock_key($1, $2::text[])::text AS key`,
          [domain, components],
        );
        assert.equal(rendered.rows[0]!.frame, evidenceLockFrame(domain, components));
        assert.match(rendered.rows[0]!.key, /^-?\d+$/u);
      }
      const collision = await fixture.admin.query<{ left: string; right: string }>(
        `SELECT brain_evidence.lock_frame($1, ARRAY['a:1:b']) AS left,
                brain_evidence.lock_frame($1, ARRAY['a', 'b']) AS right`,
        [EVIDENCE_LOCK_DOMAINS.run],
      );
      assert.notEqual(collision.rows[0]!.left, collision.rows[0]!.right);
    });

    await t.test('refuses a foreign workspace database before issuing evidence SQL', async () => {
      const foreign = createVerifiedBrainPool({
        connectionString: fixture.runtimeUrl,
        authority: deriveBrainWorkspaceAuthority('other-workspace', brainConfig('other-workspace')),
      });
      try {
        await assert.rejects(
          recordCompletedRun(foreign, runInput('run-foreign', sourceVersionId)),
          hasCode('BRAIN_WORKSPACE_MISMATCH'),
        );
      } finally {
        await foreign.end();
      }
      const absent = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.completed_runs WHERE run_id = 'run-foreign'`,
      );
      assert.equal(absent.rows[0]!.n, '0');
    });
  } finally {
    await fixture.close();
  }
});

test('brain evidence brokers refuse a database with no protected workspace identity', options, async () => {
  const fresh = await createFreshDb();
  const pool = new pg.Pool({ connectionString: fresh.url });
  try {
    const applied = await runMigrations(pool);
    assert.equal(applied.applied.includes('013_evidence_core.sql'), true);
    const identity = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_meta.workspace_identity`,
    );
    assert.equal(identity.rows[0]!.n, '0');

    // Migrated but never bootstrapped: workspace_id is broker-derived, so there
    // is nothing to derive it from and the broker must fail closed on RBE04
    // rather than inventing an identity or writing a NULL-workspace row.
    await assert.rejects(
      pool.query('SELECT * FROM brain_evidence.record_completed_run($1)', [
        normalizeCompletedRun(runInput('run-no-identity', `sha256:${'b'.repeat(64)}`, {
          sources: [{ kind: 'external', locator: { provider: 'notion' } }],
        })).canonical,
      ]),
      sqlState('RBE04'),
    );
    const written = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_evidence.completed_runs`,
    );
    assert.equal(written.rows[0]!.n, '0');
  } finally {
    await pool.end();
    await fresh.drop();
  }
});
