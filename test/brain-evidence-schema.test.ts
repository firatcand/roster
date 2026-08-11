import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { loadMigrations, schemaDir } from '../src/lib/brain/migrate.ts';
import { buildRuntimeUrl } from '../src/lib/brain/roles.ts';
import { runDoctor } from '../src/lib/brain/doctor.ts';
import { ingestBrainSource } from '../src/lib/brain/source-lifecycle.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
} from '../src/lib/brain/workspace-authority.ts';
import {
  promoteEvidence,
  recordCompletedRun,
  recordFeedback,
  recordHumanDecision,
  recordRunArtifact,
} from '../src/lib/brain/evidence-store.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';
import { MemoryObjectStore, brainConfig, createEvidenceFixture } from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'evidence-schema-test';
const UPGRADE_WORKSPACE_ID = 'evidence-upgrade-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 180_000 };

const EVIDENCE_TABLES = [
  'completed_runs',
  'run_sources',
  'run_tools',
  'run_artifacts',
  'feedback',
  'human_decisions',
  'evidence_promotions',
] as const;

const RECORD_BROKERS = [
  'record_completed_run',
  'record_run_artifact',
  'record_feedback',
  'record_human_decision',
] as const;

const ACTOR = {
  actorId: 'codex-session',
  assurance: 'host-attested',
  host: 'codex',
  sessionId: 'evidence-schema',
} as const;

function sqlState(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

function migrationPrefix(filename: string): number {
  return Number.parseInt(filename.split('_', 1)[0]!, 10);
}

type LedgerRow = { filename: string; sha256: string };

async function recordedLedger(pool: {
  query: <T extends Record<string, unknown>>(text: string) => Promise<{ rows: T[] }>;
}): Promise<LedgerRow[]> {
  const rows = await pool.query<LedgerRow>(
    `SELECT filename, sha256 FROM brain_meta.schema_migrations ORDER BY filename`,
  );
  return rows.rows;
}

// The invariant that actually matters for a numbered migration set: whatever a
// database has recorded must be an exact ordered prefix — same filenames in the
// same order, same content hashes — of the migrations on disk. A database that
// recorded 013 before 012 existed could never be upgraded again.
function assertExactOrderedPrefix(
  recorded: readonly LedgerRow[],
  files: readonly { filename: string; sha256: string }[],
): void {
  assert.ok(recorded.length <= files.length, 'ledger is longer than the on-disk migration set');
  const expected = files.slice(0, recorded.length);
  assert.deepEqual(recorded.map((row) => row.filename), expected.map((file) => file.filename));
  assert.deepEqual(recorded.map((row) => row.sha256), expected.map((file) => file.sha256));
}

test('brain evidence schema installs append-only tables the runtime role can only read', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await t.test('bootstraps the whole migration set including 013', async () => {
      const files = loadMigrations(schemaDir());
      assert.equal(files.some((file) => file.filename === '013_evidence_core.sql'), true);
      const recorded = await recordedLedger(fixture.admin);
      assertExactOrderedPrefix(recorded, files);
      assert.equal(recorded.length, files.length);
      const tables = await fixture.admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'brain_evidence' ORDER BY tablename`,
      );
      // #357 adds three more relations to the same schema, so 013's seven are
      // asserted as a SUBSET: the invariant is that 013 installs all of them,
      // not that no later migration may extend brain_evidence.
      const installed = new Set(tables.rows.map((row) => row.tablename));
      assert.deepEqual([...EVIDENCE_TABLES].filter((table) => !installed.has(table)), []);
    });

    await t.test('pins per-kind partial unique promotion indexes without raising the PostgreSQL floor', async () => {
      const indexes = await fixture.admin.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'brain_evidence' AND tablename = 'evidence_promotions'
          ORDER BY indexname`,
      );
      const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
      for (const [name, kind] of [
        ['evidence_promotions_run_identity', 'completed-run'],
        ['evidence_promotions_artifact_identity', 'run-artifact'],
        ['evidence_promotions_feedback_identity', 'feedback'],
        ['evidence_promotions_decision_identity', 'human-decision'],
      ] as const) {
        const definition = byName.get(name);
        assert.notEqual(definition, undefined, name);
        assert.match(definition!, /CREATE UNIQUE INDEX/u);
        assert.equal(definition!.includes(`evidence_kind = '${kind}'`), true, name);
        assert.equal(definition!.includes('promoted_source_version_id'), true, name);
      }
      for (const definition of indexes.rows) {
        assert.equal(definition.indexdef.includes('NULLS NOT DISTINCT'), false, definition.indexname);
      }
    });

    await t.test('enforces the closed column vocabulary against a raw admin insert', async () => {
      const columns = `(run_id, record_canonical, workspace_id, function_id, agent_id, plan_id, host,
        host_version, roster_version, request_summary, request_hash, started_at, completed_at,
        outcome, privacy_class, trust_class, actor_assurance, assurance_evidence, provenance)`;
      const values = (overrides: Record<string, unknown>) => {
        const base: Record<string, unknown> = {
          run_id: 'raw-run',
          record_canonical: '{"kind":"completed-run"}',
          workspace_id: WORKSPACE_ID,
          function_id: 'social-media',
          agent_id: 'manager',
          plan_id: null,
          host: 'codex',
          host_version: '0.51.0',
          roster_version: '1.8.1',
          request_summary: 'raw insert',
          request_hash: `sha256:${'a'.repeat(64)}`,
          started_at: '2026-08-08T10:00:00Z',
          completed_at: '2026-08-08T10:01:00Z',
          outcome: 'succeeded',
          privacy_class: 'internal',
          trust_class: 'host-asserted',
          actor_assurance: 'host-attested',
          assurance_evidence: '{}',
          provenance: '{}',
          ...overrides,
        };
        return Object.values(base);
      };
      const insert = `INSERT INTO brain_evidence.completed_runs ${columns}
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz,
                $14, $15, $16, $17, $18::jsonb, $19::jsonb)`;

      await assert.rejects(
        fixture.admin.query(insert, values({ outcome: 'in-progress' })),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(insert, values({ completed_at: '2026-08-08T09:00:00Z' })),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(insert, values({ record_canonical: 'hascontrol' })),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(insert, values({ host: 'gemini' })),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(insert, values({ privacy_class: 'confidential' })),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(
          `INSERT INTO brain_evidence.human_decisions
             (decision_id, record_canonical, workspace_id, action, action_summary, action_digest,
              requested_decision, answer, privacy_class, trust_class, actor_assurance,
              assurance_evidence, decided_at, host_provenance, related_run_id, related_artifact_id)
           VALUES ('raw-decision', '{}', $1, '{}'::jsonb, 'raw', $2, 'approval', 'approved',
                   'internal', 'host-asserted', 'host-attested', '{}'::jsonb, now(), '{}'::jsonb,
                   NULL, 'orphan-artifact')`,
          [WORKSPACE_ID, `sha256:${'b'.repeat(64)}`],
        ),
        sqlState('23514'),
      );
      await assert.rejects(
        fixture.admin.query(
          `INSERT INTO brain_evidence.evidence_promotions
             (promotion_id, record_canonical, workspace_id, evidence_kind, run_id, artifact_id,
              feedback_id, decision_id, promoted_source_version_id, actor_assurance,
              assurance_evidence, provenance)
           VALUES ($1, '{}', $2, 'feedback', 'run-1', NULL, 'feedback-1', NULL, $3,
                   'host-attested', '{}'::jsonb, '{}'::jsonb)`,
          [`sha256:${'c'.repeat(64)}`, WORKSPACE_ID, `sha256:${'d'.repeat(64)}`],
        ),
        sqlState('23514'),
      );
    });

    await t.test('rejects UPDATE, DELETE, and TRUNCATE on every evidence table', async () => {
      const seed = await ingestBrainSource(
        { pool: fixture.admin, objectStore: fixture.store },
        {
          requestKey: 'evidence-schema-seed',
          source: { kind: 'inline-text', stableKey: 'schema-seed' },
          bytes: Buffer.from('seed bytes', 'utf8'),
          labels: [{ workspace: WORKSPACE_ID }],
          privacy: 'internal',
          trust: 'host-asserted',
          actor: ACTOR,
          mediaType: 'text/plain',
          provenance: { fixture: 'brain-evidence-schema' },
        },
      );
      await recordCompletedRun(fixture.runtime, {
        runId: 'run-append-only',
        functionId: 'social-media',
        agentId: 'manager',
        planId: null,
        host: 'codex',
        hostVersion: '0.51.0',
        requestSummary: 'append-only probe',
        requestHash: `sha256:${'a'.repeat(64)}`,
        startedAt: '2026-08-08T10:00:00.000Z',
        completedAt: '2026-08-08T10:01:00.000Z',
        outcome: 'succeeded',
        privacy: 'internal',
        trust: 'host-asserted',
        sources: [{ kind: 'brain-source-version', sourceVersionId: seed.sourceVersionId }],
        tools: [{ toolUseId: 'probe' }],
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-schema' },
      });

      await recordRunArtifact(fixture.runtime, {
        runId: 'run-append-only',
        artifactId: 'probe.md',
        sha256: 'c'.repeat(64),
        byteLength: 12,
        mediaType: 'text/markdown',
        pointer: { kind: 'external', locator: { provider: 'notion' } },
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-schema' },
      });
      await recordFeedback(fixture.runtime, {
        feedbackId: 'feedback-append-only',
        runId: 'run-append-only',
        signal: 'mixed',
        summary: 'append-only probe feedback',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-schema' },
      });
      await recordHumanDecision(fixture.runtime, {
        decisionId: 'decision-append-only',
        action: { target: 'probe', effect: 'publish', scope: 'social-media', params: {} },
        actionSummary: 'append-only probe decision',
        requestedDecision: 'approval',
        answer: 'approved',
        privacy: 'internal',
        trust: 'host-asserted',
        actor: ACTOR,
        decidedAt: '2026-08-08T10:02:00.000Z',
        hostProvenance: { host: 'codex' },
      });
      await promoteEvidence(
        { pool: fixture.admin, objectStore: fixture.store },
        {
          evidenceKind: 'feedback',
          feedbackId: 'feedback-append-only',
          labels: [{ workspace: WORKSPACE_ID }],
          privacy: 'internal',
          trust: 'brain-structured',
          actor: ACTOR,
          provenance: { fixture: 'brain-evidence-schema' },
        },
      );

      for (const table of EVIDENCE_TABLES) {
        const populated = await fixture.admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_evidence.${table}`,
        );
        assert.notEqual(populated.rows[0]!.n, '0', table);
        for (const statement of [
          `UPDATE brain_evidence.${table} SET recorded_at = now()`,
          `DELETE FROM brain_evidence.${table}`,
          `TRUNCATE brain_evidence.${table} CASCADE`,
        ]) {
          await assert.rejects(fixture.admin.query(statement), /append-only/u, statement);
        }
      }
      const survived = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.completed_runs WHERE run_id = 'run-append-only'`,
      );
      assert.equal(survived.rows[0]!.n, '1');
    });

    await t.test('grants the runtime role SELECT plus the four record brokers and nothing else', async () => {
      for (const table of EVIDENCE_TABLES) {
        const readable = await fixture.runtime.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM brain_evidence.${table}`,
        );
        assert.equal(typeof readable.rows[0]!.n, 'string');
        for (const statement of [
          `INSERT INTO brain_evidence.${table} DEFAULT VALUES`,
          `DELETE FROM brain_evidence.${table}`,
          `UPDATE brain_evidence.${table} SET recorded_at = now()`,
        ]) {
          await assert.rejects(fixture.runtime.query(statement), sqlState('42501'));
        }
      }

      for (const broker of RECORD_BROKERS) {
        const granted = await fixture.runtime.query<{ ok: boolean }>(
          `SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS ok`,
          [`brain_evidence.${broker}(text)`],
        );
        assert.equal(granted.rows[0]!.ok, true, broker);
      }
      for (const internal of [
        'brain_evidence.lock_key(text, text[])',
        'brain_evidence.lock_frame(text, text[])',
        'brain_evidence.assert_keys(jsonb, text[])',
        'brain_evidence.workspace_identity_id()',
      ]) {
        const denied = await fixture.runtime.query<{ ok: boolean }>(
          `SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS ok`,
          [internal],
        );
        assert.equal(denied.rows[0]!.ok, false, internal);
      }

      // Pre-013 grants are untouched: source lifecycle stays denied, the merge
      // broker stays granted.
      await assert.rejects(
        fixture.runtime.query(`INSERT INTO brain.source_versions DEFAULT VALUES`),
        sqlState('42501'),
      );
      const merge = await fixture.runtime.query<{ ok: boolean }>(
        `SELECT has_function_privilege(current_user, 'brain.merge_entities(bigint, bigint, text)', 'EXECUTE') AS ok`,
      );
      assert.equal(merge.rows[0]!.ok, true);
      const create = await fixture.runtime.query<{ ok: boolean }>(
        `SELECT has_schema_privilege(current_user, 'brain_evidence', 'CREATE') AS ok`,
      );
      assert.equal(create.rows[0]!.ok, false);
    });

    await t.test('doctor turns red on injected evidence-privilege drift', async () => {
      const doctorPool = createBrainPool('admin', fixture.adminUrl);
      try {
        const healthy = await runDoctor(doctorPool, fixture.runtimeRole);
        const evidenceCheck = healthy.checks.find((entry) => entry.name.startsWith('brain-evidence-append-only'));
        assert.notEqual(evidenceCheck, undefined);
        assert.equal(evidenceCheck!.ok, true, evidenceCheck!.detail);
        assert.equal(healthy.ok, true, JSON.stringify(healthy.checks.filter((entry) => !entry.ok)));

        for (const drift of [
          `GRANT INSERT ON brain_evidence.completed_runs TO "${fixture.runtimeRole}"`,
          `GRANT INSERT (summary) ON brain_evidence.feedback TO "${fixture.runtimeRole}"`,
          `GRANT CREATE ON SCHEMA brain_evidence TO "${fixture.runtimeRole}"`,
          `GRANT EXECUTE ON FUNCTION brain_evidence.lock_key(text, text[]) TO "${fixture.runtimeRole}"`,
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

        // An OVERLOAD sharing an approved broker name is an unapproved executable
        // surface: a new function is PUBLIC-executable by default, so the audit
        // must compare full signatures, not names.
        await fixture.admin.query(
          `CREATE FUNCTION brain_evidence.record_completed_run(p_payload jsonb)
             RETURNS void LANGUAGE plpgsql AS 'BEGIN END;'`,
        );
        const overloaded = await runDoctor(doctorPool, fixture.runtimeRole);
        const overloadCheck = overloaded.checks.find((entry) =>
          entry.name.startsWith('brain-evidence-append-only'));
        assert.equal(overloadCheck?.ok, false, overloadCheck?.detail);
        // The finding renders the identity arguments, which include parameter names;
        // the OVERLOAD is what is pinned, not the renderer's spelling.
        assert.match(overloadCheck!.detail, /record_completed_run\([^)]*jsonb\)/u);
        await fixture.admin.query(`DROP FUNCTION brain_evidence.record_completed_run(jsonb)`);

        // A MISSING expected broker must read as a red finding, never a cast
        // exception that takes the whole report down.
        await fixture.admin.query(
          `ALTER FUNCTION brain_evidence.record_feedback(text) RENAME TO record_feedback_moved`,
        );
        const missing = await runDoctor(doctorPool, fixture.runtimeRole);
        const missingCheck = missing.checks.find((entry) =>
          entry.name.startsWith('brain-evidence-append-only'));
        assert.equal(missingCheck?.ok, false, missingCheck?.detail);
        assert.match(missingCheck!.detail, /missing EXECUTE on brain_evidence\.record_feedback\(text\)/u);
        await fixture.admin.query(
          `ALTER FUNCTION brain_evidence.record_feedback_moved(text) RENAME TO record_feedback`,
        );

        const restored = await runDoctor(doctorPool, fixture.runtimeRole);
        assert.equal(restored.ok, true, JSON.stringify(restored.checks.filter((entry) => !entry.ok)));
      } finally {
        await doctorPool.end();
      }
    });
  } finally {
    await fixture.close();
  }
});

test('brain evidence schema upgrades a populated 011-era brain in ledger order', options, async () => {
  const files = loadMigrations(schemaDir());
  const legacy = files.filter((file) => migrationPrefix(file.filename) <= 11);
  const upgrades = files.filter((file) => migrationPrefix(file.filename) > 11);
  assert.equal(legacy.at(-1)!.filename, '011_source_lifecycle.sql');
  // Never hardcode the upgrade set: it is whatever the schema directory holds
  // above 011, so a later migration landing beside 013 needs no test edit.
  assert.equal(upgrades.some((file) => file.filename === '013_evidence_core.sql'), true);

  const staged = mkdtempSync(join(tmpdir(), 'roster-brain-011-'));
  for (const file of legacy) cpSync(join(schemaDir(), file.filename), join(staged, file.filename));
  assert.deepEqual(readdirSync(staged).sort(), legacy.map((file) => file.filename).sort());

  const fresh = await createFreshDb();
  const authority = deriveBrainWorkspaceAuthority(UPGRADE_WORKSPACE_ID, brainConfig(UPGRADE_WORKSPACE_ID));
  const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
  let runtimeRole: string | undefined;
  try {
    const first = createBrainPool('admin', fresh.url);
    let authorityId: string;
    try {
      const bootstrap = await bootstrapBrainWorkspaceAuthority(first, authority, {
        runtimeRole: fresh.role,
        runtimePassword: password,
        migrationsDir: staged,
      });
      runtimeRole = bootstrap.role.roleName;
      authorityId = bootstrap.databaseAuthorityId;
      assert.deepEqual(bootstrap.migrations.applied, legacy.map((file) => file.filename));
    } finally {
      await first.end();
    }

    const legacyPool = createVerifiedBrainPool({
      connectionString: fresh.url,
      authority,
      databaseAuthorityId: authorityId,
    });
    assertExactOrderedPrefix(await recordedLedger(legacyPool), files);
    assert.equal((await recordedLedger(legacyPool)).length, legacy.length);
    let seededVersionId: string;
    try {
      const seeded = await ingestBrainSource(
        { pool: legacyPool, objectStore: new MemoryObjectStore(authority.namespaceFingerprint) },
        {
          requestKey: 'pre-upgrade-source',
          source: { kind: 'inline-text', stableKey: 'pre-upgrade' },
          bytes: Buffer.from('company knowledge recorded before the upgrade', 'utf8'),
          labels: [{ workspace: UPGRADE_WORKSPACE_ID }],
          privacy: 'internal',
          trust: 'host-asserted',
          actor: ACTOR,
          mediaType: 'text/plain',
          provenance: { fixture: 'brain-evidence-upgrade' },
        },
      );
      seededVersionId = seeded.sourceVersionId;
      await legacyPool.query(
        `INSERT INTO brain.entities (kind, slug, title) VALUES ('org', 'pre-upgrade-co', 'Pre Upgrade Co')`,
      );
      const absent = await legacyPool.query<{ present: string | null }>(
        `SELECT to_regclass('brain_evidence.completed_runs')::text AS present`,
      );
      assert.equal(absent.rows[0]!.present, null);
    } finally {
      await legacyPool.end();
    }

    const second = createBrainPool('admin', fresh.url);
    try {
      const upgraded = await bootstrapBrainWorkspaceAuthority(second, authority, {
        runtimeRole: fresh.role,
        runtimePassword: password,
      });
      assert.equal(upgraded.outcome, 'upgraded');
      assert.deepEqual(upgraded.migrations.applied, upgrades.map((file) => file.filename));
      assert.equal(upgraded.databaseAuthorityId, authorityId);
    } finally {
      await second.end();
    }

    const upgradedPool = createVerifiedBrainPool({
      connectionString: fresh.url,
      authority,
      databaseAuthorityId: authorityId,
    });
    const runtimePool = createVerifiedBrainPool({
      connectionString: buildRuntimeUrl(fresh.url, password, runtimeRole!),
      authority,
      databaseAuthorityId: authorityId,
    });
    try {
      const recorded = await recordedLedger(upgradedPool);
      assertExactOrderedPrefix(recorded, files);
      assert.deepEqual(recorded.map((row) => row.filename), files.map((file) => file.filename));

      const survivors = await upgradedPool.query<{ versions: string; entities: string }>(
        `SELECT (SELECT count(*)::text FROM brain.source_versions) AS versions,
                (SELECT count(*)::text FROM brain.entities WHERE slug = 'pre-upgrade-co') AS entities`,
      );
      assert.deepEqual(survivors.rows[0], { versions: '1', entities: '1' });

      // Grants land with the same bootstrap transaction: the runtime role can
      // record evidence immediately after the upgrade, with no re-init step.
      const written = await recordCompletedRun(runtimePool, {
        runId: 'run-after-upgrade',
        functionId: 'social-media',
        agentId: 'manager',
        planId: null,
        host: 'claude',
        hostVersion: '2.0.0',
        requestSummary: 'first run after the evidence upgrade',
        requestHash: `sha256:${'a'.repeat(64)}`,
        startedAt: '2026-08-08T10:00:00.000Z',
        completedAt: '2026-08-08T10:02:00.000Z',
        outcome: 'succeeded',
        privacy: 'internal',
        trust: 'host-asserted',
        sources: [{ kind: 'brain-source-version', sourceVersionId: seededVersionId }],
        tools: [],
        actor: ACTOR,
        provenance: { fixture: 'brain-evidence-upgrade' },
      });
      assert.equal(written.status, 'created');
    } finally {
      await upgradedPool.end();
      await runtimePool.end();
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
    await fresh.drop();
    if (runtimeRole !== undefined) {
      const pool = createBrainPool('admin');
      try {
        await pool.query(`REVOKE "${runtimeRole}" FROM CURRENT_USER`);
        await pool.query(`DROP ROLE IF EXISTS "${runtimeRole}"`);
      } finally {
        await pool.end();
      }
    }
  }
});
