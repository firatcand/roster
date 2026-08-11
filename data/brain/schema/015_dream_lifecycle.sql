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

-- --- multiline authored text ---------------------------------------------------
--
-- A lesson body is the ONE authored field that legitimately spans lines, so the
-- 013 refusal is relaxed for LF alone: every other control character is still
-- refused, and the credential scan still runs over the whole value. The
-- `record_canonical` column needs no relaxation because canonical JSON escapes
-- newlines.

CREATE FUNCTION brain_evidence.assert_safe_multiline_text(
  p_doc jsonb,
  p_key text,
  p_max integer
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_value text;
BEGIN
  IF jsonb_typeof(p_doc->p_key) IS DISTINCT FROM 'string' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' must be a string');
  END IF;
  v_value := p_doc->>p_key;
  IF length(v_value) = 0 OR octet_length(v_value) > p_max THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' is empty or exceeds its byte cap');
  END IF;
  IF replace(v_value, chr(10), '') ~ '[[:cntrl:]]' THEN
    PERFORM brain_evidence.reject_evidence_input(
      p_key || ' contains a control character other than a line feed');
  END IF;
  PERFORM brain_evidence.assert_no_credential_shape(p_key, v_value);
END;
$fn$;

-- --- the candidate ledger ------------------------------------------------------
--
-- `scope_key` is the candidate's OCCASION -- the readiness scope it was drafted
-- over, in all four kinds of 014's grammar. `lesson_scope_key` is its declared
-- TARGET, which the scaffold grammar permits to be agent- or plan-scoped only.
--
-- `lesson_agent_key` is the SUBJECT identity, and it is GENERATED rather than
-- supplied because the materialized lesson path ignores plan scope: an
-- `agent:f/a` target and a `plan:f/a#p` target for one lesson id share ONE
-- physical file and ONE qualified id. The normalized `(lesson_agent_key,
-- lesson_id)` pair is therefore what the subject advisory lock, the damping
-- predicate, the sibling warnings, the promote-time governance check, and the
-- filesystem-phase fence all key on. A generated column cannot drift from the
-- column it derives from.

CREATE TABLE brain_evidence.dream_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^sha256:[a-f0-9]{64}$'),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  readiness_key text NOT NULL CHECK (readiness_key ~ '^sha256:[a-f0-9]{64}$'),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  scope_key text NOT NULL CHECK (
    scope_key ~ '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$'
  ),
  lesson_scope_key text NOT NULL CHECK (
    lesson_scope_key ~ '^(agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$'
  ),
  lesson_agent_key text GENERATED ALWAYS AS (
    regexp_replace(regexp_replace(lesson_scope_key, '^(agent|plan):', ''), '#[a-z0-9-]+$', '')
  ) STORED,
  lesson_id text NOT NULL CHECK (lesson_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  drafted_by_agent_id text NOT NULL CHECK (drafted_by_agent_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  lesson_purpose text NOT NULL CHECK (
    octet_length(lesson_purpose) BETWEEN 1 AND 4096 AND lesson_purpose !~ '[[:cntrl:]]'
  ),
  lesson_body text NOT NULL CHECK (
    octet_length(lesson_body) BETWEEN 1 AND 16384
    AND replace(lesson_body, chr(10), '') !~ '[[:cntrl:]]'
  ),
  expected_effect text NOT NULL CHECK (
    octet_length(expected_effect) BETWEEN 1 AND 4096 AND expected_effect !~ '[[:cntrl:]]'
  ),
  conflicting_survey text NOT NULL CHECK (conflicting_survey IN ('none-found', 'cited')),
  counterexample_survey text NOT NULL CHECK (counterexample_survey IN ('none-found', 'cited')),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$'),
  policy_fingerprint text NOT NULL CHECK (policy_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  watermark_ordinal bigint NOT NULL CHECK (watermark_ordinal >= 0),
  frontier_ordinal bigint NOT NULL CHECK (frontier_ordinal >= 1)
    REFERENCES brain_evidence.evidence_observations(ordinal),
  consumed_completed_runs bigint NOT NULL CHECK (consumed_completed_runs >= 0),
  consumed_feedback_records bigint NOT NULL CHECK (consumed_feedback_records >= 0),
  supersedes_candidate_id text REFERENCES brain_evidence.dream_candidates(candidate_id),
  privacy_class text NOT NULL CHECK (privacy_class IN ('public', 'internal')),
  trust_class text NOT NULL CHECK (trust_class = 'host-asserted'),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dream_candidates_identity UNIQUE (readiness_key, content_digest)
);

CREATE INDEX dream_candidates_subject_idx
  ON brain_evidence.dream_candidates (lesson_agent_key, lesson_id);
CREATE INDEX dream_candidates_supersedes_idx
  ON brain_evidence.dream_candidates (supersedes_candidate_id)
  WHERE supersedes_candidate_id IS NOT NULL;

CREATE TRIGGER dream_candidates_workspace
  BEFORE INSERT ON brain_evidence.dream_candidates
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.derive_dream_workspace();

-- A citation is a POINTER, never a copy: there is deliberately no excerpt,
-- quote, or note column anywhere in this table. That is the structural half of
-- the injection boundary -- no ingested company text can ride a citation into an
-- agent's context window, because none is stored.
CREATE TABLE brain_evidence.dream_candidate_evidence (
  candidate_id text NOT NULL REFERENCES brain_evidence.dream_candidates(candidate_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  role text NOT NULL CHECK (role IN ('supporting', 'conflicting', 'counterexample')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('completed-run', 'feedback')),
  run_id text REFERENCES brain_evidence.completed_runs(run_id),
  feedback_id text REFERENCES brain_evidence.feedback(feedback_id),
  observation_ordinal bigint NOT NULL
    REFERENCES brain_evidence.evidence_observations(ordinal),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, ordinal),
  CONSTRAINT dream_candidate_evidence_identity UNIQUE (candidate_id, observation_ordinal),
  CONSTRAINT dream_candidate_evidence_shape CHECK (
    (evidence_kind = 'completed-run' AND run_id IS NOT NULL AND feedback_id IS NULL)
    OR (evidence_kind = 'feedback' AND run_id IS NULL AND feedback_id IS NOT NULL)
  )
);

-- The DECISION ledger. `lesson_agent_key`/`lesson_id` are SERVER-COPIED from the
-- candidate row and `subject_sequence` is allocated max+1 under the subject
-- advisory lock, so all three derive transitively from `candidate_id` -- which IS
-- in the canonical bytes -- and no caller assertion exists to disagree with them.
-- A per-subject counter rather than a timestamp order because `now()` is
-- transaction-start time and two concurrent writers can commit in the opposite
-- order to their stamps (014 documents the hazard); the UNIQUE below makes the
-- ordering exact even against a hypothetical direct admin insert.
CREATE TABLE brain_evidence.lesson_decisions (
  candidate_id text NOT NULL REFERENCES brain_evidence.dream_candidates(candidate_id),
  sequence integer NOT NULL CHECK (sequence >= 1),
  lesson_decision_id text NOT NULL UNIQUE CHECK (lesson_decision_id ~ '^sha256:[a-f0-9]{64}$'),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  decision text NOT NULL CHECK (decision IN ('promote', 'reject', 'retire')),
  lesson_agent_key text NOT NULL CHECK (
    lesson_agent_key ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  lesson_id text NOT NULL CHECK (lesson_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  subject_sequence bigint NOT NULL CHECK (subject_sequence >= 1),
  human_decision_id text NOT NULL REFERENCES brain_evidence.human_decisions(decision_id),
  action_digest text NOT NULL CHECK (action_digest ~ '^sha256:[a-f0-9]{64}$'),
  lesson_qualified_id text CHECK (
    lesson_qualified_id IS NULL
    OR lesson_qualified_id ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*/playbook/[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  lesson_content_hash text CHECK (
    lesson_content_hash IS NULL OR lesson_content_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  watermark_scope_key text,
  watermark_sequence bigint,
  frontier_ordinal bigint NOT NULL CHECK (frontier_ordinal >= 1),
  actor_assurance text NOT NULL CHECK (actor_assurance = 'human-confirmed'),
  decided_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, sequence),
  CONSTRAINT lesson_decisions_human_decision_identity UNIQUE (human_decision_id),
  CONSTRAINT lesson_decisions_subject_order UNIQUE (lesson_agent_key, lesson_id, subject_sequence),
  CONSTRAINT lesson_decisions_watermark_fkey
    FOREIGN KEY (watermark_scope_key, watermark_sequence)
    REFERENCES brain_evidence.dream_watermarks(scope_key, sequence),
  CONSTRAINT lesson_decisions_shape CHECK (
    (decision = 'promote'
      AND lesson_qualified_id IS NOT NULL AND lesson_content_hash IS NOT NULL
      AND watermark_scope_key IS NOT NULL AND watermark_sequence IS NOT NULL)
    OR (decision = 'retire'
      AND lesson_qualified_id IS NOT NULL AND lesson_content_hash IS NOT NULL
      AND watermark_scope_key IS NULL AND watermark_sequence IS NULL)
    OR (decision = 'reject'
      AND lesson_qualified_id IS NULL AND lesson_content_hash IS NULL
      AND watermark_scope_key IS NULL AND watermark_sequence IS NULL)
  )
);

CREATE TRIGGER lesson_decisions_workspace
  BEFORE INSERT ON brain_evidence.lesson_decisions
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.derive_dream_workspace();

-- Supersession is a STATE, derived from row existence rather than stored, so no
-- row is ever updated to record it.
CREATE VIEW brain_evidence.dream_candidate_state AS
  SELECT c.candidate_id,
         c.scope_key,
         c.lesson_scope_key,
         c.lesson_agent_key,
         c.lesson_id,
         c.drafted_by_agent_id,
         c.readiness_key,
         c.watermark_ordinal,
         c.frontier_ordinal,
         c.recorded_at,
         CASE
           WHEN latest.decision = 'promote' THEN 'promoted'
           WHEN latest.decision = 'reject' THEN 'rejected'
           WHEN latest.decision = 'retire' THEN 'retired'
           WHEN EXISTS (
             SELECT 1 FROM brain_evidence.dream_candidates s
              WHERE s.supersedes_candidate_id = c.candidate_id
           ) THEN 'superseded'
           ELSE 'open'
         END AS state,
         latest.sequence AS decision_sequence,
         latest.subject_sequence AS decision_subject_sequence
    FROM brain_evidence.dream_candidates c
    LEFT JOIN LATERAL (
      SELECT d.decision, d.sequence, d.subject_sequence
        FROM brain_evidence.lesson_decisions d
       WHERE d.candidate_id = c.candidate_id
       ORDER BY d.sequence DESC
       LIMIT 1
    ) latest ON true;

-- --- the create broker ---------------------------------------------------------
--
-- A/B/C preamble, the discipline every check in this migration follows:
--
--   (A) resolve identity with NO locks held, purely to derive lock components;
--   (B) acquire the three advisory locks in the fixed order;
--   (C) run EVERY correctness check against reads taken UNDER the locks,
--       replay-first.
--
-- The create side is deliberately asymmetric to the decide side: this broker
-- CREATES the row, so no server-held copy of its subject exists yet and the
-- validated canonical IS the identity source. A caller that lies about the
-- subject only mislocks its own new row, because the stored subject is the
-- GENERATED column over the same `lesson_scope_key` bytes -- which is exactly
-- what the post-insert RBE04 belt re-proves.
--
-- Checks 2-6 are composed as ONE statement over one `clock_timestamp()` capture:
-- under READ COMMITTED one statement is one snapshot, so no torn mix of pre- and
-- post-advance state is possible. That is READINESS_SQL's own discipline applied
-- to a broker.

CREATE FUNCTION brain_evidence.record_dream_candidate(p_record_canonical text)
RETURNS TABLE (status text, candidate_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
-- `candidate_id`, `lesson_agent_key` and friends name both a RETURNS TABLE
-- column and a table column, so every local is v_ prefixed and an unqualified
-- identifier always resolves toward the column.
#variable_conflict use_column
DECLARE
  v_doc jsonb;
  v_candidate_id text;
  v_scope_key text;
  v_lesson_scope_key text;
  v_lesson_agent_key text;
  v_lesson_id text;
  v_drafted_by text;
  v_privacy_rank integer;
  v_contained boolean;
  v_watermark_ordinal bigint;
  v_frontier_ordinal bigint;
  v_supersedes text;
  v_stored text;
  v_inserted integer;
  v_element jsonb;
  v_generated text;
  v_proof record;
  v_target record;
  v_rejection_frontier bigint;
  v_damping record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the dream lifecycle brokers require READ COMMITTED; got %',
      current_setting('transaction_isolation') USING ERRCODE = 'RBE12';
  END IF;
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 65536 THEN
    PERFORM brain_evidence.reject_evidence_input('the dream candidate exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'actor', 'candidate_id', 'citations', 'conflicting_survey',
    'consumed_completed_runs', 'consumed_feedback_records', 'content_digest',
    'counterexample_survey', 'drafted_by_agent_id', 'expected_effect',
    'frontier_ordinal', 'kind', 'lesson_body', 'lesson_id', 'lesson_purpose',
    'lesson_scope_key', 'policy_fingerprint', 'policy_version', 'privacy_class',
    'provenance', 'readiness_key', 'schema_version', 'scope_key',
    'supersedes_candidate_id', 'trust_class', 'watermark_ordinal'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['dream-candidate']);
  PERFORM brain_evidence.assert_evidence_envelope(v_doc);
  -- A promoted candidate becomes a plaintext Git file, so `secret` is not a
  -- representable candidate class at all.
  PERFORM brain_evidence.assert_member(v_doc, 'privacy_class', ARRAY['public', 'internal']);
  PERFORM brain_evidence.assert_text(v_doc, 'candidate_id', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'readiness_key', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'content_digest', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(
    v_doc, 'scope_key', 256,
    '^(workspace|function:[a-z0-9]+(-[a-z0-9]+)*|agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$',
    false);
  PERFORM brain_evidence.assert_text(
    v_doc, 'lesson_scope_key', 256,
    '^(agent:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*|plan:[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*#[a-z0-9]+(-[a-z0-9]+)*)$',
    false);
  PERFORM brain_evidence.assert_text(v_doc, 'lesson_id', 80, '^[a-z0-9]+(-[a-z0-9]+)*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'drafted_by_agent_id', 80, '^[a-z0-9]+(-[a-z0-9]+)*$', false);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'lesson_purpose', 4096, false);
  PERFORM brain_evidence.assert_safe_multiline_text(v_doc, 'lesson_body', 16384);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'expected_effect', 4096, false);
  PERFORM brain_evidence.assert_member(v_doc, 'conflicting_survey', ARRAY['none-found', 'cited']);
  PERFORM brain_evidence.assert_member(v_doc, 'counterexample_survey', ARRAY['none-found', 'cited']);
  PERFORM brain_evidence.assert_text(
    v_doc, 'policy_version', 256, '^[a-z0-9]+(\.[a-z0-9]+)*\.v[0-9]+$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'policy_fingerprint', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_integer(v_doc, 'watermark_ordinal', 0, 9223372036854775807);
  PERFORM brain_evidence.assert_integer(v_doc, 'frontier_ordinal', 1, 9223372036854775807);
  PERFORM brain_evidence.assert_integer(v_doc, 'consumed_completed_runs', 0, 9223372036854775807);
  PERFORM brain_evidence.assert_integer(v_doc, 'consumed_feedback_records', 0, 9223372036854775807);
  PERFORM brain_evidence.assert_text(v_doc, 'supersedes_candidate_id', 256, '^sha256:[a-f0-9]{64}$', true);
  PERFORM brain_evidence.assert_safe_object(v_doc, 'provenance', 65536, false);

  IF jsonb_typeof(v_doc->'citations') <> 'array'
     OR jsonb_array_length(v_doc->'citations') > 64
     OR jsonb_array_length(v_doc->'citations') = 0 THEN
    PERFORM brain_evidence.reject_evidence_input(
      'citations must be an array of 1..64 pointer citations');
  END IF;
  FOR v_element IN SELECT value FROM jsonb_array_elements(v_doc->'citations') LOOP
    PERFORM brain_evidence.assert_keys(v_element, ARRAY[
      'evidence_kind', 'feedback_id', 'observation_ordinal', 'role', 'run_id'
    ]);
    PERFORM brain_evidence.assert_member(
      v_element, 'role', ARRAY['supporting', 'conflicting', 'counterexample']);
    PERFORM brain_evidence.assert_member(
      v_element, 'evidence_kind', ARRAY['completed-run', 'feedback']);
    PERFORM brain_evidence.assert_text(
      v_element, 'run_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', true);
    PERFORM brain_evidence.assert_text(
      v_element, 'feedback_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', true);
    PERFORM brain_evidence.assert_integer(v_element, 'observation_ordinal', 1, 9223372036854775807);
    IF (v_element->>'evidence_kind') = 'completed-run' THEN
      IF jsonb_typeof(v_element->'run_id') <> 'string'
         OR jsonb_typeof(v_element->'feedback_id') <> 'null' THEN
        PERFORM brain_evidence.reject_evidence_input(
          'a completed-run citation needs a run id and no feedback id');
      END IF;
    ELSIF jsonb_typeof(v_element->'feedback_id') <> 'string'
       OR jsonb_typeof(v_element->'run_id') <> 'null' THEN
      PERFORM brain_evidence.reject_evidence_input(
        'a feedback citation needs a feedback id and no run id');
    END IF;
  END LOOP;

  -- Three explicit roles: at least one SUPPORTING citation, and each survey says
  -- exactly what its own citations say. A survey that claims `none-found` while
  -- citing a counterexample is an incoherent record, not a judgment call.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_doc->'citations') AS c(value)
     WHERE c.value->>'role' = 'supporting'
  ) THEN
    PERFORM brain_evidence.reject_evidence_input('a candidate needs at least one supporting citation');
  END IF;
  IF (v_doc->>'conflicting_survey' = 'cited') <> EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_doc->'citations') AS c(value)
     WHERE c.value->>'role' = 'conflicting'
  ) THEN
    PERFORM brain_evidence.reject_evidence_input(
      'conflicting_survey must be cited exactly when a conflicting citation is present');
  END IF;
  IF (v_doc->>'counterexample_survey' = 'cited') <> EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_doc->'citations') AS c(value)
     WHERE c.value->>'role' = 'counterexample'
  ) THEN
    PERFORM brain_evidence.reject_evidence_input(
      'counterexample_survey must be cited exactly when a counterexample citation is present');
  END IF;

  -- (A) identity and lock components, derived from the validated canonical.
  v_candidate_id := v_doc->>'candidate_id';
  v_scope_key := v_doc->>'scope_key';
  v_lesson_scope_key := v_doc->>'lesson_scope_key';
  v_lesson_id := v_doc->>'lesson_id';
  v_drafted_by := v_doc->>'drafted_by_agent_id';
  v_watermark_ordinal := (v_doc->>'watermark_ordinal')::bigint;
  v_frontier_ordinal := (v_doc->>'frontier_ordinal')::bigint;
  v_supersedes := v_doc->>'supersedes_candidate_id';
  v_privacy_rank := CASE v_doc->>'privacy_class' WHEN 'public' THEN 1 ELSE 2 END;
  v_lesson_agent_key := (
    SELECT regexp_replace(regexp_replace(lesson_scope_key, '^(agent|plan):', ''), '#[a-z0-9-]+$', '')
      FROM (SELECT v_lesson_scope_key AS lesson_scope_key) AS subject
  );

  -- Scope containment: the TARGET must sit at or below the OCCASION. A lesson
  -- drafted over one plan's evidence may not be installed agent-wide, which is
  -- the direction that would apply narrow evidence broadly.
  v_contained := CASE
    WHEN v_scope_key = 'workspace' THEN true
    WHEN v_scope_key LIKE 'function:%'
      THEN v_lesson_agent_key LIKE (substring(v_scope_key from 10) || '/%')
    WHEN v_scope_key LIKE 'agent:%'
      THEN v_lesson_agent_key = substring(v_scope_key from 7)
    ELSE v_lesson_scope_key = v_scope_key
  END;
  IF NOT v_contained THEN
    PERFORM brain_evidence.reject_evidence_input(
      'the lesson target is not contained in the candidate occasion scope');
  END IF;

  -- (B) the three locks, in the fixed intra-rank order.
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.subject.v1', ARRAY[v_lesson_agent_key, v_lesson_id]));
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.candidate.v1', ARRAY[v_candidate_id]));
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.watermark.v1', ARRAY[v_scope_key]));

  -- (C) replay first, before any state-dependent check.
  SELECT stored.record_canonical INTO v_stored
    FROM brain_evidence.dream_candidates stored WHERE stored.candidate_id = v_candidate_id;
  IF v_stored IS NOT NULL THEN
    IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
      RAISE EXCEPTION 'a different dream candidate is already recorded under this identity'
        USING ERRCODE = 'RBE02';
    END IF;
    RETURN QUERY SELECT 'existing'::text, v_candidate_id;
    RETURN;
  END IF;

  SELECT * INTO v_proof FROM (
    WITH captured AS (
      SELECT clock_timestamp() AS evaluated_at
    ), policy AS (
      SELECT * FROM brain_evidence.dream_effective_policy(v_scope_key)
    ), head AS (
      SELECT w.cursor_ordinal, w.advanced_at
        FROM brain_evidence.dream_watermarks w
       WHERE w.scope_key = v_scope_key
       ORDER BY w.sequence DESC
       LIMIT 1
    ), eligible AS (
      SELECT e.*
        FROM captured n
       CROSS JOIN LATERAL
         brain_evidence.dream_eligible(v_scope_key, n.evaluated_at, v_watermark_ordinal) e
    ), bounded AS (
      SELECT * FROM eligible WHERE ordinal <= v_frontier_ordinal
    ), cited AS (
      SELECT (c.value->>'role') AS role,
             (c.value->>'observation_ordinal')::bigint AS claimed_ordinal,
             o.ordinal AS actual_ordinal,
             r.run_id AS resolved_run_id,
             r.agent_id AS run_agent_id,
             -- The effective class is the run's, raised by the feedback's own
             -- class for a feedback citation. A run-only citation has no
             -- feedback row at all, so the NULL branch must rank 0 rather than
             -- fall into the secret arm and refuse every ordinary citation.
             greatest(
               CASE
                 WHEN r.privacy_class = 'public' THEN 1
                 WHEN r.privacy_class = 'internal' THEN 2
                 WHEN r.privacy_class IS NULL THEN 0
                 ELSE 3
               END,
               CASE
                 WHEN f.privacy_class = 'public' THEN 1
                 WHEN f.privacy_class = 'internal' THEN 2
                 WHEN f.privacy_class IS NULL THEN 0
                 ELSE 3
               END
             ) AS privacy_rank
        FROM jsonb_array_elements(v_doc->'citations') AS c(value)
        LEFT JOIN brain_evidence.evidence_observations o
          ON o.evidence_kind = c.value->>'evidence_kind'
         AND o.evidence_id = coalesce(c.value->>'run_id', c.value->>'feedback_id')
        LEFT JOIN brain_evidence.feedback f
          ON c.value->>'evidence_kind' = 'feedback'
         AND f.feedback_id = c.value->>'feedback_id'
        LEFT JOIN brain_evidence.completed_runs r
          ON r.run_id = CASE WHEN c.value->>'evidence_kind' = 'completed-run'
                             THEN c.value->>'run_id' ELSE f.run_id END
    )
    SELECT
      (SELECT evaluated_at FROM captured) AS evaluated_at,
      (SELECT count(*) FROM cited
        WHERE actual_ordinal IS NULL OR resolved_run_id IS NULL) AS unresolved,
      -- The citation-BANNED set is caller-independent: the drafter's own runs
      -- and the reflection agent's runs, neither of which any policy can relax.
      -- Dreamer output can never be independent evidence for itself.
      (SELECT count(*) FROM cited
        WHERE run_agent_id IS NOT NULL
          AND (run_agent_id = v_drafted_by OR run_agent_id = 'dreamer')) AS self_evidence,
      (SELECT count(*) FROM cited WHERE privacy_rank = 3) AS secret_citation,
      (SELECT count(*) FROM cited WHERE privacy_rank > v_privacy_rank) AS privacy_incompatible,
      (SELECT count(*) FROM cited
        WHERE actual_ordinal IS NOT NULL AND claimed_ordinal <> actual_ordinal) AS ordinal_mismatch,
      (SELECT count(*) FROM cited c2
        WHERE c2.actual_ordinal IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM bounded b WHERE b.ordinal = c2.actual_ordinal))
        AS outside_snapshot,
      (SELECT coalesce(max(ordinal), 0) FROM eligible) AS frontier_max,
      (SELECT count(*) FILTER (WHERE evidence_kind = 'completed-run') FROM bounded) AS bounded_runs,
      (SELECT count(*) FILTER (WHERE evidence_kind = 'feedback') FROM bounded) AS bounded_feedback,
      (SELECT count(*) FILTER (
         WHERE (evidence_kind = 'feedback' AND signal IN ('negative', 'mixed'))
            OR (evidence_kind = 'completed-run' AND outcome IN ('failed', 'partial', 'aborted'))
       ) FROM bounded) AS bounded_mix,
      (SELECT count(*) FROM bounded WHERE ordinal = v_frontier_ordinal) AS frontier_eligible,
      coalesce((SELECT cursor_ordinal FROM head), 0) AS head_ordinal,
      NOT EXISTS (
        SELECT 1 FROM head h, policy p, captured n
         WHERE n.evaluated_at < h.advanced_at + p.cooldown
      ) AS cooldown_inactive,
      (SELECT policy_version FROM policy) AS effective_policy_version,
      (SELECT min_completed_runs FROM policy) AS min_completed_runs,
      (SELECT min_feedback_records FROM policy) AS min_feedback_records,
      (SELECT min_signal_mix FROM policy) AS min_signal_mix
  ) AS proof;

  IF v_proof.unresolved > 0 THEN
    RAISE EXCEPTION 'a cited evidence record does not exist' USING ERRCODE = 'RBE03';
  END IF;
  IF v_proof.self_evidence > 0 THEN
    RAISE EXCEPTION 'a candidate may not cite its own drafter''s runs or reflection runs'
      USING ERRCODE = 'RBE06';
  END IF;
  IF v_proof.secret_citation > 0 THEN
    RAISE EXCEPTION 'secret-class evidence can never support a lesson that becomes a plaintext file'
      USING ERRCODE = 'RBE11';
  END IF;
  IF v_proof.privacy_incompatible > 0 THEN
    RAISE EXCEPTION 'a citation is more restricted than the candidate privacy class'
      USING ERRCODE = 'RBE11';
  END IF;
  IF v_proof.ordinal_mismatch > 0 OR v_proof.outside_snapshot > 0 THEN
    RAISE EXCEPTION 'a citation lies outside the candidate bound snapshot' USING ERRCODE = 'RBE07';
  END IF;
  IF v_proof.head_ordinal <> v_watermark_ordinal THEN
    RAISE EXCEPTION 'the candidate watermark is not the current scope watermark'
      USING ERRCODE = 'RBE07';
  END IF;
  IF v_proof.frontier_max <> v_frontier_ordinal OR v_proof.frontier_eligible = 0 THEN
    RAISE EXCEPTION 'the candidate frontier is not the maximal eligible observation'
      USING ERRCODE = 'RBE07';
  END IF;
  IF v_proof.bounded_runs <> (v_doc->>'consumed_completed_runs')::bigint
     OR v_proof.bounded_feedback <> (v_doc->>'consumed_feedback_records')::bigint THEN
    RAISE EXCEPTION 'the candidate consumed counts do not match the bound snapshot'
      USING ERRCODE = 'RBE07';
  END IF;
  IF v_proof.effective_policy_version IS DISTINCT FROM (v_doc->>'policy_version') THEN
    RAISE EXCEPTION 'the candidate policy version is not the effective policy for this scope'
      USING ERRCODE = 'RBE07';
  END IF;
  IF v_proof.bounded_runs < v_proof.min_completed_runs
     OR v_proof.bounded_feedback < v_proof.min_feedback_records
     OR v_proof.bounded_mix < v_proof.min_signal_mix
     OR NOT v_proof.cooldown_inactive THEN
    RAISE EXCEPTION 'this scope is not due under its effective policy' USING ERRCODE = 'RBE07';
  END IF;

  -- Supersession is a REVISE of the same typed subject tuple, deliberately
  -- stricter than the normalized identity: superseding across occasions or
  -- across target spellings is a re-create, and re-creates are what damping
  -- governs. Lineage across occasions rides the shared normalized identity.
  IF v_supersedes IS NOT NULL THEN
    SELECT s.state, c.scope_key, c.lesson_scope_key, c.lesson_id
      INTO v_target
      FROM brain_evidence.dream_candidate_state s
      JOIN brain_evidence.dream_candidates c ON c.candidate_id = s.candidate_id
     WHERE s.candidate_id = v_supersedes;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the superseded dream candidate does not exist' USING ERRCODE = 'RBE03';
    END IF;
    IF v_target.scope_key IS DISTINCT FROM v_scope_key
       OR v_target.lesson_scope_key IS DISTINCT FROM v_lesson_scope_key
       OR v_target.lesson_id IS DISTINCT FROM v_lesson_id THEN
      PERFORM brain_evidence.reject_evidence_input(
        'a superseding candidate must share the exact occasion, target spelling, and lesson id');
    END IF;
    IF v_target.state <> 'open' THEN
      RAISE EXCEPTION 'only an open candidate can be superseded (state %); retire the promoted lesson first',
        v_target.state USING ERRCODE = 'RBE10';
    END IF;
  END IF;

  -- Post-rejection damping, on the NORMALIZED subject: a rejected or retired
  -- lesson may not be re-proposed until genuinely NEW evidence has arrived, and
  -- the bar is the policy's own minimums measured ABOVE the rejection frontier.
  -- The occasion and the target spelling do not partition the subject, so the
  -- damping cannot be evaded by re-drafting from a different scope.
  SELECT max(d.frontier_ordinal) INTO v_rejection_frontier
    FROM brain_evidence.lesson_decisions d
   WHERE d.lesson_agent_key = v_lesson_agent_key
     AND d.lesson_id = v_lesson_id
     AND d.decision IN ('reject', 'retire');
  IF v_rejection_frontier IS NOT NULL THEN
    SELECT
      count(*) FILTER (WHERE e.evidence_kind = 'completed-run') AS runs,
      count(*) FILTER (WHERE e.evidence_kind = 'feedback') AS feedback_records
      INTO v_damping
      FROM brain_evidence.dream_eligible(
             v_scope_key, v_proof.evaluated_at, v_rejection_frontier) e
     WHERE e.ordinal <= v_frontier_ordinal;
    IF v_damping.runs < v_proof.min_completed_runs
       OR v_damping.feedback_records < v_proof.min_feedback_records THEN
      RAISE EXCEPTION 'this lesson was decided against at observation %; gather the policy minimum of new evidence before re-proposing it',
        v_rejection_frontier USING ERRCODE = 'RBE09';
    END IF;
  END IF;

  INSERT INTO brain_evidence.dream_candidates (
    candidate_id, record_canonical, workspace_id, readiness_key, content_digest,
    scope_key, lesson_scope_key, lesson_id, drafted_by_agent_id, lesson_purpose,
    lesson_body, expected_effect, conflicting_survey, counterexample_survey,
    policy_version, policy_fingerprint, watermark_ordinal, frontier_ordinal,
    consumed_completed_runs, consumed_feedback_records, supersedes_candidate_id,
    privacy_class, trust_class, actor_assurance, assurance_evidence, provenance
  ) VALUES (
    v_candidate_id,
    p_record_canonical,
    'derived-by-trigger',
    v_doc->>'readiness_key',
    v_doc->>'content_digest',
    v_scope_key,
    v_lesson_scope_key,
    v_lesson_id,
    v_drafted_by,
    v_doc->>'lesson_purpose',
    v_doc->>'lesson_body',
    v_doc->>'expected_effect',
    v_doc->>'conflicting_survey',
    v_doc->>'counterexample_survey',
    v_doc->>'policy_version',
    v_doc->>'policy_fingerprint',
    v_watermark_ordinal,
    v_frontier_ordinal,
    (v_doc->>'consumed_completed_runs')::bigint,
    (v_doc->>'consumed_feedback_records')::bigint,
    v_supersedes,
    v_doc->>'privacy_class',
    v_doc->>'trust_class',
    v_doc->'actor'->>'assurance',
    v_doc->'actor',
    v_doc->'provenance'
  )
  ON CONFLICT (candidate_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT stored.record_canonical INTO v_stored
      FROM brain_evidence.dream_candidates stored WHERE stored.candidate_id = v_candidate_id;
    IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
      RAISE EXCEPTION 'a different dream candidate is already recorded under this identity'
        USING ERRCODE = 'RBE02';
    END IF;
    RETURN QUERY SELECT 'existing'::text, v_candidate_id;
    RETURN;
  END IF;

  INSERT INTO brain_evidence.dream_candidate_evidence (
    candidate_id, ordinal, role, evidence_kind, run_id, feedback_id, observation_ordinal
  )
  SELECT
    v_candidate_id,
    (c.position - 1)::integer,
    c.value->>'role',
    c.value->>'evidence_kind',
    c.value->>'run_id',
    c.value->>'feedback_id',
    (c.value->>'observation_ordinal')::bigint
    FROM jsonb_array_elements(v_doc->'citations') WITH ORDINALITY AS c(value, position);

  -- The belt on the create-side asymmetry: the subject this broker LOCKED must
  -- be the subject the stored row actually has. It can only ever fire on a 015
  -- editing mistake, which is exactly why it is cheap to keep.
  SELECT stored.lesson_agent_key INTO v_generated
    FROM brain_evidence.dream_candidates stored WHERE stored.candidate_id = v_candidate_id;
  IF v_generated IS DISTINCT FROM v_lesson_agent_key THEN
    RAISE EXCEPTION 'the derived lesson subject key disagrees with the stored generated column'
      USING ERRCODE = 'RBE04';
  END IF;

  RETURN QUERY SELECT 'created'::text, v_candidate_id;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN unique_violation THEN
    RAISE EXCEPTION 'a different dream candidate already occupies this snapshot identity'
      USING ERRCODE = 'RBE02';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the dream candidate violates the closed candidate schema' USING ERRCODE = 'RBE01';
END;
$fn$;

-- --- the decide broker: the promotion binding ----------------------------------
--
-- `advance_dream_watermark` is granted to NOBODY. This broker is SECURITY
-- DEFINER, granted to the runtime role, and calls it internally -- which is how
-- 014's HANDOFF is discharged: the advance happens only after the cursor has
-- been proved scope-eligible, frontier-maximal for the candidate's own snapshot,
-- and accompanied by a durable human-confirmed promotion identity. Steps 1-12
-- are ONE transaction, so a failure anywhere -- including between the advance and
-- the decision insert -- rolls back both rows. The order inside the transaction
-- is dictated solely by the non-deferrable watermark foreign key.
--
-- Roster is not an approval authority. This broker never asks a human anything,
-- never waits, and never treats its own record as authorization: it verifies
-- that a durable human decision EXISTS and is bound by action digest to this
-- exact candidate, and refuses otherwise.

CREATE FUNCTION brain_evidence.decide_lesson_candidate(p_record_canonical text)
RETURNS TABLE (
  status text,
  sequence integer,
  subject_sequence bigint,
  subject_current boolean,
  watermark_scope_key text,
  watermark_sequence bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_doc jsonb;
  v_decision text;
  v_decision_id text;
  v_candidate_id text;
  v_candidate record;
  v_state text;
  v_human record;
  v_watermark jsonb;
  v_promote record;
  v_proof record;
  v_stored text;
  v_stored_row record;
  v_expected_qualified text;
  v_expected_answer text;
  v_sequence integer;
  v_subject_sequence bigint;
  -- Held as scalars rather than read off the advance record: plpgsql substitutes
  -- a record field as a query parameter before the CASE arm is chosen, so a
  -- reject or retire -- which never advances -- would fault on an unassigned
  -- record even though its branch is not taken.
  v_watermark_scope_key text;
  v_watermark_sequence bigint;
  v_governor_sequence bigint;
  v_inserted integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the dream lifecycle brokers require READ COMMITTED; got %',
      current_setting('transaction_isolation') USING ERRCODE = 'RBE12';
  END IF;
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 65536 THEN
    PERFORM brain_evidence.reject_evidence_input('the lesson decision exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'action_digest', 'actor_assurance', 'candidate_id', 'decided_at', 'decision',
    'frontier_ordinal', 'human_decision_id', 'kind', 'lesson_content_hash',
    'lesson_decision_id', 'lesson_qualified_id', 'schema_version', 'watermark_canonical'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['lesson-decision']);
  PERFORM brain_evidence.assert_integer(v_doc, 'schema_version', 1, 1);
  PERFORM brain_evidence.assert_member(v_doc, 'decision', ARRAY['promote', 'reject', 'retire']);
  PERFORM brain_evidence.assert_member(v_doc, 'actor_assurance', ARRAY['human-confirmed']);
  PERFORM brain_evidence.assert_text(v_doc, 'lesson_decision_id', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'candidate_id', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(
    v_doc, 'human_decision_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'action_digest', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_text(
    v_doc, 'lesson_qualified_id', 256,
    '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*/playbook/[a-z0-9]+(-[a-z0-9]+)*$', true);
  PERFORM brain_evidence.assert_text(v_doc, 'lesson_content_hash', 256, '^sha256:[a-f0-9]{64}$', true);
  PERFORM brain_evidence.assert_integer(v_doc, 'frontier_ordinal', 1, 9223372036854775807);
  PERFORM brain_evidence.assert_instant(v_doc, 'decided_at');
  -- The watermark canonical is carried VERBATIM as a string and handed to 014's
  -- own writer, so 014 keeps sole ownership of watermark replay and monotonicity.
  -- It is a typed structured field, so it is validated by shape and by the
  -- field-by-field comparison in step 9 rather than routed through the free-text
  -- credential scan.
  PERFORM brain_evidence.assert_text(v_doc, 'watermark_canonical', 16384, NULL, true);

  v_decision := v_doc->>'decision';
  v_decision_id := v_doc->>'lesson_decision_id';
  v_candidate_id := v_doc->>'candidate_id';
  IF v_decision = 'promote' THEN
    IF jsonb_typeof(v_doc->'watermark_canonical') <> 'string'
       OR jsonb_typeof(v_doc->'lesson_qualified_id') <> 'string'
       OR jsonb_typeof(v_doc->'lesson_content_hash') <> 'string' THEN
      PERFORM brain_evidence.reject_evidence_input(
        'a promote decision needs a watermark advance, a qualified lesson id, and a content hash');
    END IF;
  ELSIF v_decision = 'retire' THEN
    IF jsonb_typeof(v_doc->'watermark_canonical') <> 'null'
       OR jsonb_typeof(v_doc->'lesson_qualified_id') <> 'string'
       OR jsonb_typeof(v_doc->'lesson_content_hash') <> 'string' THEN
      PERFORM brain_evidence.reject_evidence_input(
        'a retire decision needs the promoted lesson identity and no watermark advance');
    END IF;
  ELSIF jsonb_typeof(v_doc->'watermark_canonical') <> 'null'
     OR jsonb_typeof(v_doc->'lesson_qualified_id') <> 'null'
     OR jsonb_typeof(v_doc->'lesson_content_hash') <> 'null' THEN
    PERFORM brain_evidence.reject_evidence_input(
      'a reject decision carries no lesson identity and no watermark advance');
  END IF;

  -- (A) identity resolution with NO locks held. The candidate row is append-only
  -- and its columns are never updated, so these values are immutable from the
  -- moment they are read; the read exists SOLELY to derive lock components and
  -- no correctness check runs against it.
  SELECT c.lesson_agent_key, c.lesson_id, c.scope_key INTO v_candidate
    FROM brain_evidence.dream_candidates c WHERE c.candidate_id = v_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the dream candidate does not exist' USING ERRCODE = 'RBE03';
  END IF;

  -- (B) the three locks, same fixed order as the create broker.
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.subject.v1',
    ARRAY[v_candidate.lesson_agent_key, v_candidate.lesson_id]));
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.candidate.v1', ARRAY[v_candidate_id]));
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.watermark.v1', ARRAY[v_candidate.scope_key]));

  -- (C) every check from here runs against reads taken UNDER the locks.
  SELECT c.* INTO v_candidate
    FROM brain_evidence.dream_candidates c WHERE c.candidate_id = v_candidate_id;

  -- Replay first: a byte-identical re-run is `existing` before any transition,
  -- binding, or governance check can refuse it. The returned governor verdict is
  -- what tells the CLI whether repeating the filesystem phase is still correct --
  -- the replay itself never authorizes it.
  SELECT d.record_canonical, d.sequence, d.subject_sequence,
         d.watermark_scope_key, d.watermark_sequence
    INTO v_stored_row
    FROM brain_evidence.lesson_decisions d WHERE d.lesson_decision_id = v_decision_id;
  IF FOUND THEN
    IF convert_to(v_stored_row.record_canonical, 'UTF8')
       IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
      RAISE EXCEPTION 'a different lesson decision is already recorded under this identity'
        USING ERRCODE = 'RBE02';
    END IF;
    SELECT max(d.subject_sequence) INTO v_governor_sequence
      FROM brain_evidence.lesson_decisions d
     WHERE d.lesson_agent_key = v_candidate.lesson_agent_key
       AND d.lesson_id = v_candidate.lesson_id
       AND d.decision IN ('promote', 'retire');
    RETURN QUERY SELECT
      'existing'::text,
      v_stored_row.sequence,
      v_stored_row.subject_sequence,
      v_stored_row.subject_sequence IS NOT DISTINCT FROM v_governor_sequence,
      v_stored_row.watermark_scope_key,
      v_stored_row.watermark_sequence;
    RETURN;
  END IF;

  SELECT s.state INTO v_state
    FROM brain_evidence.dream_candidate_state s WHERE s.candidate_id = v_candidate_id;
  IF (v_decision IN ('promote', 'reject') AND v_state <> 'open')
     OR (v_decision = 'retire' AND v_state <> 'promoted') THEN
    RAISE EXCEPTION 'a % decision is not available from state %', v_decision, v_state
      USING ERRCODE = 'RBE10';
  END IF;

  -- The human decision is PORTABLE EVIDENCE, bound to this exact candidate by
  -- its normalized action digest. Roster verifies the binding; it never presents,
  -- waits, or enforces -- the host does all three.
  SELECT h.answer, h.actor_assurance, h.action, h.action_digest, h.decided_at INTO v_human
    FROM brain_evidence.human_decisions h WHERE h.decision_id = v_doc->>'human_decision_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the human decision does not exist' USING ERRCODE = 'RBE03';
  END IF;
  v_expected_answer := CASE WHEN v_decision = 'reject' THEN 'rejected' ELSE 'approved' END;
  IF v_human.actor_assurance <> 'human-confirmed'
     OR v_human.answer <> v_expected_answer
     -- `target` is free text and is credential-scanned on both sides, so a bare
     -- sha256 candidate id can never be stored in it. The group-separated
     -- spelling below is the SAME one dreamDecisionTarget renders: injective,
     -- exact, and free of a 32-character hex run.
     OR v_human.action->>'target' IS DISTINCT FROM (
          'dream-candidate:' || regexp_replace(substring(v_candidate_id from 8), '(....)', '\1-', 'g')
        )
     OR v_human.action->>'effect' IS DISTINCT FROM ('dream-candidate-' || v_decision)
     OR v_human.action->>'scope' IS DISTINCT FROM v_candidate.lesson_scope_key
     OR v_human.action_digest IS DISTINCT FROM (v_doc->>'action_digest') THEN
    RAISE EXCEPTION 'the human decision is not bound to this exact candidate decision'
      USING ERRCODE = 'RBE08';
  END IF;
  -- `decided_at` is provenance, so it is SERVER-COMPARED against the human
  -- decision's own timestamp rather than taken from the caller: a direct broker
  -- caller could otherwise stamp an approval at a moment the human never
  -- decided. It stays IN the canonical because the decision record has to be
  -- self-describing, and the equality below is what makes it trustworthy.
  IF (v_doc->>'decided_at')::timestamptz IS DISTINCT FROM v_human.decided_at THEN
    RAISE EXCEPTION 'the decision instant does not match the human decision it cites'
      USING ERRCODE = 'RBE08';
  END IF;

  IF v_decision = 'promote' THEN
    -- Current-policy, current-time revalidation over the candidate's OWN bound
    -- snapshot, in one statement over one clock_timestamp() capture. Frontier
    -- MAXIMALITY is deliberately not re-required against today's frontier: that
    -- is what lets a second candidate from the same snapshot still promote, and
    -- it consumes exactly the evidence the candidate cited.
    SELECT * INTO v_proof FROM (
      WITH captured AS (
        SELECT clock_timestamp() AS evaluated_at
      ), policy AS (
        SELECT * FROM brain_evidence.dream_effective_policy(v_candidate.scope_key)
      ), bound_head AS (
        SELECT w.advanced_at
          FROM brain_evidence.dream_watermarks w
         WHERE w.scope_key = v_candidate.scope_key
           AND w.cursor_ordinal = v_candidate.watermark_ordinal
      ), bounded AS (
        SELECT e.*
          FROM captured n
         CROSS JOIN LATERAL brain_evidence.dream_eligible(
           v_candidate.scope_key, n.evaluated_at, v_candidate.watermark_ordinal) e
         WHERE e.ordinal <= v_candidate.frontier_ordinal
      )
      SELECT
        (SELECT policy_version FROM policy) AS effective_policy_version,
        (SELECT count(*) FROM bounded WHERE ordinal = v_candidate.frontier_ordinal)
          AS frontier_eligible,
        (SELECT count(*) FILTER (WHERE evidence_kind = 'completed-run') FROM bounded) AS bounded_runs,
        (SELECT count(*) FILTER (WHERE evidence_kind = 'feedback') FROM bounded) AS bounded_feedback,
        (SELECT count(*) FILTER (
           WHERE (evidence_kind = 'feedback' AND signal IN ('negative', 'mixed'))
              OR (evidence_kind = 'completed-run' AND outcome IN ('failed', 'partial', 'aborted'))
         ) FROM bounded) AS bounded_mix,
        -- The cooldown binds to the candidate's BOUND head, whose advanced_at is
        -- immutable, so the condition is monotone in real time. Re-checking
        -- against the CURRENT head would let one promotion render its
        -- same-snapshot sibling permanently unpromotable.
        NOT EXISTS (
          SELECT 1 FROM bound_head h, policy p, captured n
           WHERE n.evaluated_at < h.advanced_at + p.cooldown
        ) AS cooldown_inactive,
        (SELECT min_completed_runs FROM policy) AS min_completed_runs,
        (SELECT min_feedback_records FROM policy) AS min_feedback_records,
        (SELECT min_signal_mix FROM policy) AS min_signal_mix
    ) AS proof;

    IF v_proof.effective_policy_version IS DISTINCT FROM v_candidate.policy_version THEN
      RAISE EXCEPTION 'the readiness policy changed since this candidate was drafted; re-run roster dream status and re-draft'
        USING ERRCODE = 'RBE07';
    END IF;
    IF v_proof.frontier_eligible = 0 THEN
      RAISE EXCEPTION 'the candidate frontier observation is no longer eligible; re-run roster dream status and re-draft'
        USING ERRCODE = 'RBE07';
    END IF;
    IF v_proof.bounded_runs < v_proof.min_completed_runs
       OR v_proof.bounded_feedback < v_proof.min_feedback_records
       OR v_proof.bounded_mix < v_proof.min_signal_mix
       OR NOT v_proof.cooldown_inactive THEN
      RAISE EXCEPTION 'this scope is no longer due over the candidate snapshot; re-run roster dream status and re-draft'
        USING ERRCODE = 'RBE07';
    END IF;

    -- One governor per materialized lesson file. This fires BEFORE any watermark
    -- advance, so a cross-occasion or cross-plan double promotion never commits.
    IF EXISTS (
      SELECT 1
        FROM brain_evidence.dream_candidate_state s
        JOIN brain_evidence.dream_candidates c ON c.candidate_id = s.candidate_id
       WHERE c.lesson_agent_key = v_candidate.lesson_agent_key
         AND c.lesson_id = v_candidate.lesson_id
         AND c.candidate_id <> v_candidate_id
         AND s.state = 'promoted'
    ) THEN
      RAISE EXCEPTION 'another candidate already governs this lesson file; retire it first'
        USING ERRCODE = 'RBE10';
    END IF;

    -- Field-by-field verification of 014's closed nine-key advance record
    -- against SERVER-held values. The consumed counts come from the candidate
    -- row's own create-time verified columns, never a fresh recount: recounting
    -- is non-deterministic under window aging and would break the byte-identical
    -- same-snapshot replay 014 arbitrates.
    v_watermark := (v_doc->>'watermark_canonical')::jsonb;
    PERFORM brain_evidence.assert_keys(v_watermark, ARRAY[
      'actor_assurance', 'consumed_completed_runs', 'consumed_feedback_records',
      'cursor_ordinal', 'kind', 'policy_version', 'reason', 'schema_version', 'scope_key'
    ]);
    IF v_watermark->>'kind' IS DISTINCT FROM 'dream-watermark'
       OR (v_watermark->>'schema_version')::integer IS DISTINCT FROM 1
       OR v_watermark->>'reason' IS DISTINCT FROM 'promotion'
       OR v_watermark->>'actor_assurance' IS DISTINCT FROM 'human-confirmed'
       OR v_watermark->>'scope_key' IS DISTINCT FROM v_candidate.scope_key
       OR (v_watermark->>'cursor_ordinal')::bigint IS DISTINCT FROM v_candidate.frontier_ordinal
       OR v_watermark->>'policy_version' IS DISTINCT FROM v_candidate.policy_version
       OR (v_watermark->>'consumed_completed_runs')::bigint
          IS DISTINCT FROM v_candidate.consumed_completed_runs
       OR (v_watermark->>'consumed_feedback_records')::bigint
          IS DISTINCT FROM v_candidate.consumed_feedback_records THEN
      RAISE EXCEPTION 'the watermark advance does not match this candidate snapshot'
        USING ERRCODE = 'RBE07';
    END IF;

    v_expected_qualified :=
      v_candidate.lesson_agent_key || '/playbook/' || v_candidate.lesson_id;
    IF (v_doc->>'lesson_qualified_id') IS DISTINCT FROM v_expected_qualified THEN
      RAISE EXCEPTION 'the qualified lesson id is not the one this candidate materializes'
        USING ERRCODE = 'RBE08';
    END IF;
    IF (v_doc->>'frontier_ordinal')::bigint IS DISTINCT FROM v_candidate.frontier_ordinal THEN
      RAISE EXCEPTION 'the decision frontier does not match this candidate snapshot'
        USING ERRCODE = 'RBE07';
    END IF;

    -- The advance BEFORE the insert: the watermark foreign key is deliberately
    -- not deferrable, so the row it points at must already exist. 014 owns
    -- replay and monotonicity from here.
    SELECT a.scope_key, a.sequence INTO v_watermark_scope_key, v_watermark_sequence
      FROM brain_evidence.advance_dream_watermark(v_doc->>'watermark_canonical') a;
  ELSE
    IF (v_doc->>'frontier_ordinal')::bigint IS DISTINCT FROM v_candidate.frontier_ordinal THEN
      RAISE EXCEPTION 'the decision frontier does not match this candidate snapshot'
        USING ERRCODE = 'RBE07';
    END IF;
  END IF;

  IF v_decision = 'retire' THEN
    -- The retirement is anchored to ONE committed promotion identity, so the
    -- removal gate, the successor's repair arms, and the doctor audit can never
    -- diverge about which bytes were the governor's.
    SELECT d.lesson_qualified_id, d.lesson_content_hash INTO v_promote
      FROM brain_evidence.lesson_decisions d
     WHERE d.candidate_id = v_candidate_id AND d.decision = 'promote'
     ORDER BY d.sequence DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'this candidate has no committed promotion to retire' USING ERRCODE = 'RBE10';
    END IF;
    IF v_promote.lesson_qualified_id IS DISTINCT FROM (v_doc->>'lesson_qualified_id')
       OR v_promote.lesson_content_hash IS DISTINCT FROM (v_doc->>'lesson_content_hash') THEN
      RAISE EXCEPTION 'the retirement does not name the committed promotion identity'
        USING ERRCODE = 'RBE08';
    END IF;
  END IF;

  SELECT coalesce(max(d.sequence), 0) + 1 INTO v_sequence
    FROM brain_evidence.lesson_decisions d WHERE d.candidate_id = v_candidate_id;
  SELECT coalesce(max(d.subject_sequence), 0) + 1 INTO v_subject_sequence
    FROM brain_evidence.lesson_decisions d
   WHERE d.lesson_agent_key = v_candidate.lesson_agent_key
     AND d.lesson_id = v_candidate.lesson_id;

  INSERT INTO brain_evidence.lesson_decisions (
    candidate_id, sequence, lesson_decision_id, record_canonical, workspace_id,
    decision, lesson_agent_key, lesson_id, subject_sequence, human_decision_id,
    action_digest, lesson_qualified_id, lesson_content_hash, watermark_scope_key,
    watermark_sequence, frontier_ordinal, actor_assurance, decided_at
  ) VALUES (
    v_candidate_id,
    v_sequence,
    v_decision_id,
    p_record_canonical,
    'derived-by-trigger',
    v_decision,
    v_candidate.lesson_agent_key,
    v_candidate.lesson_id,
    v_subject_sequence,
    v_doc->>'human_decision_id',
    v_doc->>'action_digest',
    v_doc->>'lesson_qualified_id',
    v_doc->>'lesson_content_hash',
    v_watermark_scope_key,
    v_watermark_sequence,
    (v_doc->>'frontier_ordinal')::bigint,
    v_doc->>'actor_assurance',
    (v_doc->>'decided_at')::timestamptz
  )
  ON CONFLICT (lesson_decision_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RAISE EXCEPTION 'a different lesson decision is already recorded under this identity'
      USING ERRCODE = 'RBE02';
  END IF;

  -- The subject-governor verdict, still under the subject lock. The comparison
  -- is restricted to the MATERIALIZATION ledger: a reject decides an OPEN
  -- candidate, which was never materialized, so it cannot change file
  -- governorship -- and under an all-decisions rule a sibling's reject would flip
  -- a committed promote's replay to false and permanently strand its
  -- crash-interrupted materialization.
  SELECT max(d.subject_sequence) INTO v_governor_sequence
    FROM brain_evidence.lesson_decisions d
   WHERE d.lesson_agent_key = v_candidate.lesson_agent_key
     AND d.lesson_id = v_candidate.lesson_id
     AND d.decision IN ('promote', 'retire');

  RETURN QUERY SELECT
    'created'::text,
    v_sequence,
    v_subject_sequence,
    v_subject_sequence IS NOT DISTINCT FROM v_governor_sequence,
    v_watermark_scope_key,
    v_watermark_sequence;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN unique_violation THEN
    RAISE EXCEPTION 'this human decision already authorizes another lesson decision'
      USING ERRCODE = 'RBE02';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the lesson decision violates the closed decision schema' USING ERRCODE = 'RBE01';
END;
$fn$;

-- --- the filesystem-phase fence and its read-only verifier ---------------------
--
-- The CLI's Git materialization is not a database transaction, so the decision
-- ledger and the workspace need a serialization boundary that spans both. The
-- fence is that boundary: the CLI opens ONE transaction on a dedicated client,
-- calls `hold_dream_subject_lock`, performs the whole filesystem phase, and
-- commits. Both decide-broker transactions acquire the SAME subject frame before
-- any state read or write, so while the fence lives no promote or retire can
-- commit for that subject.
--
-- A bare `pg_advisory_xact_lock(lock_key(...))` from the CLI is deliberately NOT
-- the shape: `lock_key` EXECUTE is revoked from PUBLIC and granted to nobody, and
-- granting the generic hash would hand the runtime the ability to hold ANY
-- evidence-space advisory lock, record brokers and watermark included. A
-- dedicated definer derives the frame server-side from the candidate row, so the
-- runtime's new capability is exactly "serialize my own candidate's subject".
--
-- The verifier acquires NO advisory lock -- that is the property the CLI's
-- lock-order argument rests on. The CLI verifies its fence while holding LOCAL
-- locks, so a verification that could wait on a database lock would let a
-- phase-lock holder block behind a successor that already holds the subject lock.
-- An ordinary read can still queue behind DDL, which is a delay, not a cycle.

CREATE FUNCTION brain_evidence.verify_dream_subject_governor(p_candidate_id text)
RETURNS TABLE (
  lesson_agent_key text,
  lesson_id text,
  governor_candidate_id text,
  governor_decision text,
  governor_subject_sequence bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_candidate record;
  v_governor record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the dream subject verifier requires READ COMMITTED; got %',
      current_setting('transaction_isolation') USING ERRCODE = 'RBE12';
  END IF;
  SELECT c.lesson_agent_key, c.lesson_id INTO v_candidate
    FROM brain_evidence.dream_candidates c WHERE c.candidate_id = p_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the dream candidate does not exist' USING ERRCODE = 'RBE03';
  END IF;
  -- The ONE spelling of the governor query: the materialization-ledger row at
  -- max(subject_sequence). A subject with no materialization ledger leaves every
  -- governor field NULL, which is what an empty SELECT INTO assigns.
  SELECT d.candidate_id, d.decision, d.subject_sequence INTO v_governor
    FROM brain_evidence.lesson_decisions d
   WHERE d.lesson_agent_key = v_candidate.lesson_agent_key
     AND d.lesson_id = v_candidate.lesson_id
     AND d.decision IN ('promote', 'retire')
   ORDER BY d.subject_sequence DESC
   LIMIT 1;
  RETURN QUERY
    SELECT v_candidate.lesson_agent_key,
           v_candidate.lesson_id,
           v_governor.candidate_id,
           v_governor.decision,
           v_governor.subject_sequence;
END;
$fn$;

CREATE FUNCTION brain_evidence.hold_dream_subject_lock(p_candidate_id text)
RETURNS TABLE (
  lesson_agent_key text,
  lesson_id text,
  governor_candidate_id text,
  governor_decision text,
  governor_subject_sequence bigint,
  retired_content_hashes text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_candidate record;
  v_governor record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'the dream subject fence requires READ COMMITTED; got %',
      current_setting('transaction_isolation') USING ERRCODE = 'RBE12';
  END IF;
  SELECT c.lesson_agent_key, c.lesson_id INTO v_candidate
    FROM brain_evidence.dream_candidates c WHERE c.candidate_id = p_candidate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the dream candidate does not exist' USING ERRCODE = 'RBE03';
  END IF;
  -- The SAME frame both brokers acquire FIRST, and only that frame: a strict
  -- prefix of the intra-rank order, so the fence adds no cycle.
  PERFORM pg_advisory_xact_lock(brain_evidence.lock_key(
    'roster.brain.dream.lock.subject.v1',
    ARRAY[v_candidate.lesson_agent_key, v_candidate.lesson_id]));

  SELECT * INTO v_governor
    FROM brain_evidence.verify_dream_subject_governor(p_candidate_id);

  RETURN QUERY
    SELECT v_governor.lesson_agent_key,
           v_governor.lesson_id,
           v_governor.governor_candidate_id,
           v_governor.governor_decision,
           v_governor.governor_subject_sequence,
           -- Every prior retired governor's recorded content, newest first. A
           -- retire ROW's existence IS the "retire is committed" predicate, and
           -- its stored hash equals its promote row's by server construction, so
           -- this one query enumerates exactly the byte sets the CLI's repair
           -- arms may remove. The coalesce is load-bearing: array_agg over zero
           -- rows is NULL, and a subject's FIRST promotion has no retire rows.
           coalesce(
             (SELECT array_agg(d.lesson_content_hash ORDER BY d.subject_sequence DESC)
                FROM brain_evidence.lesson_decisions d
               WHERE d.lesson_agent_key = v_candidate.lesson_agent_key
                 AND d.lesson_id = v_candidate.lesson_id
                 AND d.decision = 'retire'),
             ARRAY[]::text[]
           );
END;
$fn$;

-- --- append-only enforcement --------------------------------------------------

CREATE TRIGGER dream_candidates_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.dream_candidates
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER dream_candidates_no_truncate
  BEFORE TRUNCATE ON brain_evidence.dream_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER dream_candidate_evidence_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.dream_candidate_evidence
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER dream_candidate_evidence_no_truncate
  BEFORE TRUNCATE ON brain_evidence.dream_candidate_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER lesson_decisions_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.lesson_decisions
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER lesson_decisions_no_truncate
  BEFORE TRUNCATE ON brain_evidence.lesson_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

-- --- privileges ---------------------------------------------------------------

REVOKE ALL PRIVILEGES ON brain_evidence.dream_candidates FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.dream_candidate_evidence FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.lesson_decisions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.dream_candidate_state FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION brain_evidence.assert_safe_multiline_text(jsonb, text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.record_dream_candidate(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.decide_lesson_candidate(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.hold_dream_subject_lock(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.verify_dream_subject_governor(text) FROM PUBLIC;
