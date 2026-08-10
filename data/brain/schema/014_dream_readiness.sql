-- #357: durable Dreamer readiness.
--
-- Ordering: 012 (#370) -> 013 (#356) -> 014 (#357). The migration ledger is an
-- exact ordered prefix and recorded sha256s are compared on every run
-- (src/lib/persistence/migrate-core.ts), so 013 can never be edited and 014 can
-- never precede it. #358's dream_candidates / dream_candidate_evidence /
-- lesson_decisions take 015+.
--
-- This migration adds three things to the separate `brain_evidence` schema:
--
--   1. `evidence_observations` -- a COMMIT-ORDERED append-only accumulator over
--      #356's completed runs and feedback. It is the durable answer to v1
--      failure item 1 ("no durable eligibility/observation accumulator").
--   2. `dream_policies` -- versioned, scoped readiness thresholds.
--   3. `dream_watermarks` -- the per-scope processed floor, which advances on
--      promotion only.
--
-- No free-form jsonb anywhere: every column is a closed, typed, regex- or
-- range-checked value, so no credential/control-character leaf scan is needed.
--
-- ---------------------------------------------------------------------------
-- WHY A SEQUENCE UNDER A GLOBAL ADVISORY LOCK
--
-- `recorded_at DEFAULT now()` is TRANSACTION-START time. Two concurrent brokers
-- can commit in the opposite order to their `now()` values, so any recorded_at
-- cursor can permanently bury a row that commits later with an earlier stamp.
-- The rejected alternatives: the row-level `xmin` system column is 32-bit `xid`
-- with no wraparound-safe conversion; `pg_xact_commit_timestamp` needs the
-- `track_commit_timestamp` server GUC, which "any compatible PostgreSQL" cannot
-- promise; other backends' `pg_stat_activity.xact_start` is masked without
-- `pg_read_all_stats`; a bare `nextval` at INSERT has the same out-of-order-
-- commit hole.
--
-- Adopted: one ordinal drawn from a sequence while a single global
-- transaction-scoped advisory lock is held to commit. Assignment order
-- therefore EQUALS commit order.
--
-- ---------------------------------------------------------------------------
-- WHY THE TRIGGER IS A DEFERRED CONSTRAINT TRIGGER (load-bearing)
--
-- Total lock rank order over brain_evidence:
--
--   rank 0  bootstrap/migration advisory lock (bootstrap only)
--   rank 1  per-record evidence locks -- run, artifact, feedback, decision,
--           promotion (taken while statements run)
--   rank 2  THE SINGLE GLOBAL OBSERVATION LOCK (pre-commit phase only)
--   rank 3  dream watermark (per scope) and dream policy locks
--
-- Because the trigger is DEFERRABLE INITIALLY DEFERRED, the rank-2 lock is
-- requested only after the last statement of the transaction, in the pre-commit
-- phase. On Roster's own single-broker autocommit path nothing is acquired
-- after it, so a transaction holding rank 2 has no outgoing wait-for edge and a
-- wait-for cycle through rank 2 is impossible. (Deferred firing does not make
-- rank 2 a transaction's final lock request IN GENERAL -- later deferred
-- constraints, cascading triggers, or SET CONSTRAINTS can acquire locks
-- afterwards -- so the structural claim is scoped to that path, and any broader
-- batching transaction is governed by the retry contract below.)
--
-- An IMMEDIATE trigger would instead take rank 2 in the middle of the run
-- broker's body and hold it across up to 64 run_sources + 64 run_tools inserts
-- and their cross-schema foreign-key checks. Deferral shrinks the critical
-- section to one nextval plus one single-row INSERT. The lock is still held
-- until the outer transaction ends, so a slow commit flush or a client-issued
-- `SET CONSTRAINTS ALL IMMEDIATE` lengthens it (correctness preserved).
--
-- DEADLOCK/RETRY CONTRACT: a `40P01 deadlock_detected` raised by any
-- brain_evidence call is RETRYABLE. Every broker is idempotent by construction
-- (ON CONFLICT DO NOTHING + byte compare), so a replay after an abort converges
-- to `created` or `existing` with no mutation. An aborted transaction leaves
-- only a harmless gap in the ordinal sequence -- gaps are expected and are never
-- interpreted. Retry is the batching caller's responsibility; Roster never
-- batches (evidence-store.ts issues a bare autocommit pool.query and contains no
-- BEGIN/COMMIT), so every Roster evidence write holds exactly one rank-1 lock.
--
-- ---------------------------------------------------------------------------
-- HANDOFF TO #358 (do not lose this)
--
-- advance_dream_watermark ships ADMIN-ONLY and deliberately does NOT verify that
-- the cursor is scope-eligible, equals the computed frontier, or accompanies a
-- promotion. #358 owns the runtime grant and the promotion binding; granting
-- EXECUTE to the runtime role WITHOUT first adding those three checks
-- reintroduces an unauthenticated integrity/availability hole, because the
-- runtime role already holds all four record brokers and can fabricate evidence.

-- --- the commit-ordered durable accumulator ----------------------------------

CREATE SEQUENCE brain_evidence.evidence_observation_ordinal_seq AS bigint START 1;

CREATE TABLE brain_evidence.evidence_observations (
  ordinal bigint PRIMARY KEY,
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('completed-run', 'feedback')),
  evidence_id text NOT NULL CHECK (
    octet_length(evidence_id) BETWEEN 1 AND 256
    AND evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  recorded_at timestamptz NOT NULL,
  CONSTRAINT evidence_observations_identity UNIQUE (evidence_kind, evidence_id)
);

CREATE INDEX evidence_observations_window_idx
  ON brain_evidence.evidence_observations (recorded_at, ordinal);

-- SECURITY DEFINER is kept as DEFENSE IN DEPTH: PostgreSQL preserves the role
-- that queued a deferred event, which here is already the broker's definer role,
-- so definer rights are not strictly necessary -- they are kept so the trigger's
-- privileges never depend on that queuing subtlety, and so an ADMIN-seeded
-- direct INSERT (a legacy/imported row) is observed under the same rights. The
-- function takes no caller input beyond NEW, pins search_path, is PUBLIC-revoked,
-- is granted to nobody, and cannot be called outside a trigger context.
CREATE FUNCTION brain_evidence.observe_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
BEGIN
  -- One global transaction-scoped lock, acquired in the PRE-COMMIT phase and
  -- held until transaction end. Assignment order therefore EQUALS commit order:
  -- to draw ordinal N+1 a writer must first wait for the holder of N to end.
  -- PostgreSQL removes a committing xid from the ProcArray in
  -- RecordTransactionCommit BEFORE ResourceOwnerRelease frees its locks, so by
  -- the time the next writer holds this lock, the previous holder's commit is
  -- already visible to every new snapshot. Consequently, if any reader observes
  -- ordinal M, every ordinal <= M is settled and every committed one among them
  -- is visible in that reader's snapshot; no future write can ever land at or
  -- below M. That is the commit barrier the whole ticket rests on.
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.evidence.lock.observation.v1', ARRAY[]::text[])
  );
  INSERT INTO brain_evidence.evidence_observations
    (ordinal, evidence_kind, evidence_id, workspace_id, recorded_at)
  VALUES (
    nextval('brain_evidence.evidence_observation_ordinal_seq'),
    TG_ARGV[0],
    to_jsonb(NEW) ->> TG_ARGV[1],
    NEW.workspace_id,
    NEW.recorded_at
  );
  RETURN NULL;
END;
$fn$;

-- DEFERRABLE INITIALLY DEFERRED is the single keyword the whole no-deadlock
-- argument rests on. Do not weaken it to a plain AFTER trigger.
CREATE CONSTRAINT TRIGGER completed_runs_observed
  AFTER INSERT ON brain_evidence.completed_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.observe_evidence('completed-run', 'run_id');

CREATE CONSTRAINT TRIGGER feedback_observed
  AFTER INSERT ON brain_evidence.feedback
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.observe_evidence('feedback', 'feedback_id');

-- --- backfill ----------------------------------------------------------------
--
-- Order is load-bearing:
--   (1) BOTH constraint triggers are created FIRST. CREATE CONSTRAINT TRIGGER
--       takes SHARE ROW EXCLUSIVE, which conflicts with the ROW EXCLUSIVE an
--       INSERT holds, so each statement waits out every in-flight writer on its
--       table; and the lock is held to COMMIT, so no new writer can insert until
--       014 lands -- and when it does, its event is queued. There is no window in
--       which a row is inserted with no observation.
--   (2) The isolation level is ASSERTED. The migration runs inside the bootstrap
--       transaction. Under READ COMMITTED each top-level statement takes a FRESH
--       snapshot, so the backfill below sees every writer that committed while
--       the DDL waited. An inherited REPEATABLE READ snapshot, established by
--       earlier bootstrap reads, would predate those waits and could miss such a
--       writer.
--   (3) Ordinals are assigned EXPLICITLY. nextval() in a target list is not
--       guaranteed to be evaluated in ORDER BY order, so row_number() assigns
--       them and setval() then advances the sequence.
--   (4) The sort key is TOTAL. run_id and feedback_id are independent id spaces,
--       so (recorded_at, id) alone is NOT total -- a run and a feedback may share
--       both. evidence_kind breaks the tie, and (kind, id) is unique by
--       construction. COLLATE "C" removes collation dependence.
--
-- Backfilled ordinals are a RECONSTRUCTION, not observed commit order: pre-014
-- history has none. The commit barrier holds strictly for observations created
-- by the triggers; the backfill only guarantees a stable, total,
-- collation-independent order over rows that were all already committed before
-- this DDL returned.

DO $do$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '014 backfill requires READ COMMITTED; got %',
      current_setting('transaction_isolation');
  END IF;
END;
$do$;

WITH pending AS (
  SELECT 'completed-run'::text AS kind, r.run_id AS id, r.workspace_id, r.recorded_at
    FROM brain_evidence.completed_runs r
  UNION ALL
  SELECT 'feedback'::text, f.feedback_id, f.workspace_id, f.recorded_at
    FROM brain_evidence.feedback f
), ordered AS (
  SELECT row_number() OVER (ORDER BY recorded_at, kind COLLATE "C", id COLLATE "C") AS ordinal,
         kind, id, workspace_id, recorded_at
    FROM pending
)
INSERT INTO brain_evidence.evidence_observations
  (ordinal, evidence_kind, evidence_id, workspace_id, recorded_at)
SELECT ordinal, kind, id, workspace_id, recorded_at FROM ordered;

SELECT setval(
  'brain_evidence.evidence_observation_ordinal_seq',
  coalesce((SELECT max(ordinal) FROM brain_evidence.evidence_observations), 0) + 1,
  false
);

-- --- dream policy -------------------------------------------------------------

-- A CHECK cannot contain a subquery, so the list predicate is a function. A NULL
-- element would make `<> ALL (excluded_agent_ids)` suppress EVERY row, which
-- would silently freeze readiness at not_due forever.
CREATE FUNCTION brain_evidence.dream_agent_id_list_ok(p_ids text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT p_ids IS NOT NULL
     AND coalesce(array_ndims(p_ids), 1) = 1
     AND array_position(p_ids, NULL) IS NULL
     AND coalesce(array_length(p_ids, 1), 0) <= 64
     AND NOT EXISTS (
       SELECT 1 FROM unnest(p_ids) AS e WHERE e !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     )
     AND (SELECT count(DISTINCT e) FROM unnest(p_ids) AS e)
         = coalesce(array_length(p_ids, 1), 0);
$fn$;

CREATE TABLE brain_evidence.dream_policies (
  policy_version text PRIMARY KEY CHECK (policy_version ~ '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$'),
  policy_canonical text NOT NULL CHECK (
    octet_length(policy_canonical) <= 16384 AND policy_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  scope_key text NOT NULL CHECK (
    scope_key ~ '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$'
  ),
  min_completed_runs integer NOT NULL CHECK (min_completed_runs BETWEEN 1 AND 10000),
  min_feedback_records integer NOT NULL CHECK (min_feedback_records BETWEEN 0 AND 10000),
  min_signal_mix integer NOT NULL CHECK (min_signal_mix BETWEEN 0 AND 10000),
  evidence_window interval NOT NULL CHECK (
    evidence_window BETWEEN interval '1 hour' AND interval '365 days'
  ),
  cooldown interval NOT NULL CHECK (cooldown BETWEEN interval '0' AND interval '30 days'),
  excluded_agent_ids text[] NOT NULL CHECK (
    brain_evidence.dream_agent_id_list_ok(excluded_agent_ids)
  ),
  activation_assurance text NOT NULL CHECK (
    activation_assurance IN ('system-derived', 'human-confirmed')
  ),
  registered_by text NOT NULL CHECK (
    octet_length(registered_by) BETWEEN 1 AND 256 AND registered_by !~ '[[:cntrl:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dream_policies_scope_idx
  ON brain_evidence.dream_policies (scope_key, recorded_at DESC);

-- workspace_id is OVERWRITTEN, not validated, so even a direct admin INSERT
-- cannot record a foreign workspace.
CREATE FUNCTION brain_evidence.derive_dream_workspace()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
BEGIN
  NEW.workspace_id := brain_evidence.workspace_identity_id();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dream_policies_workspace
  BEFORE INSERT ON brain_evidence.dream_policies
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.derive_dream_workspace();

-- --- dream watermark ----------------------------------------------------------

CREATE TABLE brain_evidence.dream_watermarks (
  scope_key text NOT NULL CHECK (
    scope_key ~ '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$'
  ),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 16384 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  cursor_ordinal bigint NOT NULL CHECK (cursor_ordinal >= 1)
    REFERENCES brain_evidence.evidence_observations(ordinal),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$'),
  reason text NOT NULL CHECK (reason = 'promotion'),
  consumed_completed_runs bigint NOT NULL CHECK (consumed_completed_runs >= 0),
  consumed_feedback_records bigint NOT NULL CHECK (consumed_feedback_records >= 0),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  advanced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_key, sequence)
);

CREATE UNIQUE INDEX dream_watermarks_cursor_identity
  ON brain_evidence.dream_watermarks (scope_key, cursor_ordinal);

CREATE TRIGGER dream_watermarks_workspace
  BEFORE INSERT ON brain_evidence.dream_watermarks
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.derive_dream_workspace();

-- --- admin-only writers -------------------------------------------------------
--
-- Both are plain SECURITY INVOKER: definer == caller == admin, so SECURITY
-- DEFINER would be pointless and strictly riskier. Both are PUBLIC-revoked and
-- granted to NOBODY. The policy decides when the learning loop fires and the
-- runtime pool processes untrusted tool output, so keeping policy admin-only is
-- what stops an agent from lowering the bar it must clear.

CREATE FUNCTION brain_evidence.register_dream_policy(p_policy_canonical text)
RETURNS TABLE (status text, policy_version text)
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
-- The RETURNS TABLE column names are also table column names, so an unqualified
-- identifier -- `ON CONFLICT (policy_version)` in particular, whose conflict
-- target cannot be table-qualified -- would be ambiguous. Every local is v_
-- prefixed, so resolving toward the column is always the intended reading.
#variable_conflict use_column
DECLARE
  v_doc jsonb;
  v_policy_version text;
  v_stored text;
  v_inserted integer;
  v_element jsonb;
BEGIN
  IF p_policy_canonical IS NULL OR octet_length(p_policy_canonical) > 16384 THEN
    PERFORM brain_evidence.reject_evidence_input('the dream policy exceeds its canonical byte cap');
  END IF;
  v_doc := p_policy_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'activation_assurance', 'cooldown_seconds', 'evidence_window_seconds',
    'excluded_agent_ids', 'kind', 'min_completed_runs', 'min_feedback_records',
    'min_signal_mix', 'policy_version', 'registered_by', 'schema_version',
    'scope_key'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['dream-policy']);
  PERFORM brain_evidence.assert_integer(v_doc, 'schema_version', 1, 1);
  PERFORM brain_evidence.assert_text(
    v_doc, 'policy_version', 256, '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$', false);
  PERFORM brain_evidence.assert_text(
    v_doc, 'scope_key', 256,
    '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$',
    false);
  PERFORM brain_evidence.assert_integer(v_doc, 'min_completed_runs', 1, 10000);
  PERFORM brain_evidence.assert_integer(v_doc, 'min_feedback_records', 0, 10000);
  PERFORM brain_evidence.assert_integer(v_doc, 'min_signal_mix', 0, 10000);
  PERFORM brain_evidence.assert_integer(v_doc, 'evidence_window_seconds', 3600, 31536000);
  PERFORM brain_evidence.assert_integer(v_doc, 'cooldown_seconds', 0, 2592000);
  PERFORM brain_evidence.assert_member(
    v_doc, 'activation_assurance', ARRAY['system-derived', 'human-confirmed']);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'registered_by', 256, false);
  IF jsonb_typeof(v_doc->'excluded_agent_ids') <> 'array'
     OR jsonb_array_length(v_doc->'excluded_agent_ids') > 64 THEN
    PERFORM brain_evidence.reject_evidence_input(
      'excluded_agent_ids must be an array of at most 64 agent ids');
  END IF;
  FOR v_element IN SELECT value FROM jsonb_array_elements(v_doc->'excluded_agent_ids') LOOP
    IF jsonb_typeof(v_element) <> 'string'
       OR (v_element #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
      PERFORM brain_evidence.reject_evidence_input('excluded_agent_ids holds an unsupported agent id');
    END IF;
  END LOOP;

  v_policy_version := v_doc->>'policy_version';
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.dream.lock.policy.v1', ARRAY[v_policy_version])
  );

  INSERT INTO brain_evidence.dream_policies (
    policy_version, policy_canonical, workspace_id, scope_key, min_completed_runs,
    min_feedback_records, min_signal_mix, evidence_window, cooldown,
    excluded_agent_ids, activation_assurance, registered_by
  ) VALUES (
    v_policy_version,
    p_policy_canonical,
    'derived-by-trigger',
    v_doc->>'scope_key',
    (v_doc->>'min_completed_runs')::integer,
    (v_doc->>'min_feedback_records')::integer,
    (v_doc->>'min_signal_mix')::integer,
    make_interval(secs => (v_doc->>'evidence_window_seconds')::double precision),
    make_interval(secs => (v_doc->>'cooldown_seconds')::double precision),
    ARRAY(SELECT jsonb_array_elements_text(v_doc->'excluded_agent_ids')),
    v_doc->>'activation_assurance',
    v_doc->>'registered_by'
  )
  ON CONFLICT (policy_version) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'created'::text, v_policy_version;
    RETURN;
  END IF;

  SELECT stored.policy_canonical INTO v_stored
    FROM brain_evidence.dream_policies stored WHERE stored.policy_version = v_policy_version;
  IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_policy_canonical, 'UTF8') THEN
    RAISE EXCEPTION 'a different dream policy is already registered under this version'
      USING ERRCODE = 'RBE02';
  END IF;
  RETURN QUERY SELECT 'existing'::text, v_policy_version;
EXCEPTION
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the dream policy violates the closed policy schema' USING ERRCODE = 'RBE01';
END;
$fn$;

-- #358 MUST add, before granting this to the runtime role: (a) the cursor is
-- eligible for that scope, (b) the cursor equals the computed frontier, and
-- (c) the advance accompanies a promotion identity. `reason = 'promotion'` is a
-- single-value CHECK, which makes a non-promotion advance unrepresentable today
-- but is not a substitute for those three checks.
CREATE FUNCTION brain_evidence.advance_dream_watermark(p_record_canonical text)
RETURNS TABLE (status text, scope_key text, sequence bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
-- See register_dream_policy: `scope_key` and `sequence` name both a RETURNS
-- TABLE column and a dream_watermarks column. Every local is v_ prefixed.
#variable_conflict use_column
DECLARE
  v_doc jsonb;
  v_scope_key text;
  v_cursor bigint;
  v_stored text;
  v_sequence bigint;
  v_max_cursor bigint;
  v_next_sequence bigint;
BEGIN
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 16384 THEN
    PERFORM brain_evidence.reject_evidence_input('the watermark record exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'actor_assurance', 'consumed_completed_runs', 'consumed_feedback_records',
    'cursor_ordinal', 'kind', 'policy_version', 'reason', 'schema_version', 'scope_key'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['dream-watermark']);
  PERFORM brain_evidence.assert_integer(v_doc, 'schema_version', 1, 1);
  PERFORM brain_evidence.assert_text(
    v_doc, 'scope_key', 256,
    '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$',
    false);
  PERFORM brain_evidence.assert_integer(v_doc, 'cursor_ordinal', 1, 9223372036854775807);
  PERFORM brain_evidence.assert_text(
    v_doc, 'policy_version', 256, '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$', false);
  PERFORM brain_evidence.assert_member(v_doc, 'reason', ARRAY['promotion']);
  PERFORM brain_evidence.assert_integer(v_doc, 'consumed_completed_runs', 0, 9223372036854775807);
  PERFORM brain_evidence.assert_integer(v_doc, 'consumed_feedback_records', 0, 9223372036854775807);
  PERFORM brain_evidence.assert_member(
    v_doc, 'actor_assurance',
    ARRAY['system-derived', 'caller-asserted', 'host-attested', 'human-confirmed']);

  v_scope_key := v_doc->>'scope_key';
  v_cursor := (v_doc->>'cursor_ordinal')::bigint;
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.dream.lock.watermark.v1', ARRAY[v_scope_key])
  );

  -- Replay is arbitrated BEFORE the rewind refusal: a byte-identical replay of
  -- the current head sits at cursor = max and would otherwise read as a rewind.
  SELECT stored.record_canonical, stored.sequence INTO v_stored, v_sequence
    FROM brain_evidence.dream_watermarks stored
   WHERE stored.scope_key = v_scope_key AND stored.cursor_ordinal = v_cursor;
  IF v_stored IS NOT NULL THEN
    IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
      RAISE EXCEPTION 'a different dream watermark is already recorded at this cursor'
        USING ERRCODE = 'RBE02';
    END IF;
    RETURN QUERY SELECT 'existing'::text, v_scope_key, v_sequence;
    RETURN;
  END IF;

  SELECT max(stored.cursor_ordinal), coalesce(max(stored.sequence), 0) + 1
    INTO v_max_cursor, v_next_sequence
    FROM brain_evidence.dream_watermarks stored WHERE stored.scope_key = v_scope_key;
  IF v_max_cursor IS NOT NULL AND v_cursor <= v_max_cursor THEN
    RAISE EXCEPTION 'the dream watermark may never move backward' USING ERRCODE = 'RBE05';
  END IF;

  INSERT INTO brain_evidence.dream_watermarks (
    scope_key, sequence, record_canonical, workspace_id, cursor_ordinal,
    policy_version, reason, consumed_completed_runs, consumed_feedback_records,
    actor_assurance
  ) VALUES (
    v_scope_key,
    v_next_sequence,
    p_record_canonical,
    'derived-by-trigger',
    v_cursor,
    v_doc->>'policy_version',
    v_doc->>'reason',
    (v_doc->>'consumed_completed_runs')::bigint,
    (v_doc->>'consumed_feedback_records')::bigint,
    v_doc->>'actor_assurance'
  );
  RETURN QUERY SELECT 'created'::text, v_scope_key, v_next_sequence;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'the dream watermark cursor is not a recorded observation'
      USING ERRCODE = 'RBE03';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the dream watermark violates the closed watermark schema'
      USING ERRCODE = 'RBE01';
END;
$fn$;

-- --- append-only enforcement --------------------------------------------------
--
-- evidence_observations is append-only too: on Roster's supported paths, only
-- the SECURITY DEFINER observe_evidence() and this migration's backfill ever
-- insert into it (the trusted database owner can always insert directly or move
-- the sequence -- no in-database defense exists against the owner), and
-- reject_evidence_mutation() raises unconditionally -- for the admin as well --
-- so a queued deferred trigger event can never reference a row deleted before it
-- fires.

CREATE TRIGGER evidence_observations_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.evidence_observations
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER evidence_observations_no_truncate
  BEFORE TRUNCATE ON brain_evidence.evidence_observations
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER dream_policies_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.dream_policies
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER dream_policies_no_truncate
  BEFORE TRUNCATE ON brain_evidence.dream_policies
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER dream_watermarks_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.dream_watermarks
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER dream_watermarks_no_truncate
  BEFORE TRUNCATE ON brain_evidence.dream_watermarks
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

-- --- privileges ---------------------------------------------------------------

REVOKE ALL PRIVILEGES ON brain_evidence.evidence_observations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.dream_policies FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.dream_watermarks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE brain_evidence.evidence_observation_ordinal_seq FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION brain_evidence.observe_evidence() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.derive_dream_workspace() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.dream_agent_id_list_ok(text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.register_dream_policy(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.advance_dream_watermark(text) FROM PUBLIC;
