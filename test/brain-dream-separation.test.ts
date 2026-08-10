import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { ingestBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import { recordCompletedRun, recordFeedback } from '../src/lib/brain/evidence-store.ts';
import { query as searchBrain } from '../src/lib/brain/search.ts';
import { countReindexTargets } from '../src/lib/brain/reindex.ts';
import { countEligible, resolveRetention, runGc } from '../src/lib/brain/gc.ts';
import { DEFAULT_DREAM_POLICY, canonicalizeDreamScope } from '../src/lib/brain/dream-contracts.ts';
import {
  advanceDreamWatermark,
  computeDreamReadiness,
  registerDreamPolicy,
} from '../src/lib/brain/dream-readiness.ts';
import { HAS_DB } from './brain-helpers.ts';
import {
  createEvidenceFixture,
  seedFeedbackInput,
  seedRunInput,
  SEED_ACTOR,
} from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'dream-separation-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };
const WORKSPACE = canonicalizeDreamScope('workspace');

const DREAM_RELATIONS = ['evidence_observations', 'dream_policies', 'dream_watermarks'] as const;

type SemanticCounts = {
  sources: string;
  versions: string;
  objects: string;
  documents: string;
  extractions: string;
  embedded: string;
};

async function semanticCounts(pool: {
  query: <T extends Record<string, unknown>>(text: string) => Promise<{ rows: T[] }>;
}): Promise<SemanticCounts> {
  return (await pool.query<SemanticCounts>(
    `SELECT (SELECT count(*)::text FROM brain.logical_sources) AS sources,
            (SELECT count(*)::text FROM brain.source_versions) AS versions,
            (SELECT count(*)::text FROM brain.source_objects) AS objects,
            (SELECT count(*)::text FROM brain.documents) AS documents,
            (SELECT count(*)::text FROM brain.source_extractions) AS extractions,
            (SELECT count(*)::text FROM brain.documents WHERE embedding IS NOT NULL) AS embedded`,
  )).rows[0]!;
}

test('the dream surface never touches the semantic surface', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await ingestBrainSource(
      { pool: fixture.admin, objectStore: fixture.store },
      {
        requestKey: 'dream-separation-seed',
        source: { kind: 'inline-text', stableKey: 'dream-separation-seed' },
        bytes: Buffer.from('the dreamer separation seed document', 'utf8'),
        labels: [{ workspace: WORKSPACE_ID }],
        privacy: 'internal',
        trust: 'host-asserted',
        actor: SEED_ACTOR,
        mediaType: 'text/plain',
        provenance: { fixture: 'brain-dream-separation' },
      },
    );
    await recordCompletedRun(fixture.runtime, seedRunInput('run-separation'));
    await recordFeedback(fixture.runtime, seedFeedbackInput('fb-separation', 'run-separation'));

    await t.test('dream status and both admin writers have zero semantic side effects', async () => {
      const before = await semanticCounts(fixture.admin);
      const objectCalls = fixture.store.createCalls.length;

      await computeDreamReadiness(fixture.runtime, WORKSPACE);
      await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.separation.v1',
        minCompletedRuns: 1,
        excludedAgentIds: [],
        activationAssurance: 'human-confirmed',
        registeredBy: 'owner',
      });
      const ready = await computeDreamReadiness(fixture.runtime, WORKSPACE);
      await advanceDreamWatermark(fixture.admin, {
        scopeKey: 'workspace',
        cursorOrdinal: ready.frontier.ordinal,
        policyVersion: 'acme.separation.v1',
        reason: 'promotion',
        consumedCompletedRuns: ready.evidence.completed_runs,
        consumedFeedbackRecords: ready.evidence.feedback_records,
        actorAssurance: 'human-confirmed',
      });
      await computeDreamReadiness(fixture.runtime, WORKSPACE);

      assert.deepEqual(await semanticCounts(fixture.admin), before);
      // The object store is never reached: no dream path takes one.
      assert.equal(fixture.store.createCalls.length, objectCalls);
    });

    await t.test('search, reindex, and gc return nothing from the dream relations', async () => {
      const client = await fixture.admin.connect();
      try {
        for (const text of ['dream', 'watermark', 'observation', 'promotion', 'policy']) {
          const hits = await searchBrain(client, text, { limit: 20 });
          for (const hit of hits) {
            const serialized = JSON.stringify(hit);
            for (const relation of DREAM_RELATIONS) {
              assert.equal(serialized.includes(relation), false, `${text} -> ${relation}`);
            }
          }
        }
        // Every reindex/gc target is schema-qualified to `brain`, so the
        // brain_evidence relations 014 adds are unreachable by construction.
        assert.equal(await countReindexTargets(client, 'test-model'), 0);
        const retention = await resolveRetention(client);
        const eligible = await countEligible(client, retention.interval);
        assert.deepEqual(eligible, { facts: 0, documents: 0 });
      } finally {
        client.release();
      }

      const before = await fixture.admin.query<{ digest: string }>(
        `SELECT (SELECT count(*)::text FROM brain_evidence.evidence_observations)
             || '#' || (SELECT count(*)::text FROM brain_evidence.dream_policies)
             || '#' || (SELECT count(*)::text FROM brain_evidence.dream_watermarks) AS digest`,
      );
      const gcPool = createBrainPool('admin', fixture.adminUrl);
      try {
        const deleted = await runGc(gcPool, { interval: '1 days' });
        assert.deepEqual(deleted, { facts: 0, documents: 0 });
      } finally {
        await gcPool.end();
      }
      const after = await fixture.admin.query<{ digest: string }>(
        `SELECT (SELECT count(*)::text FROM brain_evidence.evidence_observations)
             || '#' || (SELECT count(*)::text FROM brain_evidence.dream_policies)
             || '#' || (SELECT count(*)::text FROM brain_evidence.dream_watermarks) AS digest`,
      );
      assert.equal(after.rows[0]!.digest, before.rows[0]!.digest);
    });
  } finally {
    await fixture.close();
  }
});
