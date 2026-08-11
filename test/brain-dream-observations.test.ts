import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { loadMigrations, schemaDir } from '../src/lib/brain/migrate.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
} from '../src/lib/brain/workspace-authority.ts';
import { recordCompletedRun, recordFeedback } from '../src/lib/brain/evidence-store.ts';
import { createFreshDb, HAS_DB } from './brain-helpers.ts';
import {
  brainConfig,
  createEvidenceFixture,
  seedFeedbackCanonical,
  seedFeedbackInput,
  seedRunCanonical,
  seedRunInput,
} from './support/brain-evidence-fixture.ts';

const WORKSPACE_ID = 'dream-observation-test';
const BACKFILL_WORKSPACE_ID = 'dream-backfill-test';
const options = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set', timeout: 300_000 };

// The deleted Revision-2 design proposed a wall-clock "advance stability lag" of
// a few seconds. The blocked-writer proof holds a transaction open for longer
// than that would have been, so the control assertion below shows a 5s lag would
// have admitted a writer whose ordinal had not yet been drawn.
const DELETED_STABILITY_LAG_MS = 5_000;
const HOLD_MS = 10_000;

type SequenceState = { last_value: string; is_called: boolean };

async function sequenceState(pool: { query: (t: string) => Promise<{ rows: SequenceState[] }> }) {
  return (await pool.query(
    `SELECT last_value::text AS last_value, is_called FROM brain_evidence.evidence_observation_ordinal_seq`,
  )).rows[0]!;
}

async function rawClient(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function ordinalOf(
  pool: { query: <T extends pg.QueryResultRow>(t: string, v: unknown[]) => Promise<{ rows: T[] }> },
  kind: string,
  id: string,
): Promise<number | null> {
  const rows = await pool.query<{ ordinal: string }>(
    `SELECT ordinal::text AS ordinal FROM brain_evidence.evidence_observations
      WHERE evidence_kind = $1 AND evidence_id = $2`,
    [kind, id],
  );
  return rows.rows[0] === undefined ? null : Number(rows.rows[0].ordinal);
}

test('evidence observations are drawn in commit order by a deferred trigger', options, async (t) => {
  const fixture = await createEvidenceFixture(WORKSPACE_ID);
  try {
    await t.test('the ordinal is drawn at COMMIT, not inside the broker body', async () => {
      const before = await sequenceState(fixture.admin);
      const holder = await rawClient(fixture.runtimeUrl);
      let overtaker: number | null = null;
      let holderOrdinal: number | null = null;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [
          seedRunCanonical('run-deferred-holder'),
        ]);
        // The broker inserted; a DEFERRED constraint trigger has only QUEUED its
        // event, so no ordinal has been drawn and the global lock is not held.
        assert.deepEqual(await sequenceState(fixture.admin), before);

        // ...and a second writer therefore records AND COMMITS without blocking,
        // even though the holder's transaction is still open. This is the whole
        // point of the deferral: the critical section is one nextval plus one
        // single-row INSERT immediately before commit.
        await recordCompletedRun(fixture.runtime, seedRunInput('run-deferred-overtaker'));
        overtaker = await ordinalOf(fixture.admin, 'completed-run', 'run-deferred-overtaker');
        assert.notEqual(overtaker, null);
        assert.equal(await ordinalOf(fixture.admin, 'completed-run', 'run-deferred-holder'), null);

        await holder.query('COMMIT');
        holderOrdinal = await ordinalOf(fixture.admin, 'completed-run', 'run-deferred-holder');
      } finally {
        await holder.end();
      }
      // Ordinal order IS commit order: the holder INSERTED first and still
      // received the HIGHER ordinal, because it committed second.
      assert.notEqual(holderOrdinal, null);
      assert.equal(overtaker! < holderOrdinal!, true, `${overtaker} < ${holderOrdinal}`);
    });

    await t.test('SET CONSTRAINTS ALL IMMEDIATE blocks the next writer until commit', async () => {
      const holder = await rawClient(fixture.runtimeUrl);
      const waiter = await rawClient(fixture.runtimeUrl);
      let elapsed = 0;
      try {
        await holder.query('BEGIN');
        await holder.query('SET CONSTRAINTS ALL IMMEDIATE');
        const started = Date.now();
        await holder.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [
          seedRunCanonical('run-immediate-holder'),
        ]);
        // Firing immediately DOES take the global lock inside the statement, so
        // the sequence has already moved and the holder owns rank 2 for the rest
        // of its transaction.
        const held = await sequenceState(fixture.admin);
        assert.equal(held.is_called, true);

        let waiterSettled = false;
        const waiterPromise = (async () => {
          await waiter.query('BEGIN');
          await waiter.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [
            seedRunCanonical('run-immediate-waiter'),
          ]);
          await waiter.query('COMMIT');
        })().then(() => { waiterSettled = true; });

        await sleep(HOLD_MS);
        elapsed = Date.now() - started;
        // The waiter's DEFERRED trigger fires at its own COMMIT and blocks there.
        assert.equal(waiterSettled, false, 'the waiter must block on the observation lock');
        assert.equal(
          await ordinalOf(fixture.admin, 'completed-run', 'run-immediate-waiter'),
          null,
        );

        await holder.query('COMMIT');
        await waiterPromise;
      } finally {
        await holder.end();
        await waiter.end();
      }
      // Control: the deleted wall-clock stability lag would have declared the
      // waiter's evidence settled while its ordinal had not yet been drawn.
      assert.equal(elapsed > DELETED_STABILITY_LAG_MS, true, `held for ${elapsed}ms`);
      const holderOrdinal = await ordinalOf(fixture.admin, 'completed-run', 'run-immediate-holder');
      const waiterOrdinal = await ordinalOf(fixture.admin, 'completed-run', 'run-immediate-waiter');
      assert.equal(holderOrdinal! < waiterOrdinal!, true, `${holderOrdinal} < ${waiterOrdinal}`);
    });

    await t.test('an observed maximum is always a safe barrier under 20 concurrent writers — gap-free-fixture sanity check; the deferral and blocked-writer tests above carry the commit-order proof', async () => {
      const baseline = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations`,
      );
      const before = Number(baseline.rows[0]!.n);
      let polling = true;
      const samples: string[] = [];
      const poller = (async () => {
        while (polling) {
          const row = await fixture.admin.query<{ n: string; m: string }>(
            `SELECT count(*)::text AS n, coalesce(max(ordinal), 0)::text AS m
               FROM brain_evidence.evidence_observations`,
          );
          samples.push(`${row.rows[0]!.n}/${row.rows[0]!.m}`);
          // The barrier: if a reader observes ordinal M, every ordinal <= M is
          // already settled and visible, so the count can never lag the maximum.
          assert.equal(row.rows[0]!.n, row.rows[0]!.m, 'a gap appeared below the observed maximum');
        }
      })();

      await Promise.all(Array.from({ length: 20 }, async (_unused, index) => {
        await sleep(Math.floor(Math.random() * 40));
        await recordCompletedRun(fixture.runtime, seedRunInput(`run-concurrent-${index}`));
      }));
      polling = false;
      await poller;
      assert.equal(samples.length > 0, true);

      const after = await fixture.admin.query<{ n: string; m: string }>(
        `SELECT count(*)::text AS n, max(ordinal)::text AS m FROM brain_evidence.evidence_observations`,
      );
      assert.equal(Number(after.rows[0]!.n), before + 20);
      assert.equal(Number(after.rows[0]!.m), before + 20);
    });

    await t.test('an equivalent replay creates no observation and burns no ordinal', async () => {
      await recordCompletedRun(fixture.runtime, seedRunInput('run-replay'));
      const before = await sequenceState(fixture.admin);
      const beforeCount = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations`,
      );
      const replay = await recordCompletedRun(fixture.runtime, seedRunInput('run-replay'));
      assert.equal(replay.status, 'existing');
      // ON CONFLICT DO NOTHING inserts no row, so no AFTER-ROW event is queued.
      assert.deepEqual(await sequenceState(fixture.admin), before);
      const afterCount = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations`,
      );
      assert.equal(afterCount.rows[0]!.n, beforeCount.rows[0]!.n);
    });

    await t.test('the deferred trigger observes runtime AND admin-seeded writes', async () => {
      // A runtime broker call already covers the privilege half: the deferred
      // event fires when the broker's SECURITY DEFINER context is gone, and the
      // runtime role holds only SELECT on evidence_observations.
      await recordCompletedRun(fixture.runtime, seedRunInput('run-privilege'));
      assert.notEqual(await ordinalOf(fixture.admin, 'completed-run', 'run-privilege'), null);
      await recordFeedback(fixture.runtime, seedFeedbackInput('fb-privilege', 'run-privilege'));
      assert.notEqual(await ordinalOf(fixture.admin, 'feedback', 'fb-privilege'), null);

      // A legacy/imported row seeded straight through the admin is observed too.
      await fixture.admin.query(
        `INSERT INTO brain_evidence.completed_runs (
           run_id, record_canonical, workspace_id, function_id, agent_id, plan_id,
           host, host_version, roster_version, request_summary, request_hash,
           started_at, completed_at, outcome, privacy_class, trust_class,
           actor_assurance, assurance_evidence, provenance
         ) VALUES (
           'run-admin-seeded', '{}', $1, 'social-media', 'manager', NULL,
           'codex', '0.51.0', '1.0.0', 'an admin-seeded legacy row', $2,
           now(), now(), 'succeeded', 'internal', 'legacy-unverified',
           'system-derived', '{}'::jsonb, '{}'::jsonb
         )`,
        [WORKSPACE_ID, `sha256:${'b'.repeat(64)}`],
      );
      assert.notEqual(await ordinalOf(fixture.admin, 'completed-run', 'run-admin-seeded'), null);
    });

    await t.test('every observation copies its source row and stays append-only', async () => {
      const divergent = await fixture.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM brain_evidence.evidence_observations o
           LEFT JOIN brain_evidence.completed_runs r
             ON o.evidence_kind = 'completed-run' AND r.run_id = o.evidence_id
           LEFT JOIN brain_evidence.feedback f
             ON o.evidence_kind = 'feedback' AND f.feedback_id = o.evidence_id
          WHERE o.recorded_at IS DISTINCT FROM coalesce(r.recorded_at, f.recorded_at)
             OR o.workspace_id IS DISTINCT FROM coalesce(r.workspace_id, f.workspace_id)`,
      );
      assert.equal(divergent.rows[0]!.n, '0');

      const identity = await fixture.admin.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'brain_evidence' AND indexname = 'evidence_observations_identity'`,
      );
      assert.match(identity.rows[0]!.indexdef, /UNIQUE.*\(evidence_kind, evidence_id\)/u);

      for (const pool of [fixture.admin, fixture.runtime]) {
        for (const statement of [
          `UPDATE brain_evidence.evidence_observations SET ordinal = ordinal + 1000`,
          `DELETE FROM brain_evidence.evidence_observations`,
          `TRUNCATE brain_evidence.evidence_observations`,
        ]) {
          await assert.rejects(pool.query(statement), (error: unknown) => {
            const code = (error as { code?: string }).code;
            // 42501: the runtime role holds no such privilege at all.
            // 0A000: TRUNCATE is refused outright because dream_watermarks
            //        references the ordinal, i.e. the row cannot be erased even
            //        before the append-only trigger is reached.
            return code === '42501' || code === '0A000'
              || /append-only/u.test((error as Error).message);
          }, statement);
        }
      }
    });
  } finally {
    await fixture.close();
  }
});

test('the 40P01 deadlock contract holds for a batching caller and never for Roster', options, async (t) => {
  const fixture = await createEvidenceFixture('dream-deadlock-test');
  try {
    await recordCompletedRun(fixture.runtime, seedRunInput('run-anchor'));

    await t.test('two batching transactions in opposite order abort on a rank-1 lock', async () => {
      const left = await rawClient(fixture.runtimeUrl);
      const right = await rawClient(fixture.runtimeUrl);
      const runCanonical = seedRunCanonical('run-deadlock');
      const feedbackCanonical = seedFeedbackCanonical('fb-deadlock', 'run-anchor');
      let deadlock: (Error & { code?: string; detail?: string }) | undefined;
      let deadlockAtStatement = false;
      try {
        await left.query('BEGIN');
        await right.query('BEGIN');
        // Rank-1 locks only, taken WHILE statements run, in opposite order.
        await left.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [runCanonical]);
        await right.query('SELECT status, id FROM brain_evidence.record_feedback($1)', [feedbackCanonical]);

        const leftSecond = left
          .query('SELECT status, id FROM brain_evidence.record_feedback($1)', [feedbackCanonical])
          .then(() => null, (error: Error) => error);
        const rightSecond = right
          .query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [runCanonical])
          .then(() => null, (error: Error) => error);
        const [leftError, rightError] = await Promise.all([leftSecond, rightSecond]);
        deadlock = (leftError ?? rightError) as Error & { code?: string; detail?: string };
        deadlockAtStatement = deadlock !== undefined && deadlock !== null;
        await left.query('COMMIT').catch(() => left.query('ROLLBACK').catch(() => {}));
        await right.query('COMMIT').catch(() => right.query('ROLLBACK').catch(() => {}));
      } finally {
        await left.end();
        await right.end();
      }
      assert.equal(deadlockAtStatement, true, 'expected one side to abort');
      assert.equal(deadlock!.code, '40P01');
      // Raised BY THE STATEMENT, not by COMMIT: the cycle is among rank-1 locks
      // taken while statements ran. #357's rank-2 lock is only ever requested in
      // the pre-commit phase, so it can hold no outgoing wait-for edge.
      assert.match(String(deadlock!.detail ?? ''), /advisory lock/u);

      // Every broker is idempotent, so a plain retry after the abort converges.
      const retryRun = await recordCompletedRun(fixture.runtime, seedRunInput('run-deadlock'));
      assert.equal(retryRun.status === 'created' || retryRun.status === 'existing', true);
      const retryFeedback = await recordFeedback(
        fixture.runtime,
        seedFeedbackInput('fb-deadlock', 'run-anchor'),
      );
      assert.equal(retryFeedback.status === 'created' || retryFeedback.status === 'existing', true);

      const ledger = await fixture.admin.query<{ n: string; m: string; distinct: string }>(
        `SELECT count(*)::text AS n, max(ordinal)::text AS m, count(DISTINCT ordinal)::text AS distinct
           FROM brain_evidence.evidence_observations`,
      );
      // Monotone with at most harmless sequence gaps: ordinals stay unique and
      // never exceed what the sequence has issued.
      assert.equal(ledger.rows[0]!.n, ledger.rows[0]!.distinct);
      assert.equal(Number(ledger.rows[0]!.m) >= Number(ledger.rows[0]!.n), true);
    });

    await t.test('200 interleavings of the Roster pattern never deadlock', async () => {
      // Roster's own path is one broker call per autocommit transaction, so a
      // transaction holds exactly one rank-1 lock and can join no cycle.
      const failures: string[] = [];
      await Promise.all(Array.from({ length: 200 }, async (_unused, index) => {
        await sleep(Math.floor(Math.random() * 25));
        try {
          if (index % 2 === 0) {
            await recordCompletedRun(fixture.runtime, seedRunInput(`run-control-${index}`));
          } else {
            await recordFeedback(
              fixture.runtime,
              seedFeedbackInput(`fb-control-${index}`, 'run-anchor'),
            );
          }
        } catch (error) {
          failures.push(String((error as { code?: string }).code ?? (error as Error).message));
        }
      }));
      assert.deepEqual(failures, []);
    });
  } finally {
    await fixture.close();
  }
});

test('the 014 backfill reconstructs a total, deterministic, gap-free order', options, async (t) => {
  const files = loadMigrations(schemaDir());
  const legacy = files.filter((file) => Number.parseInt(file.filename.split('_', 1)[0]!, 10) <= 13);
  assert.equal(legacy.at(-1)!.filename, '013_evidence_core.sql');
  // 014 is the migration under test; later migrations may follow it, so this
  // pins its presence and position after 013 rather than "014 is last".
  assert.equal(files[legacy.length]!.filename, '014_dream_readiness.sql');

  const staged = mkdtempSync(join(tmpdir(), 'roster-brain-013-'));
  for (const file of legacy) cpSync(join(schemaDir(), file.filename), join(staged, file.filename));

  // A run and a feedback that share BOTH recorded_at and id text: the only pair
  // that makes (recorded_at, id) non-total, so evidence_kind must break the tie.
  async function seedThirteen(
    url: string,
    workspaceId: string,
    roleBase: string,
  ): Promise<string> {
    const authority = deriveBrainWorkspaceAuthority(workspaceId, brainConfig(workspaceId));
    const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
    const bootstrap = createBrainPool('admin', url);
    let roleName: string;
    try {
      const result = await bootstrapBrainWorkspaceAuthority(bootstrap, authority, {
        runtimeRole: roleBase,
        runtimePassword: password,
        migrationsDir: staged,
      });
      roleName = result.role.roleName;
    } finally {
      await bootstrap.end();
    }
    const pool = createVerifiedBrainPool({ connectionString: url, authority });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const id of ['collide', 'alpha', 'zulu']) {
          await client.query('SELECT status, id FROM brain_evidence.record_completed_run($1)', [
            seedRunCanonical(id),
          ]);
        }
        // Same transaction => identical `now()` => identical recorded_at.
        await client.query('SELECT status, id FROM brain_evidence.record_feedback($1)', [
          seedFeedbackCanonical('collide', 'collide'),
        ]);
        await client.query('SELECT status, id FROM brain_evidence.record_feedback($1)', [
          seedFeedbackCanonical('alpha', 'alpha'),
        ]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const shared = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM brain_evidence.completed_runs r
           JOIN brain_evidence.feedback f
             ON f.feedback_id = r.run_id AND f.recorded_at = r.recorded_at`,
      );
      assert.equal(shared.rows[0]!.n, '2', 'the collision fixture must share recorded_at and id text');
      const absent = await pool.query<{ present: string | null }>(
        `SELECT to_regclass('brain_evidence.evidence_observations')::text AS present`,
      );
      assert.equal(absent.rows[0]!.present, null);
    } finally {
      await pool.end();
    }
    return roleName;
  }

  async function upgradeAndRead(
    url: string,
    workspaceId: string,
    roleBase: string,
  ): Promise<string[]> {
    const authority = deriveBrainWorkspaceAuthority(workspaceId, brainConfig(workspaceId));
    const password = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
    const pool = createBrainPool('admin', url);
    try {
      const upgraded = await bootstrapBrainWorkspaceAuthority(pool, authority, {
        runtimeRole: roleBase,
        runtimePassword: password,
      });
      // 014 is the migration under test; every later migration applies in the
      // same upgrade, so this pins that 014 leads the applied set.
      assert.equal(upgraded.migrations.applied[0], '014_dream_readiness.sql');
    } finally {
      await pool.end();
    }
    const verified = createVerifiedBrainPool({ connectionString: url, authority });
    try {
      const rows = await verified.query<{ ordinal: string; evidence_kind: string; evidence_id: string }>(
        `SELECT ordinal::text AS ordinal, evidence_kind, evidence_id
           FROM brain_evidence.evidence_observations ORDER BY ordinal`,
      );
      const total = await verified.query<{ runs: string; feedback: string; gaps: string }>(
        `SELECT (SELECT count(*)::text FROM brain_evidence.completed_runs) AS runs,
                (SELECT count(*)::text FROM brain_evidence.feedback) AS feedback,
                (SELECT (max(ordinal) - count(*))::text FROM brain_evidence.evidence_observations) AS gaps`,
      );
      assert.equal(rows.rows.length, Number(total.rows[0]!.runs) + Number(total.rows[0]!.feedback));
      assert.equal(total.rows[0]!.gaps, '0', 'the backfill must leave no ordinal gap');
      // setval() left the sequence at max + 1, so the first live observation
      // continues the reconstruction rather than colliding with it.
      const next = await verified.query<{ next: string }>(
        `SELECT nextval('brain_evidence.evidence_observation_ordinal_seq')::text AS next`,
      );
      assert.equal(Number(next.rows[0]!.next), rows.rows.length + 1);
      return rows.rows.map((row) => `${row.ordinal}:${row.evidence_kind}:${row.evidence_id}`);
    } finally {
      await verified.end();
    }
  }

  const first = await createFreshDb();
  const second = await createFreshDb();
  const roles: string[] = [];
  try {
    roles.push(await seedThirteen(first.url, BACKFILL_WORKSPACE_ID, first.role));
    roles.push(await seedThirteen(second.url, BACKFILL_WORKSPACE_ID, second.role));

    await t.test('the reconstruction is deterministic across repeated fresh migrations', async () => {
      const left = await upgradeAndRead(first.url, BACKFILL_WORKSPACE_ID, first.role);
      const right = await upgradeAndRead(second.url, BACKFILL_WORKSPACE_ID, second.role);
      assert.deepEqual(left, right);
      // (recorded_at, kind, id COLLATE "C") is total: the colliding pair is
      // ordered by kind, and 'completed-run' sorts before 'feedback'.
      const collide = left.filter((entry) => entry.endsWith(':collide'));
      assert.equal(collide.length, 2);
      assert.match(collide[0]!, /:completed-run:collide$/u);
      assert.match(collide[1]!, /:feedback:collide$/u);
      assert.equal(Number(collide[0]!.split(':')[0]) < Number(collide[1]!.split(':')[0]), true);
    });

    await t.test('the backfill refuses to run under REPEATABLE READ', async () => {
      const third = await createFreshDb();
      let role: string | undefined;
      try {
        role = await seedThirteen(third.url, BACKFILL_WORKSPACE_ID, third.role);
        const sql = readFileSync(join(schemaDir(), '014_dream_readiness.sql'), 'utf8');
        const client = await rawClient(third.url);
        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(client.query(sql), /READ COMMITTED/u);
          await client.query('ROLLBACK');
          // The identical statement under READ COMMITTED applies cleanly, so the
          // refusal is the isolation assertion and nothing else.
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
          const observed = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM brain_evidence.evidence_observations`,
          );
          assert.equal(Number(observed.rows[0]!.n) > 0, true);
        } finally {
          await client.end();
        }
      } finally {
        await third.drop();
        if (role !== undefined) await dropTestRole(role);
      }
    });
  } finally {
    rmSync(staged, { recursive: true, force: true });
    await first.drop();
    await second.drop();
    for (const role of roles) await dropTestRole(role);
  }
});

async function dropTestRole(roleName: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName)) return;
  const pool = createBrainPool('admin');
  try {
    await pool.query(`REVOKE "${roleName}" FROM CURRENT_USER`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => {});
  } finally {
    await pool.end();
  }
}
