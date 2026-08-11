-- #358: the host-run Dreamer lesson lifecycle.
--
-- Ordering: 013 (#356) -> 014 (#357) -> 015 (#358). The migration ledger is an
-- exact ordered prefix and recorded sha256s are compared on every run
-- (src/lib/persistence/migrate-core.ts), so 013 and 014 can never be edited and
-- 015 can never precede them. Migration FILES are immutable; the TABLES they
-- created are ordinary state a later migration may ALTER, which is what the two
-- amendments to 014-owned state below rest on.
--
-- This migration adds:
--
--   1. Two server-side READ functions -- `dream_effective_policy` and
--      `dream_eligible` -- so the readiness predicate has exactly ONE
--      implementation that #357's status read and #358's brokers share.
--   2. `dream_candidates` (+ the normalized `lesson_agent_key` subject key),
--      `dream_candidate_evidence`, and `lesson_decisions` (+ the subject-governor
--      columns), all append-only.
--   3. Two SECURITY DEFINER lifecycle brokers -- `record_dream_candidate` and
--      `decide_lesson_candidate` -- and the promotion binding that finally
--      discharges the three checks 014's HANDOFF named.
--   4. The filesystem-phase fence `hold_dream_subject_lock` and the read-only
--      governor verifier `verify_dream_subject_governor`.
--   5. Two amendments to 014-owned state: the real-time cooldown anchor and the
--      reservation of the built-in policy version.
--
-- Stable error codes introduced here (013 owns RBE01-RBE04, 014 owns RBE05):
--
--   RBE06 self-evidence citation      RBE10 transition/governance refusal
--   RBE07 snapshot/policy/due-ness    RBE11 privacy-class refusal
--   RBE08 decision binding mismatch   RBE12 isolation above READ COMMITTED
--   RBE09 post-rejection damping
--
-- ---------------------------------------------------------------------------
-- WHY EVERY BROKER GUARDS THE ISOLATION LEVEL
--
-- Every check in this migration is a LOCK-THEN-READ: acquire the subject (and
-- candidate, and watermark) advisory lock, then read the state the decision
-- depends on. That is sound only when a read taken after the lock sees the
-- latest committed state. Under READ COMMITTED each statement takes a FRESH
-- snapshot (014 states the same rule for its backfill); a REPEATABLE READ or
-- SERIALIZABLE snapshot can predate the lock, so a decision could be computed
-- against state a concurrent holder has already replaced. Rather than silently
-- produce a wrong verdict, every broker, the fence, and the verifier REFUSE with
-- RBE12.
--
-- ---------------------------------------------------------------------------
-- LOCK ORDER
--
-- 014's total rank order is unchanged; every dream lock is rank 3. The
-- intra-rank order is fixed everywhere:
--
--   subject (roster.brain.dream.lock.subject.v1, [lesson_agent_key, lesson_id])
--     -> candidate (roster.brain.dream.lock.candidate.v1, [candidate_id])
--       -> watermark (roster.brain.dream.lock.watermark.v1, [scope_key])
--
-- Both brokers take all three up front. `hold_dream_subject_lock` takes ONLY the
-- subject lock -- a strict prefix, so it adds no cycle. `verify_dream_subject_
-- governor` takes NO advisory lock at all, which is what lets the CLI verify a
-- fence while holding a LOCAL lock without ever waiting on a database lock.

-- --- amendment (a): the real-time cooldown anchor -----------------------------
--
-- `advance_dream_watermark`'s INSERT names no `advanced_at` -- it relies on the
-- column DEFAULT -- so changing the default changes what every post-015 advance
-- records with 014's function body untouched. `now()` is TRANSACTION-START time
-- (014 documents the hazard), so a transaction opened hours before a promotion
-- recorded a stale anchor and silently shortened the NEXT cooldown. Nothing pins
-- the old default: the watermark canonical is a closed nine-key set with no
-- `advanced_at` member, so no canonical bytes, replay comparison, or digest
-- changes. Pre-015 rows keep their stamps; none can exist on a supported path
-- because the advance was granted to nobody.

ALTER TABLE brain_evidence.dream_watermarks
  ALTER COLUMN advanced_at SET DEFAULT clock_timestamp();

-- --- amendment (b): reserve the built-in policy version ------------------------
--
-- `DEFAULT_DREAM_POLICY` is a code constant, not a seeded row, and its version
-- string is a legal `policy_version`. Left unreserved, a registered row under
-- that exact version would make "the candidate's policy_version equals the
-- effective policy_version" stop implying "the same policy bytes", which is what
-- the promote-time pin rests on. The preflight fails LOUDLY at migration time on
-- a database that already holds such a row, with a named remediation; the
-- trigger keeps the invariant on every supported path thereafter.
--
-- A trigger rather than a function edit: `register_dream_policy` lives in
-- immutable 014, but a BEFORE INSERT trigger binds to the TABLE and fires for
-- that function's insert too. The custom SQLSTATE propagates uncaught through
-- 014's EXCEPTION block, which catches only standard classes.
--
-- Deliberately NOT a global claim: a superuser can still bypass the trigger with
-- a blanket `ALTER TABLE ... DISABLE TRIGGER USER` or `session_replication_role
-- = replica`. That is the doctored-database class, outside every supported path.

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM brain_evidence.dream_policies
     WHERE policy_version = 'roster.dream.default.v1'
  ) THEN
    RAISE EXCEPTION '015 preflight: policy_version roster.dream.default.v1 is reserved for the built-in default; a stored row exists. Remove it first (ALTER TABLE brain_evidence.dream_policies DISABLE TRIGGER dream_policies_immutable; DELETE ...; ENABLE TRIGGER ...) and re-register it under a different version.';
  END IF;
END;
$do$;

CREATE FUNCTION brain_evidence.reject_reserved_policy_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
BEGIN
  IF NEW.policy_version = 'roster.dream.default.v1' THEN
    RAISE EXCEPTION 'policy_version roster.dream.default.v1 is reserved for the built-in default policy and cannot be registered; choose a new version'
      USING ERRCODE = 'RBE01';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER dream_policies_reserved_version
  BEFORE INSERT ON brain_evidence.dream_policies
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_reserved_policy_version();

-- --- the shared readiness predicate, server-side -------------------------------
--
-- #357 computed the eligible set inside one TypeScript-held CTE. #358 needs the
-- SAME predicate inside two brokers, over a DIFFERENT floor (the candidate's
-- bound snapshot rather than the current watermark), so the predicate moves here
-- with the floor as an explicit parameter and readiness selects from it. One
-- implementation; the parity suite pins the two against each other.

-- Both read functions are SECURITY INVOKER over relations the runtime already
-- holds SELECT on, so each one is deliberately SELF-CONTAINED: a shared scope
-- helper would have to be granted to the runtime as well, widening its
-- executable surface past the exact set the doctor approves. The scope grammar
-- is closed and regex-pinned by 014's CHECK, so the derivations below are total.
--
-- The built-in fallback embeds the SAME literal amendment (b) reserves, so when
-- a candidate's policy_version is the built-in one, effective resolution can
-- only have fallen back to the code constant -- never to a stored row.
--
-- The chain is dreamScopeResolutionChain (dream-contracts.ts) as SQL: the
-- requested scope first, then each broader ancestor, ending at the workspace.
-- POSITION is the precedence, and the parity suite pins the two against each
-- other over the whole grammar.
CREATE FUNCTION brain_evidence.dream_effective_policy(p_scope_key text)
RETURNS TABLE (
  policy_source text,
  policy_version text,
  policy_scope_key text,
  min_completed_runs integer,
  min_feedback_records integer,
  min_signal_mix integer,
  evidence_window interval,
  cooldown interval,
  excluded_agent_ids text[]
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
  WITH parts AS (
    SELECT substring(p_scope_key from '^[a-z]+') AS scope_kind,
           coalesce(substring(p_scope_key from ':(.*)$'), '') AS rest
  ), chain AS (
    SELECT CASE p.scope_kind
             WHEN 'plan' THEN ARRAY[
               p_scope_key,
               'agent:' || split_part(p.rest, '#', 1),
               'function:' || split_part(p.rest, '/', 1),
               'workspace'
             ]
             WHEN 'agent' THEN ARRAY[p_scope_key, 'function:' || split_part(p.rest, '/', 1), 'workspace']
             WHEN 'function' THEN ARRAY[p_scope_key, 'workspace']
             ELSE ARRAY['workspace']
           END AS keys
      FROM parts p
  ), policy_scopes AS (
    SELECT entry.key, entry.rank
      FROM chain, unnest(chain.keys) WITH ORDINALITY AS entry(key, rank)
  ), stored_policy AS (
    SELECT resolved.*
      FROM policy_scopes c
      JOIN LATERAL (
        SELECT 'brain'::text AS policy_source,
               dp.policy_version,
               dp.scope_key AS policy_scope_key,
               dp.min_completed_runs,
               dp.min_feedback_records,
               dp.min_signal_mix,
               dp.evidence_window,
               dp.cooldown,
               dp.excluded_agent_ids
          FROM brain_evidence.dream_policies dp
         WHERE dp.scope_key = c.key
         ORDER BY dp.recorded_at DESC, dp.policy_version DESC
         LIMIT 1
      ) AS resolved ON true
     ORDER BY c.rank
     LIMIT 1
  )
  SELECT * FROM stored_policy
   UNION ALL
  SELECT 'built-in'::text,
         'roster.dream.default.v1'::text,
         'workspace'::text,
         5::integer,
         0::integer,
         0::integer,
         make_interval(secs => 2592000::double precision),
         make_interval(secs => 72000::double precision),
         ARRAY['dreamer']::text[]
   WHERE NOT EXISTS (SELECT 1 FROM stored_policy);
$fn$;

-- The eligible set with the floor as an EXPLICIT parameter: readiness passes the
-- current watermark cursor (byte-identical behavior to #357), the brokers pass
-- the candidate's BOUND snapshot floor. `p_evaluated_at` is the caller's
-- captured instant -- readiness passes its statement's now(), the brokers pass a
-- once-captured clock_timestamp(), because a transaction opened before evidence
-- aged out must not promote against it.
--
-- Feedback carries no scope columns of its own, so every observation is joined
-- to ITS RUN -- directly for a completed-run observation, through the NOT NULL
-- feedback.run_id foreign key for a feedback observation.
--
-- The scope filter is stated as equality against the RECONSTRUCTED scope key
-- rather than a parsed-parts comparison: the grammar is closed and injective, so
-- the two are equivalent, and a run with no plan reconstructs to NULL and is
-- correctly excluded from a plan scope.
CREATE FUNCTION brain_evidence.dream_eligible(
  p_scope_key text,
  p_evaluated_at timestamptz,
  p_floor_ordinal bigint
)
RETURNS TABLE (
  ordinal bigint,
  evidence_kind text,
  run_id text,
  agent_id text,
  outcome text,
  signal text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
  SELECT o.ordinal,
         o.evidence_kind,
         r.run_id,
         r.agent_id,
         r.outcome,
         f.signal
    FROM brain_evidence.evidence_observations o
    LEFT JOIN brain_evidence.feedback f
      ON o.evidence_kind = 'feedback' AND f.feedback_id = o.evidence_id
    JOIN brain_evidence.completed_runs r
      ON r.run_id = CASE WHEN o.evidence_kind = 'completed-run' THEN o.evidence_id ELSE f.run_id END
   CROSS JOIN brain_evidence.dream_effective_policy(p_scope_key) p
   WHERE o.ordinal > p_floor_ordinal
     AND o.recorded_at > p_evaluated_at - p.evidence_window
     AND o.recorded_at <= p_evaluated_at
     AND (
       p_scope_key = 'workspace'
       OR p_scope_key = 'function:' || r.function_id
       OR p_scope_key = 'agent:' || r.function_id || '/' || r.agent_id
       OR p_scope_key = 'plan:' || r.function_id || '/' || r.agent_id || '#' || r.plan_id
     )
     AND NOT (r.agent_id = ANY (p.excluded_agent_ids));
$fn$;

-- --- privileges ---------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION brain_evidence.reject_reserved_policy_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.dream_effective_policy(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.dream_eligible(text, timestamptz, bigint) FROM PUBLIC;
