import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { runDoctor, APPROVED_EVIDENCE_EXECUTE_SIGNATURES } from '../src/lib/brain/doctor.ts';
import { registerDreamPolicy } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY } from '../src/lib/brain/dream-contracts.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture } from './support/brain-evidence-fixture.ts';
import {
  createCandidate,
  observationOrdinal,
  readiness,
  seedRuns,
} from './support/dream-lifecycle-fixture.ts';

const WORKSPACE_ID = 'dream-lifecycle-schema';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

const LIFECYCLE_TABLES = ['dream_candidates', 'dream_candidate_evidence', 'lesson_decisions'] as const;
const UNKNOWN_CANDIDATE = `sha256:${'f'.repeat(64)}`;

function sqlState(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

test('the 015 lifecycle schema is append-only, broker-written, and least-privileged', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await t.test('the ledger tables, the derived view, and the generated subject key exist', async () => {
      const tables = await fixture.admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'brain_evidence' ORDER BY tablename`,
      );
      for (const table of LIFECYCLE_TABLES) {
        assert.equal(tables.rows.some((row) => row.tablename === table), true, table);
      }
      const views = await fixture.admin.query<{ viewname: string }>(
        `SELECT viewname FROM pg_views WHERE schemaname = 'brain_evidence'`,
      );
      assert.equal(views.rows.some((row) => row.viewname === 'dream_candidate_state'), true);
      const generated = await fixture.admin.query<{ attgenerated: string }>(
        `SELECT a.attgenerated FROM pg_attribute a
          WHERE a.attrelid = 'brain_evidence.dream_candidates'::regclass
            AND a.attname = 'lesson_agent_key'`,
      );
      assert.equal(generated.rows[0]!.attgenerated, 's');
    });

    await t.test('the generated subject key collapses both target spellings', async () => {
      const rows = await fixture.admin.query<{ agent_key: string }>(
        `SELECT regexp_replace(regexp_replace(spelling, '^(agent|plan):', ''), '#[a-z0-9-]+$', '') AS agent_key
           FROM unnest(ARRAY[
             'agent:growth/sdr',
             'plan:growth/sdr#outbound',
             'agent:go-to-market/senior-sdr',
             'plan:go-to-market/senior-sdr#multi-part-plan'
           ]) AS spelling`,
      );
      assert.deepEqual(rows.rows.map((row) => row.agent_key), [
        'growth/sdr',
        'growth/sdr',
        'go-to-market/senior-sdr',
        'go-to-market/senior-sdr',
      ]);
    });

    await t.test('admin UPDATE, DELETE, and TRUNCATE are refused on all three tables', async () => {
      // The candidate ledger needs a row for the row-level triggers to refuse.
      await seedRuns(fixture, 5);
      const snapshot = await readiness(fixture);
      assert.equal(snapshot.status, 'due');
      const ordinal = await observationOrdinal(fixture.admin, 'completed-run', 'run-0');
      const created = await createCandidate(fixture, snapshot, [{
        role: 'supporting',
        evidenceKind: 'completed-run',
        runId: 'run-0',
        feedbackId: null,
        observationOrdinal: ordinal,
      }]);
      assert.equal(created.status, 'created');

      for (const statement of [
        `UPDATE brain_evidence.dream_candidates SET lesson_id = 'x'`,
        `DELETE FROM brain_evidence.dream_candidates`,
        `UPDATE brain_evidence.dream_candidate_evidence SET role = 'supporting'`,
        `DELETE FROM brain_evidence.dream_candidate_evidence`,
      ]) {
        await assert.rejects(fixture.admin.query(statement), /append-only/u, statement);
      }
      // Row-level triggers need a row to fire on; the STATEMENT-level truncate
      // guard is unconditional, so it is what pins the still-empty decision
      // ledger here. The promotion suite pins its row-level refusals.
      for (const table of LIFECYCLE_TABLES) {
        await assert.rejects(
          fixture.admin.query(`TRUNCATE brain_evidence.${table} CASCADE`),
          /append-only/u,
          table,
        );
      }
    });

    await t.test('a direct admin insert still has its workspace_id overwritten', async () => {
      await fixture.admin.query(
        `INSERT INTO brain_evidence.dream_candidates (
           candidate_id, record_canonical, workspace_id, readiness_key, content_digest,
           scope_key, lesson_scope_key, lesson_id, drafted_by_agent_id, lesson_purpose,
           lesson_body, expected_effect, conflicting_survey, counterexample_survey,
           policy_version, policy_fingerprint, watermark_ordinal, frontier_ordinal,
           consumed_completed_runs, consumed_feedback_records, privacy_class, trust_class,
           actor_assurance, assurance_evidence, provenance
         ) VALUES (
           $1, '{}', 'foreign-workspace', $2, $3, 'workspace', 'agent:growth/sdr', 'direct',
           'dreamer', 'p', 'b', 'e', 'none-found', 'none-found', 'acme.dream.v1', $4, 0,
           (SELECT min(ordinal) FROM brain_evidence.evidence_observations), 0, 0,
           'internal', 'host-asserted', 'host-attested', '{}', '{}'
         )`,
        [
          `sha256:${'1'.repeat(64)}`,
          `sha256:${'2'.repeat(64)}`,
          `sha256:${'3'.repeat(64)}`,
          `sha256:${'4'.repeat(64)}`,
        ],
      );
      const stored = await fixture.admin.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM brain_evidence.dream_candidates WHERE lesson_id = 'direct'`,
      );
      assert.equal(stored.rows[0]!.workspace_id, WORKSPACE_ID);
    });

    await t.test('the runtime role reads the ledger and the view but writes neither', async () => {
      for (const relation of [...LIFECYCLE_TABLES, 'dream_candidate_state']) {
        const readable = await fixture.runtime.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_evidence.${relation}`,
        );
        assert.equal(typeof readable.rows[0]!.n, 'string');
      }
      for (const statement of [
        `UPDATE brain_evidence.dream_candidates SET lesson_id = 'x'`,
        `DELETE FROM brain_evidence.lesson_decisions`,
        `INSERT INTO brain_evidence.lesson_decisions DEFAULT VALUES`,
      ]) {
        await assert.rejects(fixture.runtime.query(statement), sqlState('42501'), statement);
      }
      // The derived view is not auto-updatable AND carries no runtime write
      // grant; either refusal is a refusal.
      await assert.rejects(
        fixture.runtime.query(`UPDATE brain_evidence.dream_candidate_state SET state = 'promoted'`),
      );
    });

    await t.test('runtime EXECUTE is EXACTLY the ten approved signatures', async () => {
      // Compared by OID, exactly as the doctor compares: a rendered signature
      // depends on how a type happens to print, and an OID cannot be spelled two
      // ways.
      const granted = await fixture.admin.query<{ signature: string }>(
        `SELECT n.nspname || '.' || p.proname
                || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence'
            AND has_function_privilege($1, p.oid, 'EXECUTE')
          ORDER BY signature`,
        [fixture.runtimeRole],
      );
      const approvedOids = await fixture.admin.query<{ signature: string }>(
        `SELECT n.nspname || '.' || p.proname
                || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature
           FROM unnest($1::text[]) AS approved(spelling)
           JOIN pg_proc p ON p.oid = to_regprocedure(approved.spelling)::oid
           JOIN pg_namespace n ON n.oid = p.pronamespace
          ORDER BY signature`,
        [[...APPROVED_EVIDENCE_EXECUTE_SIGNATURES]],
      );
      assert.equal(approvedOids.rows.length, APPROVED_EVIDENCE_EXECUTE_SIGNATURES.length);
      assert.deepEqual(
        granted.rows.map((row) => row.signature),
        approvedOids.rows.map((row) => row.signature),
      );
      assert.equal(APPROVED_EVIDENCE_EXECUTE_SIGNATURES.length, 10);
      // The advance and the policy writer stay granted to NOBODY, and the lock
      // helpers stay internal to the SECURITY DEFINER context.
      for (const signature of [
        'brain_evidence.advance_dream_watermark(text)',
        'brain_evidence.register_dream_policy(text)',
        'brain_evidence.lock_key(text, text[])',
        'brain_evidence.lock_frame(text, text[])',
      ]) {
        assert.equal(
          granted.rows.some((row) => row.signature === signature),
          false,
          signature,
        );
      }
    });

    await t.test('every new 015 function is PUBLIC-revoked', async () => {
      const leaked = await fixture.admin.query<{ signature: string }>(
        `SELECT n.nspname || '.' || p.proname AS signature
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence'
            AND (
              p.proacl IS NULL
              OR EXISTS (
                SELECT 1 FROM aclexplode(p.proacl) AS acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              )
            )`,
      );
      assert.deepEqual(leaked.rows.map((row) => row.signature), []);
    });

    await t.test('the brokers, the fence, and the verifier all refuse elevated isolation', async () => {
      const client = await fixture.runtime.connect();
      try {
        for (const call of [
          `SELECT * FROM brain_evidence.record_dream_candidate('{}')`,
          `SELECT * FROM brain_evidence.decide_lesson_candidate('{}')`,
          `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
          `SELECT * FROM brain_evidence.verify_dream_subject_governor($1)`,
        ]) {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            client.query(call, call.includes('$1') ? [UNKNOWN_CANDIDATE] : undefined),
            // RBE12, deliberately NOT the RBE04 integrity code: the caller's
            // transaction is wrong, the durable state is not.
            (error: unknown) => {
              assert.equal((error as { code?: string }).code, 'RBE12', call);
              return true;
            },
            call,
          );
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
    });

    await t.test('the fence and the verifier refuse an unknown candidate', async () => {
      for (const call of [
        `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
        `SELECT * FROM brain_evidence.verify_dream_subject_governor($1)`,
      ]) {
        await assert.rejects(
          fixture.runtime.query(call, [UNKNOWN_CANDIDATE]),
          sqlState('RBE03'),
          call,
        );
      }
    });

    await t.test('a never-retired subject returns an EMPTY retired list, never NULL', async () => {
      const candidate = await fixture.admin.query<{ candidate_id: string }>(
        `SELECT candidate_id FROM brain_evidence.dream_candidates WHERE lesson_id <> 'direct' LIMIT 1`,
      );
      const rows = await fixture.runtime.query<{
        retired_content_hashes: string[] | null;
        governor_candidate_id: string | null;
      }>(
        `SELECT retired_content_hashes, governor_candidate_id
           FROM brain_evidence.hold_dream_subject_lock($1)`,
        [candidate.rows[0]!.candidate_id],
      );
      // array_agg over zero rows is SQL NULL; the coalesce is what keeps the
      // CLI's hash walk from receiving NULL on a subject's FIRST promotion.
      assert.deepEqual(rows.rows[0]!.retired_content_hashes, []);
      assert.equal(rows.rows[0]!.governor_candidate_id, null);
    });

    await t.test('the verifier acquires NO advisory lock; the fence does', async () => {
      const candidate = await fixture.admin.query<{ candidate_id: string }>(
        `SELECT candidate_id FROM brain_evidence.dream_candidates WHERE lesson_id <> 'direct' LIMIT 1`,
      );
      const client = await fixture.runtime.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT * FROM brain_evidence.verify_dream_subject_governor($1)`,
          [candidate.rows[0]!.candidate_id],
        );
        const afterVerify = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        );
        assert.equal(afterVerify.rows[0]!.n, '0');
        await client.query(
          `SELECT * FROM brain_evidence.hold_dream_subject_lock($1)`,
          [candidate.rows[0]!.candidate_id],
        );
        const afterHold = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
        );
        assert.equal(afterHold.rows[0]!.n, '1');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await t.test('the built-in policy version is reserved against registration', async () => {
      await assert.rejects(
        registerDreamPolicy(fixture.admin, {
          ...DEFAULT_DREAM_POLICY,
          activationAssurance: 'human-confirmed',
          registeredBy: 'fixture',
        }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /reserved for the built-in default policy/u);
          return true;
        },
      );
      // A different version still registers normally.
      const ok = await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.dream.v9',
        activationAssurance: 'human-confirmed',
        registeredBy: 'fixture',
      });
      assert.equal(ok.status, 'created');
    });

    await t.test('the watermark cooldown anchor is stamped at INSERTION time', async () => {
      const expression = await fixture.admin.query<{ expr: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
           FROM pg_attrdef d JOIN pg_attribute a
             ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'brain_evidence.dream_watermarks'::regclass
            AND a.attname = 'advanced_at'`,
      );
      assert.equal(expression.rows[0]!.expr, 'clock_timestamp()');
    });

    await t.test('the doctor is green with the real grants and red on any drift', async () => {
      const doctorPool = createBrainPool('admin', fixture.adminUrl);
      try {
        const healthy = await runDoctor(doctorPool, fixture.runtimeRole);
        assert.equal(
          healthy.ok,
          true,
          JSON.stringify(healthy.checks.filter((entry) => !entry.ok)),
        );
        const evidenceCheck = healthy.checks.filter((entry) =>
          entry.name.startsWith('brain-evidence-append-only'));
        assert.equal(evidenceCheck.length, 1, 'the approved set is reported once, never double-counted');

        for (const drift of [
          `GRANT EXECUTE ON FUNCTION brain_evidence.advance_dream_watermark(text) TO "${fixture.runtimeRole}"`,
          `GRANT EXECUTE ON FUNCTION brain_evidence.lock_key(text, text[]) TO "${fixture.runtimeRole}"`,
          `REVOKE EXECUTE ON FUNCTION brain_evidence.decide_lesson_candidate(text) FROM "${fixture.runtimeRole}"`,
          `REVOKE EXECUTE ON FUNCTION brain_evidence.hold_dream_subject_lock(text) FROM "${fixture.runtimeRole}"`,
          `REVOKE EXECUTE ON FUNCTION brain_evidence.verify_dream_subject_governor(text) FROM "${fixture.runtimeRole}"`,
          `REVOKE EXECUTE ON FUNCTION brain_evidence.dream_eligible(text, timestamptz, bigint) FROM "${fixture.runtimeRole}"`,
          `REVOKE SELECT ON brain_evidence.dream_candidate_state FROM "${fixture.runtimeRole}"`,
          `GRANT UPDATE ON brain_evidence.dream_candidate_state TO "${fixture.runtimeRole}"`,
          `GRANT UPDATE (state) ON brain_evidence.dream_candidate_state TO "${fixture.runtimeRole}"`,
          `GRANT EXECUTE ON FUNCTION brain_evidence.assert_safe_multiline_text(jsonb, text, integer) TO "${fixture.runtimeRole}"`,
        ]) {
          await fixture.admin.query(drift);
          const report = await runDoctor(doctorPool, fixture.runtimeRole);
          const check = report.checks.find((entry) =>
            entry.name.startsWith('brain-evidence-append-only'));
          assert.equal(check?.ok, false, drift);
          assert.equal(report.ok, false, drift);
          await fixture.admin.query(
            drift.startsWith('GRANT ')
              ? drift.replace('GRANT ', 'REVOKE ').replace(' TO ', ' FROM ')
              : drift.replace('REVOKE ', 'GRANT ').replace(' FROM ', ' TO '),
          );
        }

        const repaired = await runDoctor(doctorPool, fixture.runtimeRole);
        assert.equal(
          repaired.ok,
          true,
          JSON.stringify(repaired.checks.filter((entry) => !entry.ok)),
        );
      } finally {
        await doctorPool.end();
      }
    });
  } finally {
    await fixture.close();
  }
});
