-- #356: portable work evidence core.
--
-- A separate `brain_evidence` schema inside the same Brain database holds
-- completed runs, their cited sources and tool uses, independent artifact
-- records, feedback, action-digest-bound human decisions, and the promotion
-- lineage ledger. It is excluded from every semantic surface by construction:
-- brain.search / reindex / gc / backup are all schema-qualified to `brain`, so
-- evidence is never embedded, retrieved, or exported as company knowledge. The
-- only evidence -> semantic path is promoteEvidence, which ingests an explicit
-- projection through the ordinary source lifecycle and records a lineage row.
--
-- Deferred on purpose (owned by #362/#384/#363): backup/export coverage of this
-- schema, and Brain-held artifact BYTES. Artifact evidence is external-pointer
-- only here, so the record path never touches the object store.
--
-- Every write traverses an admin-owned SECURITY DEFINER broker. The runtime role
-- holds USAGE + table SELECT + EXECUTE on the four record brokers and no direct
-- DML at all. Promotion has no broker: it is an admin-path library operation.
--
-- Broker verification model: the caller supplies the exact canonical record TEXT
-- its fingerprint is derived from. Every typed column is a jsonb projection of
-- that text, so a column can never disagree with the canonical bytes, and an
-- equivalent replay is detected by BYTE EQUALITY of stored vs supplied canonical
-- text -- there is no hashing in SQL. Fingerprints are TS-derived metadata that
-- stay recomputable from `record_canonical`; no fingerprint column exists.
--
-- Stable error codes: RBE01 input invalid, RBE02 idempotency conflict,
-- RBE03 referenced row missing, RBE04 integrity failure.

CREATE SCHEMA brain_evidence;

REVOKE ALL PRIVILEGES ON SCHEMA brain_evidence FROM PUBLIC;

-- --- advisory lock framing ----------------------------------------------------

-- Length-prefixed frame: domain, then ':<length>:<component>' per component.
-- PostgreSQL `text` cannot contain NUL, so the framing carries its own
-- boundaries; the length prefixes make it injective with no delimiter
-- ambiguity. The TypeScript side reproduces this exactly (evidence-identity.ts)
-- and a parity test pins the two against fixed vectors.
CREATE FUNCTION brain_evidence.lock_frame(p_domain text, p_components text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $fn$
  SELECT p_domain || coalesce((
    SELECT string_agg(':' || length(component)::text || ':' || component, '' ORDER BY position)
      FROM unnest(p_components) WITH ORDINALITY AS framed(component, position)
  ), '');
$fn$;

CREATE FUNCTION brain_evidence.lock_key(p_domain text, p_components text[])
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $fn$
  SELECT pg_catalog.hashtextextended(brain_evidence.lock_frame(p_domain, p_components), 0);
$fn$;

-- --- direct-call input validation --------------------------------------------

CREATE FUNCTION brain_evidence.reject_evidence_input(p_reason text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  RAISE EXCEPTION 'evidence payload is invalid: %', p_reason USING ERRCODE = 'RBE01';
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_keys(p_doc jsonb, p_keys text[])
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF p_doc IS NULL OR jsonb_typeof(p_doc) <> 'object' THEN
    PERFORM brain_evidence.reject_evidence_input('the record must be a JSON object');
  END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_doc) AS key)
     IS DISTINCT FROM (SELECT array_agg(key ORDER BY key) FROM unnest(p_keys) AS key) THEN
    PERFORM brain_evidence.reject_evidence_input('the record has missing or unknown fields');
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_text(
  p_doc jsonb,
  p_key text,
  p_max integer,
  p_pattern text,
  p_nullable boolean
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_type text := jsonb_typeof(p_doc->p_key);
  v_value text;
BEGIN
  IF v_type = 'null' AND p_nullable THEN RETURN; END IF;
  IF v_type IS DISTINCT FROM 'string' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' must be a string');
  END IF;
  v_value := p_doc->>p_key;
  IF length(v_value) = 0 OR octet_length(v_value) > p_max THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' is empty or exceeds its byte cap');
  END IF;
  IF v_value ~ '[[:cntrl:]]' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' contains control characters');
  END IF;
  IF p_pattern IS NOT NULL AND v_value !~ p_pattern THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' contains unsupported characters');
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_member(p_doc jsonb, p_key text, p_values text[])
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF jsonb_typeof(p_doc->p_key) IS DISTINCT FROM 'string'
     OR NOT (p_doc->>p_key = ANY (p_values)) THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' is not a supported value');
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_object(p_doc jsonb, p_key text, p_max integer, p_nullable boolean)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_type text := jsonb_typeof(p_doc->p_key);
BEGIN
  IF v_type = 'null' AND p_nullable THEN RETURN; END IF;
  IF v_type IS DISTINCT FROM 'object' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' must be a JSON object');
  END IF;
  IF octet_length((p_doc->p_key)::text) > p_max THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' exceeds its byte cap');
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_instant(p_doc jsonb, p_key text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  PERFORM brain_evidence.assert_text(p_doc, p_key, 64, NULL, false);
  IF (p_doc->>p_key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' must be an RFC 3339 UTC timestamp');
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_integer(p_doc jsonb, p_key text, p_min bigint, p_max bigint)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_value numeric;
BEGIN
  IF jsonb_typeof(p_doc->p_key) IS DISTINCT FROM 'number' THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' must be a number');
  END IF;
  v_value := (p_doc->>p_key)::numeric;
  IF v_value <> trunc(v_value) OR v_value < p_min OR v_value > p_max THEN
    PERFORM brain_evidence.reject_evidence_input(p_key || ' is outside its integer bounds');
  END IF;
END;
$fn$;

-- Credential shapes that must never enter durable evidence, mirrored from
-- evidence-contracts.ts so a DIRECT broker call cannot bypass the TypeScript
-- refusal. The generic long-hex rule applies to free text and arbitrary JSON
-- only: every TYPED digest field (request_hash, sha256, summary_hash,
-- action_digest, source_version_id, actor.actionDigest) is validated by its own
-- exact regex and is never routed through this scan.
CREATE FUNCTION brain_evidence.assert_no_credential_shape(p_key text, p_value text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  IF p_value IS NULL THEN RETURN; END IF;
  IF p_value ~ 'gh[posur]_[A-Za-z0-9]{20,}'
     OR p_value ~ '(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}'
     OR p_value ~ 'xox[baprs]-[A-Za-z0-9-]{10,}'
     OR p_value ~ '(^|[^A-Za-z0-9])(sk|rk)-[A-Za-z0-9_-]{16,}'
     OR p_value ~ 'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}'
     OR p_value ~ '[0-9a-fA-F]{32,}' THEN
    PERFORM brain_evidence.reject_evidence_input(
      p_key || ' looks like a credential and must never enter durable evidence'
    );
  END IF;
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_safe_text(
  p_doc jsonb,
  p_key text,
  p_max integer,
  p_nullable boolean
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  PERFORM brain_evidence.assert_text(p_doc, p_key, p_max, NULL, p_nullable);
  PERFORM brain_evidence.assert_no_credential_shape(p_key, p_doc->>p_key);
END;
$fn$;

CREATE FUNCTION brain_evidence.assert_safe_object(
  p_doc jsonb,
  p_key text,
  p_max integer,
  p_nullable boolean
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_leaf text;
BEGIN
  PERFORM brain_evidence.assert_object(p_doc, p_key, p_max, p_nullable);
  IF jsonb_typeof(p_doc->p_key) = 'object' THEN
    PERFORM brain_evidence.assert_no_credential_shape(p_key, (p_doc->p_key)::text);
    -- Mirror the TypeScript contract's LEAF-level control-character refusal.
    -- Scanning the serialized form alone cannot see them: jsonb renders a
    -- control byte as the escape sequence \n, so {"note":"line\nbreak"} would
    -- otherwise slip a raw control character in through a direct broker call.
    FOR v_leaf IN
      SELECT value #>> '{}'
      FROM jsonb_path_query(p_doc->p_key, 'strict $.**') AS value
      WHERE jsonb_typeof(value) = 'string'
    LOOP
      IF v_leaf ~ '[[:cntrl:]]' THEN
        PERFORM brain_evidence.reject_evidence_input(
          p_key || ' contains a control character and must never enter durable evidence'
        );
      END IF;
      PERFORM brain_evidence.assert_no_credential_shape(p_key, v_leaf);
    END LOOP;
  END IF;
END;
$fn$;

-- Mirrors normalizeSourceActor exactly: each assurance level carries the
-- identity fields that level implies, and nothing else. Without this a direct
-- call could store {"assurance":"host-attested"} -- a maximum-assurance record
-- with no actor, no host, and no session backing it.
CREATE FUNCTION brain_evidence.assert_actor(p_actor jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_assurance text;
BEGIN
  IF p_actor IS NULL OR jsonb_typeof(p_actor) <> 'object' THEN
    PERFORM brain_evidence.reject_evidence_input('actor must be a JSON object');
  END IF;
  PERFORM brain_evidence.assert_member(
    p_actor, 'assurance',
    ARRAY['system-derived', 'caller-asserted', 'host-attested', 'human-confirmed']
  );
  v_assurance := p_actor->>'assurance';
  IF v_assurance = 'system-derived' THEN
    PERFORM brain_evidence.assert_keys(p_actor, ARRAY['actorId', 'assurance', 'component']);
    PERFORM brain_evidence.assert_member(p_actor, 'component', ARRAY['roster']);
  ELSIF v_assurance = 'caller-asserted' THEN
    PERFORM brain_evidence.assert_keys(p_actor, ARRAY['actorId', 'assurance']);
  ELSIF v_assurance = 'host-attested' THEN
    PERFORM brain_evidence.assert_keys(p_actor, ARRAY['actorId', 'assurance', 'host', 'sessionId']);
    PERFORM brain_evidence.assert_member(p_actor, 'host', ARRAY['claude', 'codex']);
    PERFORM brain_evidence.assert_text(p_actor, 'sessionId', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  ELSE
    PERFORM brain_evidence.assert_keys(p_actor, ARRAY['actorId', 'assurance', 'decisionId', 'actionDigest']);
    PERFORM brain_evidence.assert_text(p_actor, 'decisionId', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
    PERFORM brain_evidence.assert_text(p_actor, 'actionDigest', 256, '^sha256:[a-f0-9]{64}$', false);
  END IF;
  PERFORM brain_evidence.assert_text(p_actor, 'actorId', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
END;
$fn$;

-- Host-asserted evidence needs host or human actor assurance; the record verbs
-- accept no other trust class, so this is enforced on every direct broker call.
CREATE FUNCTION brain_evidence.assert_evidence_envelope(p_doc jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
BEGIN
  PERFORM brain_evidence.assert_integer(p_doc, 'schema_version', 1, 1);
  PERFORM brain_evidence.assert_member(p_doc, 'privacy_class', ARRAY['public', 'internal', 'secret']);
  PERFORM brain_evidence.assert_member(p_doc, 'trust_class', ARRAY['host-asserted']);
  PERFORM brain_evidence.assert_object(p_doc, 'actor', 65536, false);
  PERFORM brain_evidence.assert_actor(p_doc->'actor');
  PERFORM brain_evidence.assert_member(p_doc->'actor', 'assurance', ARRAY['host-attested', 'human-confirmed']);
END;
$fn$;

CREATE FUNCTION brain_evidence.workspace_identity_id()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_workspace_id text;
BEGIN
  SELECT workspace_id INTO v_workspace_id FROM brain_meta.workspace_identity;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'the protected Brain workspace identity is missing' USING ERRCODE = 'RBE04';
  END IF;
  RETURN v_workspace_id;
END;
$fn$;

-- --- evidence tables ----------------------------------------------------------

CREATE TABLE brain_evidence.completed_runs (
  run_id text PRIMARY KEY CHECK (
    octet_length(run_id) BETWEEN 1 AND 256
    AND run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 262144 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (
    octet_length(workspace_id) BETWEEN 1 AND 256
    AND workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  function_id text NOT NULL CHECK (function_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  agent_id text NOT NULL CHECK (agent_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  plan_id text CHECK (plan_id IS NULL OR plan_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  host text NOT NULL CHECK (host IN ('claude', 'codex')),
  host_version text NOT NULL CHECK (
    octet_length(host_version) BETWEEN 1 AND 128 AND host_version !~ '[[:cntrl:]]'
  ),
  roster_version text NOT NULL CHECK (
    octet_length(roster_version) BETWEEN 1 AND 128 AND roster_version !~ '[[:cntrl:]]'
  ),
  request_summary text NOT NULL CHECK (
    octet_length(request_summary) BETWEEN 1 AND 4096 AND request_summary !~ '[[:cntrl:]]'
  ),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL CHECK (completed_at >= started_at),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'partial', 'aborted')),
  privacy_class text NOT NULL CHECK (privacy_class IN ('public', 'internal', 'secret')),
  trust_class text NOT NULL CHECK (
    trust_class IN (
      'brain-structured',
      'brain-extract-untrusted',
      'tool-output-untrusted',
      'host-asserted',
      'legacy-unverified'
    )
  ),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536
  ),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brain_evidence.run_sources (
  run_id text NOT NULL REFERENCES brain_evidence.completed_runs(run_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  source_kind text NOT NULL CHECK (source_kind IN ('brain-source-version', 'external')),
  source_version_id text REFERENCES brain.source_versions(source_version_id),
  external_locator jsonb CHECK (
    external_locator IS NULL
    OR (jsonb_typeof(external_locator) = 'object' AND octet_length(external_locator::text) <= 4096)
  ),
  summary text CHECK (
    summary IS NULL
    OR (octet_length(summary) BETWEEN 1 AND 4096 AND summary !~ '[[:cntrl:]]')
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ordinal),
  CONSTRAINT run_sources_citation_shape CHECK (
    (source_kind = 'brain-source-version' AND source_version_id IS NOT NULL AND external_locator IS NULL)
    OR (source_kind = 'external' AND source_version_id IS NULL AND external_locator IS NOT NULL)
  )
);

CREATE TABLE brain_evidence.run_tools (
  run_id text NOT NULL REFERENCES brain_evidence.completed_runs(run_id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  tool_use_id text NOT NULL CHECK (
    octet_length(tool_use_id) BETWEEN 1 AND 256
    AND tool_use_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  skill_ref text CHECK (
    skill_ref IS NULL
    OR (octet_length(skill_ref) BETWEEN 1 AND 256 AND skill_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
  ),
  summary text CHECK (
    summary IS NULL
    OR (octet_length(summary) BETWEEN 1 AND 4096 AND summary !~ '[[:cntrl:]]')
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ordinal)
);

CREATE TABLE brain_evidence.run_artifacts (
  run_id text NOT NULL REFERENCES brain_evidence.completed_runs(run_id),
  artifact_id text NOT NULL CHECK (
    octet_length(artifact_id) BETWEEN 1 AND 256
    AND artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 67108864),
  media_type text NOT NULL CHECK (
    octet_length(media_type) BETWEEN 1 AND 128 AND media_type !~ '[[:cntrl:]]'
  ),
  pointer_kind text NOT NULL CHECK (pointer_kind = 'external'),
  external_locator jsonb NOT NULL CHECK (
    jsonb_typeof(external_locator) = 'object' AND octet_length(external_locator::text) <= 4096
  ),
  privacy_class text NOT NULL CHECK (privacy_class IN ('public', 'internal', 'secret')),
  trust_class text NOT NULL CHECK (
    trust_class IN (
      'brain-structured',
      'brain-extract-untrusted',
      'tool-output-untrusted',
      'host-asserted',
      'legacy-unverified'
    )
  ),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, artifact_id)
);

CREATE TABLE brain_evidence.feedback (
  feedback_id text PRIMARY KEY CHECK (
    octet_length(feedback_id) BETWEEN 1 AND 256
    AND feedback_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  run_id text NOT NULL REFERENCES brain_evidence.completed_runs(run_id),
  signal text NOT NULL CHECK (signal IN ('positive', 'negative', 'mixed')),
  summary text NOT NULL CHECK (
    octet_length(summary) BETWEEN 1 AND 4096 AND summary !~ '[[:cntrl:]]'
  ),
  summary_hash text NOT NULL CHECK (summary_hash ~ '^sha256:[a-f0-9]{64}$'),
  privacy_class text NOT NULL CHECK (privacy_class IN ('public', 'internal', 'secret')),
  trust_class text NOT NULL CHECK (
    trust_class IN (
      'brain-structured',
      'brain-extract-untrusted',
      'tool-output-untrusted',
      'host-asserted',
      'legacy-unverified'
    )
  ),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536
  ),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- A human decision is PORTABLE EVIDENCE, never execution authority: there is no
-- pending/awaiting state, no enforcement column, and no transition. The host
-- presents, waits, enforces its own safety, and decides whether to proceed.
CREATE TABLE brain_evidence.human_decisions (
  decision_id text PRIMARY KEY CHECK (
    octet_length(decision_id) BETWEEN 1 AND 256
    AND decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  action jsonb NOT NULL CHECK (
    jsonb_typeof(action) = 'object' AND octet_length(action::text) <= 8192
  ),
  action_summary text NOT NULL CHECK (
    octet_length(action_summary) BETWEEN 1 AND 4096 AND action_summary !~ '[[:cntrl:]]'
  ),
  action_digest text NOT NULL CHECK (action_digest ~ '^sha256:[a-f0-9]{64}$'),
  requested_decision text NOT NULL CHECK (
    requested_decision IN ('approval', 'choice', 'confirmation')
  ),
  answer text NOT NULL CHECK (answer IN ('approved', 'rejected', 'revised', 'deferred')),
  privacy_class text NOT NULL CHECK (privacy_class IN ('public', 'internal', 'secret')),
  trust_class text NOT NULL CHECK (
    trust_class IN (
      'brain-structured',
      'brain-extract-untrusted',
      'tool-output-untrusted',
      'host-asserted',
      'legacy-unverified'
    )
  ),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  decided_at timestamptz NOT NULL,
  host_provenance jsonb NOT NULL CHECK (
    jsonb_typeof(host_provenance) = 'object' AND octet_length(host_provenance::text) <= 65536
  ),
  related_run_id text CHECK (
    related_run_id IS NULL
    OR (octet_length(related_run_id) BETWEEN 1 AND 256
        AND related_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
  ),
  related_artifact_id text CHECK (
    related_artifact_id IS NULL
    OR (octet_length(related_artifact_id) BETWEEN 1 AND 256
        AND related_artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$')
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT human_decisions_related_shape CHECK (
    related_artifact_id IS NULL OR related_run_id IS NOT NULL
  )
);

-- Lineage for the ONE evidence -> semantic path. `promotion_id` is derived from
-- the STABLE identity only (kind + composite evidence ids + promoted source
-- version), never the full request, so a conflicting re-promotion of the same
-- identity lands on this row and fails the canonical comparison instead of
-- minting a second lineage row. Several promoted source versions per evidence
-- item are legal; each is a distinct identity.
CREATE TABLE brain_evidence.evidence_promotions (
  promotion_id text PRIMARY KEY CHECK (promotion_id ~ '^sha256:[a-f0-9]{64}$'),
  record_canonical text NOT NULL CHECK (
    octet_length(record_canonical) <= 65536 AND record_canonical !~ '[[:cntrl:]]'
  ),
  workspace_id text NOT NULL CHECK (workspace_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  evidence_kind text NOT NULL CHECK (
    evidence_kind IN ('completed-run', 'run-artifact', 'feedback', 'human-decision')
  ),
  run_id text,
  artifact_id text,
  feedback_id text,
  decision_id text,
  promoted_source_version_id text NOT NULL
    REFERENCES brain.source_versions(source_version_id),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object' AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 65536
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_promotions_identity_shape CHECK (
    (evidence_kind = 'completed-run'
      AND run_id IS NOT NULL AND artifact_id IS NULL
      AND feedback_id IS NULL AND decision_id IS NULL)
    OR (evidence_kind = 'run-artifact'
      AND run_id IS NOT NULL AND artifact_id IS NOT NULL
      AND feedback_id IS NULL AND decision_id IS NULL)
    OR (evidence_kind = 'feedback'
      AND run_id IS NULL AND artifact_id IS NULL
      AND feedback_id IS NOT NULL AND decision_id IS NULL)
    OR (evidence_kind = 'human-decision'
      AND run_id IS NULL AND artifact_id IS NULL
      AND feedback_id IS NULL AND decision_id IS NOT NULL)
  ),
  CONSTRAINT evidence_promotions_run_fkey
    FOREIGN KEY (run_id) REFERENCES brain_evidence.completed_runs(run_id),
  CONSTRAINT evidence_promotions_artifact_fkey
    FOREIGN KEY (run_id, artifact_id)
    REFERENCES brain_evidence.run_artifacts(run_id, artifact_id),
  CONSTRAINT evidence_promotions_feedback_fkey
    FOREIGN KEY (feedback_id) REFERENCES brain_evidence.feedback(feedback_id),
  CONSTRAINT evidence_promotions_decision_fkey
    FOREIGN KEY (decision_id) REFERENCES brain_evidence.human_decisions(decision_id)
);

-- Per-kind partial unique indexes instead of UNIQUE NULLS NOT DISTINCT: the CI
-- image is PG16, but the SPEC promises "any compatible PostgreSQL", and partial
-- indexes keep that promise without raising the version floor. Defense in depth
-- beside the derived primary key.
CREATE UNIQUE INDEX evidence_promotions_run_identity
  ON brain_evidence.evidence_promotions (run_id, promoted_source_version_id)
  WHERE evidence_kind = 'completed-run';

CREATE UNIQUE INDEX evidence_promotions_artifact_identity
  ON brain_evidence.evidence_promotions (run_id, artifact_id, promoted_source_version_id)
  WHERE evidence_kind = 'run-artifact';

CREATE UNIQUE INDEX evidence_promotions_feedback_identity
  ON brain_evidence.evidence_promotions (feedback_id, promoted_source_version_id)
  WHERE evidence_kind = 'feedback';

CREATE UNIQUE INDEX evidence_promotions_decision_identity
  ON brain_evidence.evidence_promotions (decision_id, promoted_source_version_id)
  WHERE evidence_kind = 'human-decision';

CREATE INDEX completed_runs_labels_idx
  ON brain_evidence.completed_runs (function_id, agent_id, completed_at DESC);
CREATE INDEX run_artifacts_run_idx ON brain_evidence.run_artifacts (run_id);
CREATE INDEX feedback_run_idx ON brain_evidence.feedback (run_id);
CREATE INDEX run_sources_version_idx ON brain_evidence.run_sources (source_version_id);

-- --- record brokers -----------------------------------------------------------

CREATE FUNCTION brain_evidence.record_completed_run(p_record_canonical text)
RETURNS TABLE (status text, id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
DECLARE
  v_doc jsonb;
  v_run_id text;
  v_stored text;
  v_inserted integer;
  v_element jsonb;
BEGIN
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 262144 THEN
    PERFORM brain_evidence.reject_evidence_input('the run record exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'actor', 'agent_id', 'completed_at', 'function_id', 'host', 'host_version',
    'kind', 'outcome', 'plan_id', 'privacy_class', 'provenance', 'request_hash',
    'request_summary', 'roster_version', 'run_id', 'schema_version', 'sources',
    'started_at', 'tools', 'trust_class'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['completed-run']);
  PERFORM brain_evidence.assert_evidence_envelope(v_doc);
  PERFORM brain_evidence.assert_text(v_doc, 'run_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'function_id', 80, '^[a-z0-9]+(-[a-z0-9]+)*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'agent_id', 80, '^[a-z0-9]+(-[a-z0-9]+)*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'plan_id', 80, '^[a-z0-9]+(-[a-z0-9]+)*$', true);
  PERFORM brain_evidence.assert_member(v_doc, 'host', ARRAY['claude', 'codex']);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'host_version', 128, false);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'roster_version', 128, false);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'request_summary', 4096, false);
  PERFORM brain_evidence.assert_text(v_doc, 'request_hash', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_instant(v_doc, 'started_at');
  PERFORM brain_evidence.assert_instant(v_doc, 'completed_at');
  PERFORM brain_evidence.assert_member(v_doc, 'outcome', ARRAY['succeeded', 'failed', 'partial', 'aborted']);
  PERFORM brain_evidence.assert_safe_object(v_doc, 'provenance', 65536, false);
  IF jsonb_typeof(v_doc->'sources') <> 'array' OR jsonb_array_length(v_doc->'sources') > 64 THEN
    PERFORM brain_evidence.reject_evidence_input('sources must be an array of at most 64 citations');
  END IF;
  IF jsonb_typeof(v_doc->'tools') <> 'array' OR jsonb_array_length(v_doc->'tools') > 64 THEN
    PERFORM brain_evidence.reject_evidence_input('tools must be an array of at most 64 tool uses');
  END IF;
  FOR v_element IN SELECT value FROM jsonb_array_elements(v_doc->'sources') LOOP
    PERFORM brain_evidence.assert_keys(v_element, ARRAY['kind', 'locator', 'source_version_id', 'summary']);
    PERFORM brain_evidence.assert_member(v_element, 'kind', ARRAY['brain-source-version', 'external']);
    PERFORM brain_evidence.assert_text(v_element, 'source_version_id', 256, '^sha256:[a-f0-9]{64}$', true);
    PERFORM brain_evidence.assert_safe_object(v_element, 'locator', 4096, true);
    PERFORM brain_evidence.assert_safe_text(v_element, 'summary', 4096, true);
    IF (v_element->>'kind') = 'brain-source-version' THEN
      IF jsonb_typeof(v_element->'source_version_id') <> 'string'
         OR jsonb_typeof(v_element->'locator') <> 'null' THEN
        PERFORM brain_evidence.reject_evidence_input('a Brain citation needs a source version and no locator');
      END IF;
    ELSIF jsonb_typeof(v_element->'source_version_id') <> 'null'
       OR jsonb_typeof(v_element->'locator') <> 'object' THEN
      PERFORM brain_evidence.reject_evidence_input('an external citation needs a locator and no source version');
    END IF;
  END LOOP;
  FOR v_element IN SELECT value FROM jsonb_array_elements(v_doc->'tools') LOOP
    PERFORM brain_evidence.assert_keys(v_element, ARRAY['skill_ref', 'summary', 'tool_use_id']);
    PERFORM brain_evidence.assert_text(v_element, 'tool_use_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
    PERFORM brain_evidence.assert_text(v_element, 'skill_ref', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', true);
    PERFORM brain_evidence.assert_safe_text(v_element, 'summary', 4096, true);
  END LOOP;

  v_run_id := v_doc->>'run_id';
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.evidence.lock.run.v1', ARRAY[v_run_id])
  );

  INSERT INTO brain_evidence.completed_runs (
    run_id, record_canonical, workspace_id, function_id, agent_id, plan_id,
    host, host_version, roster_version, request_summary, request_hash,
    started_at, completed_at, outcome, privacy_class, trust_class,
    actor_assurance, assurance_evidence, provenance
  ) VALUES (
    v_run_id,
    p_record_canonical,
    brain_evidence.workspace_identity_id(),
    v_doc->>'function_id',
    v_doc->>'agent_id',
    v_doc->>'plan_id',
    v_doc->>'host',
    v_doc->>'host_version',
    v_doc->>'roster_version',
    v_doc->>'request_summary',
    v_doc->>'request_hash',
    (v_doc->>'started_at')::timestamptz,
    (v_doc->>'completed_at')::timestamptz,
    v_doc->>'outcome',
    v_doc->>'privacy_class',
    v_doc->>'trust_class',
    v_doc->'actor'->>'assurance',
    v_doc->'actor',
    v_doc->'provenance'
  )
  ON CONFLICT (run_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    INSERT INTO brain_evidence.run_sources (
      run_id, ordinal, source_kind, source_version_id, external_locator, summary
    )
    SELECT
      v_run_id,
      (citation.position - 1)::integer,
      citation.value->>'kind',
      citation.value->>'source_version_id',
      CASE WHEN jsonb_typeof(citation.value->'locator') = 'null'
             THEN NULL ELSE citation.value->'locator' END,
      citation.value->>'summary'
      FROM jsonb_array_elements(v_doc->'sources') WITH ORDINALITY AS citation(value, position);

    INSERT INTO brain_evidence.run_tools (run_id, ordinal, tool_use_id, skill_ref, summary)
    SELECT
      v_run_id,
      (usage.position - 1)::integer,
      usage.value->>'tool_use_id',
      usage.value->>'skill_ref',
      usage.value->>'summary'
      FROM jsonb_array_elements(v_doc->'tools') WITH ORDINALITY AS usage(value, position);

    RETURN QUERY SELECT 'created'::text, v_run_id;
    RETURN;
  END IF;

  SELECT stored.record_canonical INTO v_stored
    FROM brain_evidence.completed_runs stored WHERE stored.run_id = v_run_id;
  IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
    RAISE EXCEPTION 'a different completed run is already recorded under this run id'
      USING ERRCODE = 'RBE02';
  END IF;
  RETURN QUERY SELECT 'existing'::text, v_run_id;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the evidence payload violates the closed evidence schema'
      USING ERRCODE = 'RBE01';
END;
$fn$;

CREATE FUNCTION brain_evidence.record_run_artifact(p_record_canonical text)
RETURNS TABLE (status text, id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
DECLARE
  v_doc jsonb;
  v_run_id text;
  v_artifact_id text;
  v_stored text;
  v_inserted integer;
BEGIN
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 65536 THEN
    PERFORM brain_evidence.reject_evidence_input('the artifact record exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'actor', 'artifact_id', 'byte_length', 'external_locator', 'kind',
    'media_type', 'pointer_kind', 'privacy_class', 'provenance', 'run_id',
    'schema_version', 'sha256', 'trust_class'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['run-artifact']);
  PERFORM brain_evidence.assert_evidence_envelope(v_doc);
  PERFORM brain_evidence.assert_text(v_doc, 'run_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'artifact_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'sha256', 64, '^[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_integer(v_doc, 'byte_length', 0, 67108864);
  PERFORM brain_evidence.assert_text(v_doc, 'media_type', 128, NULL, false);
  PERFORM brain_evidence.assert_member(v_doc, 'pointer_kind', ARRAY['external']);
  PERFORM brain_evidence.assert_safe_object(v_doc, 'external_locator', 4096, false);
  PERFORM brain_evidence.assert_safe_object(v_doc, 'provenance', 65536, false);

  v_run_id := v_doc->>'run_id';
  v_artifact_id := v_doc->>'artifact_id';
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.evidence.lock.artifact.v1', ARRAY[v_run_id, v_artifact_id])
  );

  INSERT INTO brain_evidence.run_artifacts (
    run_id, artifact_id, record_canonical, workspace_id, sha256, byte_length,
    media_type, pointer_kind, external_locator, privacy_class, trust_class,
    actor_assurance, assurance_evidence, provenance
  ) VALUES (
    v_run_id,
    v_artifact_id,
    p_record_canonical,
    brain_evidence.workspace_identity_id(),
    v_doc->>'sha256',
    (v_doc->>'byte_length')::bigint,
    v_doc->>'media_type',
    v_doc->>'pointer_kind',
    v_doc->'external_locator',
    v_doc->>'privacy_class',
    v_doc->>'trust_class',
    v_doc->'actor'->>'assurance',
    v_doc->'actor',
    v_doc->'provenance'
  )
  ON CONFLICT (run_id, artifact_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'created'::text, v_run_id || '/' || v_artifact_id;
    RETURN;
  END IF;

  SELECT stored.record_canonical INTO v_stored
    FROM brain_evidence.run_artifacts stored
   WHERE stored.run_id = v_run_id AND stored.artifact_id = v_artifact_id;
  IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
    RAISE EXCEPTION 'a different artifact is already recorded under this identity'
      USING ERRCODE = 'RBE02';
  END IF;
  RETURN QUERY SELECT 'existing'::text, v_run_id || '/' || v_artifact_id;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the evidence payload violates the closed evidence schema'
      USING ERRCODE = 'RBE01';
END;
$fn$;

CREATE FUNCTION brain_evidence.record_feedback(p_record_canonical text)
RETURNS TABLE (status text, id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
DECLARE
  v_doc jsonb;
  v_feedback_id text;
  v_stored text;
  v_inserted integer;
BEGIN
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 65536 THEN
    PERFORM brain_evidence.reject_evidence_input('the feedback record exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'actor', 'feedback_id', 'kind', 'privacy_class', 'provenance', 'run_id',
    'schema_version', 'signal', 'summary', 'summary_hash', 'trust_class'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['feedback']);
  PERFORM brain_evidence.assert_evidence_envelope(v_doc);
  PERFORM brain_evidence.assert_text(v_doc, 'feedback_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_text(v_doc, 'run_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_member(v_doc, 'signal', ARRAY['positive', 'negative', 'mixed']);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'summary', 4096, false);
  PERFORM brain_evidence.assert_text(v_doc, 'summary_hash', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_safe_object(v_doc, 'provenance', 65536, false);

  v_feedback_id := v_doc->>'feedback_id';
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.evidence.lock.feedback.v1', ARRAY[v_feedback_id])
  );

  INSERT INTO brain_evidence.feedback (
    feedback_id, record_canonical, workspace_id, run_id, signal, summary,
    summary_hash, privacy_class, trust_class, actor_assurance,
    assurance_evidence, provenance
  ) VALUES (
    v_feedback_id,
    p_record_canonical,
    brain_evidence.workspace_identity_id(),
    v_doc->>'run_id',
    v_doc->>'signal',
    v_doc->>'summary',
    v_doc->>'summary_hash',
    v_doc->>'privacy_class',
    v_doc->>'trust_class',
    v_doc->'actor'->>'assurance',
    v_doc->'actor',
    v_doc->'provenance'
  )
  ON CONFLICT (feedback_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'created'::text, v_feedback_id;
    RETURN;
  END IF;

  SELECT stored.record_canonical INTO v_stored
    FROM brain_evidence.feedback stored WHERE stored.feedback_id = v_feedback_id;
  IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
    RAISE EXCEPTION 'different feedback is already recorded under this identity'
      USING ERRCODE = 'RBE02';
  END IF;
  RETURN QUERY SELECT 'existing'::text, v_feedback_id;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the evidence payload violates the closed evidence schema'
      USING ERRCODE = 'RBE01';
END;
$fn$;

CREATE FUNCTION brain_evidence.record_human_decision(p_record_canonical text)
RETURNS TABLE (status text, id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain_evidence, brain_meta, pg_temp
AS $fn$
DECLARE
  v_doc jsonb;
  v_decision_id text;
  v_stored text;
  v_inserted integer;
BEGIN
  IF p_record_canonical IS NULL OR octet_length(p_record_canonical) > 65536 THEN
    PERFORM brain_evidence.reject_evidence_input('the decision record exceeds its canonical byte cap');
  END IF;
  v_doc := p_record_canonical::jsonb;
  PERFORM brain_evidence.assert_keys(v_doc, ARRAY[
    'action', 'action_digest', 'action_summary', 'actor', 'answer', 'decided_at',
    'decision_id', 'host_provenance', 'kind', 'privacy_class',
    'related_artifact_id', 'related_run_id', 'requested_decision',
    'schema_version', 'trust_class'
  ]);
  PERFORM brain_evidence.assert_member(v_doc, 'kind', ARRAY['human-decision']);
  PERFORM brain_evidence.assert_evidence_envelope(v_doc);
  PERFORM brain_evidence.assert_text(v_doc, 'decision_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', false);
  PERFORM brain_evidence.assert_object(v_doc, 'action', 8192, false);
  PERFORM brain_evidence.assert_keys(v_doc->'action', ARRAY['effect', 'params', 'scope', 'target']);
  PERFORM brain_evidence.assert_safe_text(v_doc->'action', 'target', 256, false);
  PERFORM brain_evidence.assert_safe_text(v_doc->'action', 'effect', 256, false);
  PERFORM brain_evidence.assert_safe_text(v_doc->'action', 'scope', 256, false);
  PERFORM brain_evidence.assert_safe_object(v_doc->'action', 'params', 8192, false);
  PERFORM brain_evidence.assert_text(v_doc, 'action_digest', 256, '^sha256:[a-f0-9]{64}$', false);
  PERFORM brain_evidence.assert_safe_text(v_doc, 'action_summary', 4096, false);
  PERFORM brain_evidence.assert_member(v_doc, 'requested_decision', ARRAY['approval', 'choice', 'confirmation']);
  PERFORM brain_evidence.assert_member(v_doc, 'answer', ARRAY['approved', 'rejected', 'revised', 'deferred']);
  PERFORM brain_evidence.assert_instant(v_doc, 'decided_at');
  PERFORM brain_evidence.assert_safe_object(v_doc, 'host_provenance', 65536, false);
  PERFORM brain_evidence.assert_text(v_doc, 'related_run_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', true);
  PERFORM brain_evidence.assert_text(v_doc, 'related_artifact_id', 256, '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$', true);
  IF jsonb_typeof(v_doc->'related_artifact_id') = 'string'
     AND jsonb_typeof(v_doc->'related_run_id') <> 'string' THEN
    PERFORM brain_evidence.reject_evidence_input('a related artifact requires its related run');
  END IF;

  v_decision_id := v_doc->>'decision_id';
  PERFORM pg_advisory_xact_lock(
    brain_evidence.lock_key('roster.brain.evidence.lock.decision.v1', ARRAY[v_decision_id])
  );

  INSERT INTO brain_evidence.human_decisions (
    decision_id, record_canonical, workspace_id, action, action_summary,
    action_digest, requested_decision, answer, privacy_class, trust_class,
    actor_assurance, assurance_evidence, decided_at, host_provenance,
    related_run_id, related_artifact_id
  ) VALUES (
    v_decision_id,
    p_record_canonical,
    brain_evidence.workspace_identity_id(),
    v_doc->'action',
    v_doc->>'action_summary',
    v_doc->>'action_digest',
    v_doc->>'requested_decision',
    v_doc->>'answer',
    v_doc->>'privacy_class',
    v_doc->>'trust_class',
    v_doc->'actor'->>'assurance',
    v_doc->'actor',
    (v_doc->>'decided_at')::timestamptz,
    v_doc->'host_provenance',
    v_doc->>'related_run_id',
    v_doc->>'related_artifact_id'
  )
  ON CONFLICT (decision_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 1 THEN
    RETURN QUERY SELECT 'created'::text, v_decision_id;
    RETURN;
  END IF;

  SELECT stored.record_canonical INTO v_stored
    FROM brain_evidence.human_decisions stored WHERE stored.decision_id = v_decision_id;
  IF convert_to(v_stored, 'UTF8') IS DISTINCT FROM convert_to(p_record_canonical, 'UTF8') THEN
    RAISE EXCEPTION 'a different human decision is already recorded under this identity'
      USING ERRCODE = 'RBE02';
  END IF;
  RETURN QUERY SELECT 'existing'::text, v_decision_id;
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'a referenced evidence row does not exist' USING ERRCODE = 'RBE03';
  WHEN check_violation OR not_null_violation OR invalid_text_representation
    OR string_data_right_truncation OR numeric_value_out_of_range
    OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'the evidence payload violates the closed evidence schema'
      USING ERRCODE = 'RBE01';
END;
$fn$;

-- --- append-only enforcement --------------------------------------------------

CREATE FUNCTION brain_evidence.reject_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_evidence, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END;
$fn$;

CREATE TRIGGER completed_runs_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.completed_runs
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER completed_runs_no_truncate
  BEFORE TRUNCATE ON brain_evidence.completed_runs
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER run_sources_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.run_sources
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER run_sources_no_truncate
  BEFORE TRUNCATE ON brain_evidence.run_sources
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER run_tools_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.run_tools
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER run_tools_no_truncate
  BEFORE TRUNCATE ON brain_evidence.run_tools
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER run_artifacts_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.run_artifacts
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER run_artifacts_no_truncate
  BEFORE TRUNCATE ON brain_evidence.run_artifacts
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER feedback_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.feedback
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER feedback_no_truncate
  BEFORE TRUNCATE ON brain_evidence.feedback
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER human_decisions_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.human_decisions
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER human_decisions_no_truncate
  BEFORE TRUNCATE ON brain_evidence.human_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

CREATE TRIGGER evidence_promotions_immutable
  BEFORE UPDATE OR DELETE ON brain_evidence.evidence_promotions
  FOR EACH ROW EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();
CREATE TRIGGER evidence_promotions_no_truncate
  BEFORE TRUNCATE ON brain_evidence.evidence_promotions
  FOR EACH STATEMENT EXECUTE FUNCTION brain_evidence.reject_evidence_mutation();

-- --- privileges ---------------------------------------------------------------

REVOKE ALL PRIVILEGES ON brain_evidence.completed_runs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.run_sources FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.run_tools FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.run_artifacts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.feedback FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.human_decisions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_evidence.evidence_promotions FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION brain_evidence.lock_frame(text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.lock_key(text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.reject_evidence_input(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_keys(jsonb, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_text(jsonb, text, integer, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_member(jsonb, text, text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_object(jsonb, text, integer, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_instant(jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_integer(jsonb, text, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_no_credential_shape(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_safe_text(jsonb, text, integer, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_safe_object(jsonb, text, integer, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_actor(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.assert_evidence_envelope(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.workspace_identity_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.reject_evidence_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.record_completed_run(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.record_run_artifact(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.record_feedback(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_evidence.record_human_decision(text) FROM PUBLIC;
