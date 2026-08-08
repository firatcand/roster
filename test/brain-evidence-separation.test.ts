import assert from 'node:assert/strict';
import test from 'node:test';
import { RosterError } from '../src/lib/errors.ts';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { ingestBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import {
  derivePromotionId,
  derivePromotionSourceKey,
} from '../src/lib/brain/evidence-identity.ts';
import {
  promoteEvidence,
  readPromotions,
  recordCompletedRun,
  recordFeedback,
  recordHumanDecision,
  recordRunArtifact,
} from '../src/lib/brain/evidence-store.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'evidence-separation-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const ACTOR = {
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'evidence-separation',
} as const;

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

type Counts = { sources: string; versions: string; objects: string; documents: string; mounts: string };

async function semanticCounts(pool: { query: (text: string) => Promise<{ rows: Counts[] }> }): Promise<Counts> {
  const result = await pool.query(
    `SELECT (SELECT count(*)::text FROM brain.logical_sources) AS sources,
            (SELECT count(*)::text FROM brain.source_versions) AS versions,
            (SELECT count(*)::text FROM brain.source_objects) AS objects,
            (SELECT count(*)::text FROM brain.documents) AS documents,
            (SELECT count(*)::text FROM brain.mounts) AS mounts`,
  );
  return result.rows[0]!;
}

test('brain evidence stays out of the semantic surface until it is promoted', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    const seed = await ingestBrainSource(
      { pool: fixture.admin, objectStore: fixture.store },
      {
        requestKey: 'separation-seed',
        source: { kind: 'inline-text', stableKey: 'separation-seed' },
        bytes: Buffer.from('seed knowledge', 'utf8'),
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        mediaType: 'text/plain',
        provenance: { fixture: 'brain-evidence-separation' },
      },
    );

    await t.test('recording evidence produces no source, extraction, or object side effects', async () => {
      const before = await semanticCounts(fixture.admin);
      const objectCalls = fixture.store.createCalls.length;

      await recordCompletedRun(fixture.runtime, {
        runId: 'run-separation',
        functionId: 'social-media',
        agentId: 'manager',
        planId: null,
        host: 'codex',
        hostVersion: '0.51.0',
        requestSummary: 'record with no semantic side effects',
        requestHash: `sha256:${'a'.repeat(64)}`,
        startedAt: '2026-08-08T10:00:00.000Z',
        completedAt: '2026-08-08T10:01:00.000Z',
        outcome: 'succeeded',
        privacy: 'internal',
        trust: 'host-asserted',
        sources: [{ kind: 'brain-source-version', sourceVersionId: seed.sourceVersionId }],
        tools: [{ toolUseId: 'social-publish' }],
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-separation' },
      });
      await recordRunArtifact(fixture.runtime, {
        runId: 'run-separation',
        artifactId: 'draft.md',
        sha256: 'c'.repeat(64),
        byteLength: 64,
        mediaType: 'text/markdown',
        pointer: { kind: 'external', locator: { provider: 'notion' } },
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-separation' },
      });
      await recordFeedback(fixture.runtime, {
        feedbackId: 'feedback-separation',
        runId: 'run-separation',
        signal: 'positive',
        summary: 'evidence recording touched nothing semantic',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-separation' },
      });
      await recordHumanDecision(fixture.runtime, {
        decisionId: 'decision-separation',
        action: { target: 'buffer:queue', effect: 'publish', scope: 'social-media', params: {} },
        actionSummary: 'publish the draft',
        requestedDecision: 'approval',
        answer: 'approved',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        decidedAt: '2026-08-08T10:02:00.000Z',
        hostProvenance: { host: 'codex' },
        relatedRunId: 'run-separation',
      });

      assert.deepEqual(await semanticCounts(fixture.admin), before);
      assert.equal(fixture.store.createCalls.length, objectCalls);
      const promotions = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_promotions`,
      );
      assert.equal(promotions.rows[0]!.n, '0');
    });

    await t.test('promotion creates one cited source version and one lineage row', async () => {
      const request = {
        evidenceKind: 'feedback' as const,
        feedbackId: 'feedback-separation',
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal' as const,
        trust: 'brain-structured' as const,
        actor: ACTOR,
        provenance: { reason: 'recurring positive signal' },
      };
      const before = await semanticCounts(fixture.admin);
      const promoted = await promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, request);
      assert.equal(promoted.status, 'created');
      assert.match(promoted.promotionId, /^sha256:[a-f0-9]{64}$/u);

      const after = await semanticCounts(fixture.admin);
      assert.equal(Number(after.versions), Number(before.versions) + 1);
      assert.equal(Number(after.sources), Number(before.sources) + 1);

      const version = await fixture.admin.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM brain.source_versions WHERE source_version_id = $1`,
        [promoted.sourceVersionId],
      );
      assert.deepEqual(version.rows[0]!.provenance.promoted_from, {
        evidence_kind: 'feedback',
        run_id: null,
        artifact_id: null,
        feedback_id: 'feedback-separation',
        decision_id: null,
      });

      const lineage = await readPromotions(fixture.runtime, {
        evidenceKind: 'feedback',
        feedbackId: 'feedback-separation',
      });
      assert.equal(lineage.length, 1);
      assert.equal(lineage[0]!.promotionId, promoted.promotionId);
      assert.equal(lineage[0]!.promotedSourceVersionId, promoted.sourceVersionId);

      // Byte-stable re-promotion: identical request, identical projection bytes.
      const replay = await promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, request);
      assert.equal(replay.status, 'existing');
      assert.equal(replay.promotionId, promoted.promotionId);
      assert.equal(replay.sourceVersionId, promoted.sourceVersionId);
      assert.deepEqual(await semanticCounts(fixture.admin), after);
      assert.equal((await readPromotions(fixture.runtime, {
        evidenceKind: 'feedback',
        feedbackId: 'feedback-separation',
      })).length, 1);
    });

    await t.test('allows several promoted source versions per evidence item, ordered', async () => {
      const narrower = await promoteEvidence(
        { pool: fixture.admin, objectStore: fixture.store },
        {
          evidenceKind: 'feedback',
          feedbackId: 'feedback-separation',
          labels: [{ workspace: WORKSPACE_ID }, { workspace: WORKSPACE_ID, function: 'social-media' }],
          privacy: 'internal',
          trust: 'brain-structured',
          actor: ACTOR,
          provenance: { reason: 'recurring positive signal' },
        },
      );
      assert.equal(narrower.status, 'created');
      const lineage = await readPromotions(fixture.runtime, {
        evidenceKind: 'feedback',
        feedbackId: 'feedback-separation',
      });
      assert.equal(lineage.length, 2);
      assert.equal(new Set(lineage.map((row) => row.promotedSourceVersionId)).size, 2);
      const ordering = lineage.map((row) => `${row.recordedAt}|${row.promotionId}`);
      assert.deepEqual(ordering, [...ordering].sort());
    });

    await t.test('converges after a crash between the ingest and lineage effects', async () => {
      const request = {
        evidenceKind: 'completed-run' as const,
        runId: 'run-separation',
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal' as const,
        trust: 'brain-structured' as const,
        actor: ACTOR,
        provenance: { reason: 'exemplary run' },
      };
      await assert.rejects(
        promoteEvidence(
          {
            pool: fixture.admin,
            objectStore: fixture.store,
            afterIngest: async () => {
              throw new Error('promotion process died before the lineage insert');
            },
          },
          request,
        ),
        /died before the lineage insert/u,
      );

      const stableKey = derivePromotionSourceKey({
        evidenceKind: 'completed-run',
        runId: 'run-separation',
        artifactId: null,
        feedbackId: null,
        decisionId: null,
      });
      const orphaned = await fixture.admin.query<{ versions: string; lineage: string }>(
        `SELECT (SELECT count(*)::text
                   FROM brain.source_versions version
                   JOIN brain.logical_sources source ON source.source_id = version.source_id
                  WHERE source.origin->>'stableKey' = $1) AS versions,
                (SELECT count(*)::text FROM brain_evidence.evidence_promotions
                  WHERE evidence_kind = 'completed-run') AS lineage`,
        [stableKey],
      );
      assert.deepEqual(orphaned.rows[0], { versions: '1', lineage: '0' });

      const recovered = await promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, request);
      assert.equal(recovered.status, 'created');
      const converged = await fixture.admin.query<{ versions: string; lineage: string }>(
        `SELECT (SELECT count(*)::text
                   FROM brain.source_versions version
                   JOIN brain.logical_sources source ON source.source_id = version.source_id
                  WHERE source.origin->>'stableKey' = $1) AS versions,
                (SELECT count(*)::text FROM brain_evidence.evidence_promotions
                  WHERE evidence_kind = 'completed-run') AS lineage`,
        [stableKey],
      );
      assert.deepEqual(converged.rows[0], { versions: '1', lineage: '1' });
      assert.deepEqual(
        await promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, request),
        { ...recovered, status: 'existing' },
      );
    });

    await t.test('refuses a same-identity promotion whose lineage content disagrees', async () => {
      const request = {
        evidenceKind: 'human-decision' as const,
        decisionId: 'decision-separation',
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal' as const,
        trust: 'brain-structured' as const,
        actor: ACTOR,
        provenance: { reason: 'approved exemplar' },
      };
      const subject = {
        evidenceKind: 'human-decision' as const,
        runId: null,
        artifactId: null,
        feedbackId: null,
        decisionId: 'decision-separation',
      };
      await assert.rejects(
        promoteEvidence(
          {
            pool: fixture.admin,
            objectStore: fixture.store,
            afterIngest: async () => {
              throw new Error('stop before lineage');
            },
          },
          request,
        ),
        /stop before lineage/u,
      );
      const version = await fixture.admin.query<{ source_version_id: string }>(
        `SELECT version.source_version_id
           FROM brain.source_versions version
           JOIN brain.logical_sources source ON source.source_id = version.source_id
          WHERE source.origin->>'stableKey' = $1`,
        [derivePromotionSourceKey(subject)],
      );
      const promotionId = derivePromotionId({
        ...subject,
        promotedSourceVersionId: version.rows[0]!.source_version_id,
      });
      await fixture.admin.query(
        `INSERT INTO brain_evidence.evidence_promotions (
           promotion_id, record_canonical, workspace_id, evidence_kind, run_id, artifact_id,
           feedback_id, decision_id, promoted_source_version_id, actor_assurance,
           assurance_evidence, provenance
         ) VALUES ($1, $2, $3, 'human-decision', NULL, NULL, NULL, 'decision-separation', $4,
                   'host-attested', '{}'::jsonb, '{"planted":true}'::jsonb)`,
        [
          promotionId,
          '{"kind":"promotion","planted":true}',
          WORKSPACE_ID,
          version.rows[0]!.source_version_id,
        ],
      );

      await assert.rejects(
        promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, request),
        hasCode('BRAIN_EVIDENCE_IDEMPOTENCY_CONFLICT'),
      );
      const untouched = await fixture.admin.query<{ canonical: string; n: string }>(
        `SELECT record_canonical AS canonical,
                (SELECT count(*)::text FROM brain_evidence.evidence_promotions
                  WHERE evidence_kind = 'human-decision') AS n
           FROM brain_evidence.evidence_promotions WHERE promotion_id = $1`,
        [promotionId],
      );
      assert.equal(untouched.rows[0]!.canonical, '{"kind":"promotion","planted":true}');
      assert.equal(untouched.rows[0]!.n, '1');
    });

    await t.test('refuses a missing evidence reference and denies the runtime role promotion', async () => {
      await assert.rejects(
        promoteEvidence({ pool: fixture.admin, objectStore: fixture.store }, {
          evidenceKind: 'feedback',
          feedbackId: 'feedback-does-not-exist',
          labels: [{ workspace: WORKSPACE_ID }],
          privacy: 'internal',
          trust: 'brain-structured',
          actor: ACTOR,
          provenance: {},
        }),
        hasCode('BRAIN_EVIDENCE_REF_NOT_FOUND'),
      );

      await assert.rejects(
        promoteEvidence({ pool: fixture.runtime, objectStore: fixture.store }, {
          evidenceKind: 'feedback',
          feedbackId: 'feedback-separation',
          labels: [{ workspace: WORKSPACE_ID }],
          privacy: 'internal',
          trust: 'brain-structured',
          actor: ACTOR,
          provenance: { reason: 'runtime attempt' },
        }),
        (error: unknown) => (error as { code?: unknown }).code === '42501',
      );
    });

    await t.test('keeps every semantic surface schema-qualified away from brain_evidence', async () => {
      const doctorPool = createBrainPool('admin', fixture.adminUrl);
      try {
        // Evidence never reaches the document/embedding surface: no document row
        // may cite a brain_evidence relation, and nothing was indexed at all.
        const leaked = await doctorPool.query<{ source_path: string }>(
          `SELECT source_path FROM brain.documents WHERE source_path LIKE '%brain_evidence%'`,
        );
        assert.deepEqual(leaked.rows, []);
        const indexed = await doctorPool.query<{ documents: string; mounts: string }>(
          `SELECT (SELECT count(*)::text FROM brain.documents) AS documents,
                  (SELECT count(*)::text FROM brain.mounts) AS mounts`,
        );
        assert.deepEqual(indexed.rows[0], { documents: '0', mounts: '0' });
      } finally {
        await doctorPool.end();
      }
    });
  } finally {
    await fixture.close();
  }
});
