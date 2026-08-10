import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { loadMigrations, schemaDir } from '../src/lib/brain/migrate.ts';
import { runDoctor } from '../src/lib/brain/doctor.ts';
import { registerDreamPolicy, advanceDreamWatermark } from '../src/lib/brain/dream-readiness.ts';
import { DEFAULT_DREAM_POLICY } from '../src/lib/brain/dream-contracts.ts';
import { recordCompletedRun } from '../src/lib/brain/evidence-store.ts';
import { HAS_DB } from './brain-helpers.ts';
import { createEvidenceFixture, seedRunInput } from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'dream-schema-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const DREAM_TABLES = ['dream_policies', 'dream_watermarks', 'evidence_observations'] as const;
const OBSERVATION_SEQUENCE = 'brain_evidence.evidence_observation_ordinal_seq';

function sqlState(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

test('the 014 dream schema is append-only and admin-writable only', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await t.test('bootstraps the whole migration set including 014', async () => {
      const files = loadMigrations(schemaDir());
      assert.equal(files.some((file) => file.filename === '014_dream_readiness.sql'), true);
      const recorded = await fixture.admin.query<{ filename: string }>(
        `SELECT filename FROM brain_meta.schema_migrations ORDER BY filename`,
      );
      assert.deepEqual(recorded.rows.map((row) => row.filename), files.map((file) => file.filename));
      const tables = await fixture.admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'brain_evidence' ORDER BY tablename`,
      );
      for (const table of DREAM_TABLES) {
        assert.equal(tables.rows.some((row) => row.tablename === table), true, table);
      }
    });

    // has_function_privilege is grant-path agnostic and would report a PUBLIC
    // grant as a role grant, so the ACL itself is inspected: a function with
    // proacl IS NULL grants PUBLIC EXECUTE implicitly.
    await t.test('no brain_evidence function is PUBLIC-executable', async () => {
      const leaked = await fixture.admin.query<{ signature: string }>(
        `SELECT n.nspname || '.' || p.proname
                || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS signature
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence'
            AND (
              p.proacl IS NULL
              OR EXISTS (
                SELECT 1 FROM aclexplode(p.proacl) AS acl
                 WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
              )
            )
          ORDER BY signature`,
      );
      assert.deepEqual(leaked.rows.map((row) => row.signature), []);
      const total = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence'`,
      );
      assert.equal(Number(total.rows[0]!.n) > 20, true, 'the ACL sweep must cover 013 and 014');
    });

    await t.test('014 declares exactly one SECURITY DEFINER function and grants EXECUTE to nobody', async () => {
      const definers = await fixture.admin.query<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence' AND p.prosecdef
            AND p.proname IN ('observe_evidence', 'derive_dream_workspace',
                              'dream_agent_id_list_ok', 'register_dream_policy',
                              'advance_dream_watermark')
          ORDER BY p.proname`,
      );
      assert.deepEqual(definers.rows.map((row) => row.proname), ['observe_evidence']);

      const granted = await fixture.admin.query<{ signature: string; grantee: string }>(
        `SELECT p.proname AS signature, pg_get_userbyid(acl.grantee) AS grantee
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(p.proacl) AS acl
          WHERE n.nspname = 'brain_evidence'
            AND p.proname IN ('observe_evidence', 'derive_dream_workspace',
                              'dream_agent_id_list_ok', 'register_dream_policy',
                              'advance_dream_watermark')
            AND acl.privilege_type = 'EXECUTE'
            AND acl.grantee <> p.proowner`,
      );
      assert.deepEqual(granted.rows, []);
    });

    await t.test('the runtime role reads the new tables and can write nothing', async () => {
      for (const table of DREAM_TABLES) {
        const readable = await fixture.runtime.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_evidence.${table}`,
        );
        assert.equal(typeof readable.rows[0]!.n, 'string');
        for (const statement of [
          `INSERT INTO brain_evidence.${table} DEFAULT VALUES`,
          `DELETE FROM brain_evidence.${table}`,
          `UPDATE brain_evidence.${table} SET workspace_id = 'x'`,
        ]) {
          await assert.rejects(fixture.runtime.query(statement), sqlState('42501'), statement);
        }
      }
      // The observation triggers cannot be dropped without the TRIGGER
      // privilege, which the runtime role does not hold on any evidence table.
      const triggerPriv = await fixture.runtime.query<{ ok: boolean }>(
        `SELECT bool_or(has_table_privilege(current_user, c.oid, 'TRIGGER')) AS ok
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'brain_evidence' AND c.relkind = 'r'`,
      );
      assert.equal(triggerPriv.rows[0]!.ok, false);

      // Zero USAGE/SELECT/UPDATE on the commit-ordering sequence: `last_value`
      // alone is an evidence-volume side channel.
      for (const privilege of ['USAGE', 'SELECT', 'UPDATE']) {
        const held = await fixture.runtime.query<{ ok: boolean }>(
          `SELECT has_sequence_privilege(current_user, $1, $2) AS ok`,
          [OBSERVATION_SEQUENCE, privilege],
        );
        assert.equal(held.rows[0]!.ok, false, privilege);
      }
      await assert.rejects(
        fixture.runtime.query(`SELECT nextval('${OBSERVATION_SEQUENCE}')`),
        sqlState('42501'),
      );

      for (const admin of ['register_dream_policy(text)', 'advance_dream_watermark(text)']) {
        const held = await fixture.runtime.query<{ ok: boolean }>(
          `SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS ok`,
          [`brain_evidence.${admin}`],
        );
        assert.equal(held.rows[0]!.ok, false, admin);
        await assert.rejects(
          fixture.runtime.query(`SELECT * FROM brain_evidence.${admin.replace('(text)', '')}('{}')`),
          sqlState('42501'),
          admin,
        );
      }
    });

    await t.test('dream_agent_id_list_ok makes the <> ALL footgun unrepresentable', async () => {
      const verdicts = await fixture.admin.query<Record<string, boolean>>(
        `SELECT brain_evidence.dream_agent_id_list_ok(ARRAY['dreamer']) AS ok_one,
                brain_evidence.dream_agent_id_list_ok(ARRAY[]::text[]) AS ok_empty,
                brain_evidence.dream_agent_id_list_ok(ARRAY['a', NULL]) AS null_element,
                brain_evidence.dream_agent_id_list_ok(ARRAY['a', 'a']) AS duplicate,
                brain_evidence.dream_agent_id_list_ok(ARRAY['Bad']) AS malformed,
                brain_evidence.dream_agent_id_list_ok(ARRAY[['a'], ['b']]) AS two_dimensional,
                brain_evidence.dream_agent_id_list_ok(
                  ARRAY(SELECT 'a' || g FROM generate_series(1, 65) g)) AS too_many`,
      );
      assert.deepEqual(verdicts.rows[0], {
        ok_one: true,
        ok_empty: true,
        null_element: false,
        duplicate: false,
        malformed: false,
        two_dimensional: false,
        too_many: false,
      });
      await assert.rejects(
        fixture.admin.query(
          `INSERT INTO brain_evidence.dream_policies (
             policy_version, policy_canonical, workspace_id, scope_key, min_completed_runs,
             min_feedback_records, min_signal_mix, evidence_window, cooldown,
             excluded_agent_ids, activation_assurance, registered_by
           ) VALUES ('bad.policy.v1', '{}', 'x', 'workspace', 1, 0, 0,
                     interval '1 day', interval '1 hour',
                     ARRAY['a', NULL], 'system-derived', 'test')`,
        ),
        sqlState('23514'),
      );
    });

    await t.test('every closed column refuses an out-of-range direct INSERT', async () => {
      const policyColumns = `(
         policy_version, policy_canonical, workspace_id, scope_key, min_completed_runs,
         min_feedback_records, min_signal_mix, evidence_window, cooldown,
         excluded_agent_ids, activation_assurance, registered_by
       )`;
      const validPolicy = [
        `'check.policy.v1'`, `'{}'`, `'x'`, `'workspace'`, '1', '0', '0',
        `interval '1 day'`, `interval '1 hour'`, `ARRAY[]::text[]`, `'system-derived'`, `'test'`,
      ];
      for (const [index, bad] of [
        [0, `'Bad.V1'`],
        [3, `'agent:social-media'`],
        [4, '0'],
        [4, '10001'],
        [5, '-1'],
        [6, '10001'],
        [7, `interval '59 minutes'`],
        [7, `interval '366 days'`],
        [8, `interval '-1 second'`],
        [8, `interval '31 days'`],
        [10, `'caller-asserted'`],
        [11, `''`],
      ] as [number, string][]) {
        const values = [...validPolicy];
        values[index] = bad;
        await assert.rejects(
          fixture.admin.query(
            `INSERT INTO brain_evidence.dream_policies ${policyColumns} VALUES (${values.join(', ')})`,
          ),
          sqlState('23514'),
          `dream_policies[${index}] = ${bad}`,
        );
      }

      await recordCompletedRun(fixture.runtime, seedRunInput('run-check-matrix'));
      const watermarkColumns = `(
         scope_key, sequence, record_canonical, workspace_id, cursor_ordinal,
         policy_version, reason, consumed_completed_runs, consumed_feedback_records,
         actor_assurance
       )`;
      const validWatermark = [
        `'workspace'`, '1', `'{}'`, `'x'`, '1', `'check.policy.v1'`, `'promotion'`, '0', '0',
        `'human-confirmed'`,
      ];
      for (const [index, bad] of [
        [0, `'agent:social-media'`],
        [1, '0'],
        [4, '0'],
        [5, `'Bad.V1'`],
        [6, `'operator'`],
        [7, '-1'],
        [8, '-1'],
        [9, `'nobody'`],
      ] as [number, string][]) {
        const values = [...validWatermark];
        values[index] = bad;
        await assert.rejects(
          fixture.admin.query(
            `INSERT INTO brain_evidence.dream_watermarks ${watermarkColumns} VALUES (${values.join(', ')})`,
          ),
          sqlState('23514'),
          `dream_watermarks[${index}] = ${bad}`,
        );
      }

      for (const [column, bad] of [
        ['evidence_kind', `'promotion'`],
        ['evidence_id', `'-leading-dash'`],
        ['workspace_id', `'Bad Workspace'`],
      ] as [string, string][]) {
        const values: Record<string, string> = {
          ordinal: '9999',
          evidence_kind: `'completed-run'`,
          evidence_id: `'run-check'`,
          workspace_id: `'x'`,
          recorded_at: 'now()',
        };
        values[column] = bad;
        await assert.rejects(
          fixture.admin.query(
            `INSERT INTO brain_evidence.evidence_observations
               (ordinal, evidence_kind, evidence_id, workspace_id, recorded_at)
             VALUES (${Object.values(values).join(', ')})`,
          ),
          sqlState('23514'),
          `evidence_observations.${column} = ${bad}`,
        );
      }
    });

    await t.test('a direct admin INSERT cannot record a foreign workspace', async () => {
      await recordCompletedRun(fixture.runtime, seedRunInput('run-workspace-derived'));
      await fixture.admin.query(
        `INSERT INTO brain_evidence.dream_policies (
           policy_version, policy_canonical, workspace_id, scope_key, min_completed_runs,
           min_feedback_records, min_signal_mix, evidence_window, cooldown,
           excluded_agent_ids, activation_assurance, registered_by
         ) VALUES ('foreign.policy.v1', '{}', 'someone-elses-workspace', 'workspace', 1, 0, 0,
                   interval '1 day', interval '1 hour', ARRAY[]::text[], 'system-derived', 'test')`,
      );
      await fixture.admin.query(
        `INSERT INTO brain_evidence.dream_watermarks (
           scope_key, sequence, record_canonical, workspace_id, cursor_ordinal,
           policy_version, reason, consumed_completed_runs, consumed_feedback_records,
           actor_assurance
         ) VALUES ('workspace', 99, '{}', 'someone-elses-workspace', 1,
                   'foreign.policy.v1', 'promotion', 0, 0, 'system-derived')`,
      );
      const stored = await fixture.admin.query<{ policy: string; watermark: string }>(
        `SELECT (SELECT workspace_id FROM brain_evidence.dream_policies
                  WHERE policy_version = 'foreign.policy.v1') AS policy,
                (SELECT workspace_id FROM brain_evidence.dream_watermarks
                  WHERE sequence = 99) AS watermark`,
      );
      assert.deepEqual(stored.rows[0], { policy: WORKSPACE_ID, watermark: WORKSPACE_ID });

      // Those two rows also give the append-only triggers something to refuse.
      for (const statement of [
        `UPDATE brain_evidence.dream_policies SET registered_by = 'other'`,
        `DELETE FROM brain_evidence.dream_policies`,
        `TRUNCATE brain_evidence.dream_policies`,
        `UPDATE brain_evidence.dream_watermarks SET reason = 'promotion'`,
        `DELETE FROM brain_evidence.dream_watermarks`,
        `TRUNCATE brain_evidence.dream_watermarks`,
      ]) {
        await assert.rejects(fixture.admin.query(statement), /append-only/u, statement);
      }
    });

    // B3: without the additive sequence clause this subtest fails against an
    // unmodified doctor.ts -- it is the regression proof for that fix.
    await t.test('doctor turns red on an injected sequence or dream-function grant', async () => {
      const doctorPool = createBrainPool('admin', fixture.adminUrl);
      try {
        const healthy = await runDoctor(doctorPool, fixture.runtimeRole);
        assert.equal(healthy.ok, true, JSON.stringify(healthy.checks.filter((entry) => !entry.ok)));

        for (const drift of [
          `GRANT USAGE ON SEQUENCE ${OBSERVATION_SEQUENCE} TO "${fixture.runtimeRole}"`,
          `GRANT SELECT ON SEQUENCE ${OBSERVATION_SEQUENCE} TO "${fixture.runtimeRole}"`,
          `GRANT UPDATE ON SEQUENCE ${OBSERVATION_SEQUENCE} TO "${fixture.runtimeRole}"`,
          `GRANT EXECUTE ON FUNCTION brain_evidence.advance_dream_watermark(text) TO "${fixture.runtimeRole}"`,
          `GRANT EXECUTE ON FUNCTION brain_evidence.register_dream_policy(text) TO "${fixture.runtimeRole}"`,
          `GRANT INSERT ON brain_evidence.evidence_observations TO "${fixture.runtimeRole}"`,
        ]) {
          await fixture.admin.query(drift);
          const report = await runDoctor(doctorPool, fixture.runtimeRole);
          const check = report.checks.find((entry) => entry.name.startsWith('brain-evidence-append-only'));
          assert.equal(check?.ok, false, drift);
          assert.equal(report.ok, false, drift);
          await fixture.admin.query(drift.replace('GRANT ', 'REVOKE ').replace(' TO ', ' FROM '));
        }

        const repaired = await runDoctor(doctorPool, fixture.runtimeRole);
        assert.equal(repaired.ok, true, JSON.stringify(repaired.checks.filter((entry) => !entry.ok)));
      } finally {
        await doctorPool.end();
      }
    });

    await t.test('the admin writers refuse an unknown field and an out-of-range threshold', async () => {
      await assert.rejects(
        fixture.admin.query(
          `SELECT * FROM brain_evidence.register_dream_policy($1)`,
          [JSON.stringify({
            kind: 'dream-policy',
            schema_version: 1,
            policy_version: 'acme.dream.v1',
            scope_key: 'workspace',
            min_completed_runs: 1,
            min_feedback_records: 0,
            min_signal_mix: 0,
            evidence_window_seconds: 86_400,
            cooldown_seconds: 0,
            excluded_agent_ids: [],
            activation_assurance: 'system-derived',
            registered_by: 'test',
            workspace_id: 'someone-else',
          })],
        ),
        sqlState('RBE01'),
      );
      const registered = await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.dream.v1',
        activationAssurance: 'human-confirmed',
        registeredBy: 'owner',
      });
      assert.equal(registered.status, 'created');
      const replay = await registerDreamPolicy(fixture.admin, {
        ...DEFAULT_DREAM_POLICY,
        policyVersion: 'acme.dream.v1',
        activationAssurance: 'human-confirmed',
        registeredBy: 'owner',
      });
      assert.equal(replay.status, 'existing');
      await assert.rejects(
        registerDreamPolicy(fixture.admin, {
          ...DEFAULT_DREAM_POLICY,
          policyVersion: 'acme.dream.v1',
          minCompletedRuns: 9,
          activationAssurance: 'human-confirmed',
          registeredBy: 'owner',
        }),
        (error: unknown) => (error as { code?: string }).code === 'BRAIN_DREAM_IDEMPOTENCY_CONFLICT',
      );
      await assert.rejects(
        advanceDreamWatermark(fixture.admin, {
          scopeKey: 'workspace',
          cursorOrdinal: 9_999,
          policyVersion: 'acme.dream.v1',
          reason: 'promotion',
          consumedCompletedRuns: 0,
          consumedFeedbackRecords: 0,
          actorAssurance: 'human-confirmed',
        }),
        (error: unknown) => (error as { code?: string }).code === 'BRAIN_DREAM_REF_NOT_FOUND',
      );
    });
  } finally {
    await fixture.close();
  }
});
