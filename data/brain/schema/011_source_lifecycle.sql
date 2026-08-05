CREATE TABLE brain_meta.runtime_protected_tables (
  table_name text PRIMARY KEY CHECK (
    octet_length(table_name) BETWEEN 1 AND 63
    AND table_name ~ '^[a-z_][a-z0-9_]*$'
  )
);

REVOKE ALL PRIVILEGES ON brain_meta.runtime_protected_tables FROM PUBLIC;

CREATE TABLE brain.source_objects (
  object_id text PRIMARY KEY CHECK (object_id ~ '^sha256:[a-f0-9]{64}$'),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^objects/[a-f0-9]{2}/[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
  etag text CHECK (
    etag IS NULL
    OR (octet_length(etag) BETWEEN 1 AND 1024 AND etag !~ '[[:cntrl:]]')
  ),
  s3_version_id text CHECK (
    s3_version_id IS NULL
    OR (octet_length(s3_version_id) BETWEEN 1 AND 1024 AND s3_version_id !~ '[[:cntrl:]]')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_objects_identity_matches_hash CHECK (object_id = 'sha256:' || sha256),
  CONSTRAINT source_objects_key_matches_hash CHECK (
    object_key = 'objects/' || left(sha256, 2) || '/' || sha256
  )
);

CREATE TABLE brain.logical_sources (
  source_id text PRIMARY KEY CHECK (source_id ~ '^sha256:[a-f0-9]{64}$'),
  source_kind text NOT NULL CHECK (
    source_kind IN ('workspace-file', 'fetched-media', 'inline-text', 'structured-record', 'produced-artifact')
  ),
  origin_fingerprint text NOT NULL CHECK (origin_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  origin jsonb NOT NULL CHECK (
    jsonb_typeof(origin) = 'object'
    AND octet_length(origin::text) <= 262144
  ),
  next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
  current_sequence bigint NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
  current_version_id text CHECK (
    current_version_id IS NULL OR current_version_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  active_tombstone_id text CHECK (
    active_tombstone_id IS NULL OR active_tombstone_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_kind, origin_fingerprint),
  CONSTRAINT logical_sources_sequence_bounds CHECK (current_sequence <= next_sequence),
  CONSTRAINT logical_sources_current_shape CHECK (
    (current_sequence = 0 AND current_version_id IS NULL AND active_tombstone_id IS NULL)
    OR (current_sequence > 0 AND current_version_id IS NOT NULL)
  )
);

CREATE TABLE brain.source_versions (
  source_version_id text PRIMARY KEY CHECK (source_version_id ~ '^sha256:[a-f0-9]{64}$'),
  source_id text NOT NULL REFERENCES brain.logical_sources(source_id),
  version_fingerprint text NOT NULL CHECK (version_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  object_id text NOT NULL REFERENCES brain.source_objects(object_id),
  first_prepared_sequence bigint NOT NULL CHECK (first_prepared_sequence > 0),
  media_type text NOT NULL CHECK (
    octet_length(media_type) BETWEEN 1 AND 255
    AND media_type !~ '[[:cntrl:]]'
  ),
  source_timestamp timestamptz,
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
    jsonb_typeof(assurance_evidence) = 'object'
    AND octet_length(assurance_evidence::text) <= 65536
  ),
  metadata jsonb NOT NULL CHECK (
    jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 262144
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 262144
  ),
  locators jsonb NOT NULL CHECK (
    jsonb_typeof(locators) = 'array'
    AND octet_length(locators::text) <= 262144
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_fingerprint),
  UNIQUE (source_id, source_version_id),
  UNIQUE (source_id, first_prepared_sequence)
);

CREATE TABLE brain.source_version_labels (
  source_version_id text NOT NULL REFERENCES brain.source_versions(source_version_id),
  function_id text CHECK (
    function_id IS NULL
    OR (
      octet_length(function_id) BETWEEN 1 AND 80
      AND function_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  ),
  agent_id text CHECK (
    agent_id IS NULL
    OR (
      octet_length(agent_id) BETWEEN 1 AND 80
      AND agent_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  ),
  plan_id text CHECK (
    plan_id IS NULL
    OR (
      octet_length(plan_id) BETWEEN 1 AND 80
      AND plan_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    )
  ),
  label_key text GENERATED ALWAYS AS (
    CASE
      WHEN function_id IS NULL THEN 'workspace'
      WHEN agent_id IS NULL THEN 'function:' || function_id
      WHEN plan_id IS NULL THEN 'agent:' || function_id || '/' || agent_id
      ELSE 'plan:' || function_id || '/' || agent_id || '#' || plan_id
    END
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_version_id, label_key),
  CONSTRAINT source_version_labels_complete_hierarchy CHECK (
    (function_id IS NOT NULL OR (agent_id IS NULL AND plan_id IS NULL))
    AND (agent_id IS NULL OR function_id IS NOT NULL)
    AND (plan_id IS NULL OR (function_id IS NOT NULL AND agent_id IS NOT NULL))
  )
);

CREATE TABLE brain.source_tombstones (
  tombstone_id text PRIMARY KEY CHECK (tombstone_id ~ '^sha256:[a-f0-9]{64}$'),
  source_id text NOT NULL REFERENCES brain.logical_sources(source_id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  prior_version_id text NOT NULL CHECK (prior_version_id ~ '^sha256:[a-f0-9]{64}$'),
  request_key text NOT NULL UNIQUE CHECK (
    octet_length(request_key) BETWEEN 1 AND 256
    AND request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  reason text CHECK (
    reason IS NULL
    OR (octet_length(reason) BETWEEN 1 AND 2048 AND reason !~ '[[:cntrl:]]')
  ),
  actor_assurance text NOT NULL CHECK (
    actor_assurance IN ('system-derived', 'caller-asserted', 'host-attested', 'human-confirmed')
  ),
  assurance_evidence jsonb NOT NULL CHECK (
    jsonb_typeof(assurance_evidence) = 'object'
    AND octet_length(assurance_evidence::text) <= 65536
  ),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance) = 'object'
    AND octet_length(provenance::text) <= 262144
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_sequence bigint,
  restored_version_id text CHECK (
    restored_version_id IS NULL OR restored_version_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  restore_request_key text CHECK (
    restore_request_key IS NULL
    OR (
      octet_length(restore_request_key) BETWEEN 1 AND 256
      AND restore_request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
    )
  ),
  restore_request_fingerprint text CHECK (
    restore_request_fingerprint IS NULL OR restore_request_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  restored_by_intent_id text CHECK (
    restored_by_intent_id IS NULL OR restored_by_intent_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  restored_at timestamptz,
  UNIQUE (source_id, tombstone_id),
  UNIQUE (source_id, sequence),
  CONSTRAINT source_tombstones_prior_version_fkey
    FOREIGN KEY (source_id, prior_version_id)
    REFERENCES brain.source_versions(source_id, source_version_id),
  CONSTRAINT source_tombstones_restoration_shape CHECK (
    (
      restored_sequence IS NULL
      AND restored_version_id IS NULL
      AND restore_request_key IS NULL
      AND restore_request_fingerprint IS NULL
      AND restored_by_intent_id IS NULL
      AND restored_at IS NULL
    )
    OR (
      restored_sequence IS NOT NULL
      AND restored_sequence > sequence
      AND restored_version_id IS NOT NULL
      AND restored_at IS NOT NULL
      AND (
        (
          restore_request_key IS NOT NULL
          AND restore_request_fingerprint IS NOT NULL
          AND restored_by_intent_id IS NULL
        )
        OR (
          restore_request_key IS NULL
          AND restore_request_fingerprint IS NULL
          AND restored_by_intent_id IS NOT NULL
        )
      )
    )
  )
);

CREATE UNIQUE INDEX source_tombstones_restore_request_key_idx
  ON brain.source_tombstones (restore_request_key)
  WHERE restore_request_key IS NOT NULL;

CREATE TABLE brain.ingest_intents (
  intent_id text PRIMARY KEY CHECK (intent_id ~ '^sha256:[a-f0-9]{64}$'),
  request_key text NOT NULL UNIQUE CHECK (
    octet_length(request_key) BETWEEN 1 AND 256
    AND request_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$'
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  source_id text NOT NULL REFERENCES brain.logical_sources(source_id),
  prepared_sequence bigint NOT NULL CHECK (prepared_sequence > 0),
  source_version_id text NOT NULL CHECK (source_version_id ~ '^sha256:[a-f0-9]{64}$'),
  version_fingerprint text NOT NULL CHECK (version_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  object_id text NOT NULL CHECK (object_id ~ '^sha256:[a-f0-9]{64}$'),
  object_sha256 text NOT NULL CHECK (object_sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL CHECK (object_key ~ '^objects/[a-f0-9]{2}/[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
  expected_tombstone_id text CHECK (
    expected_tombstone_id IS NULL OR expected_tombstone_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  request_payload jsonb NOT NULL CHECK (
    jsonb_typeof(request_payload) = 'object'
    AND octet_length(request_payload::text) <= 524288
  ),
  state text NOT NULL CHECK (state IN ('prepared', 'complete')),
  published_version_id text CHECK (
    published_version_id IS NULL OR published_version_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  published_object_id text CHECK (
    published_object_id IS NULL OR published_object_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  published_as_current boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (source_id, intent_id),
  UNIQUE (source_id, prepared_sequence),
  CONSTRAINT ingest_intents_object_identity_matches_hash CHECK (
    object_id = 'sha256:' || object_sha256
  ),
  CONSTRAINT ingest_intents_object_key_matches_hash CHECK (
    object_key = 'objects/' || left(object_sha256, 2) || '/' || object_sha256
  ),
  CONSTRAINT ingest_intents_state_shape CHECK (
    (
      state = 'prepared'
      AND published_version_id IS NULL
      AND published_object_id IS NULL
      AND published_as_current IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'complete'
      AND published_version_id IS NOT NULL
      AND published_version_id = source_version_id
      AND published_object_id IS NOT NULL
      AND published_object_id = object_id
      AND published_as_current IS NOT NULL
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT ingest_intents_expected_tombstone_fkey
    FOREIGN KEY (source_id, expected_tombstone_id)
    REFERENCES brain.source_tombstones(source_id, tombstone_id),
  CONSTRAINT ingest_intents_published_version_fkey
    FOREIGN KEY (source_id, published_version_id)
    REFERENCES brain.source_versions(source_id, source_version_id),
  CONSTRAINT ingest_intents_published_object_fkey
    FOREIGN KEY (published_object_id)
    REFERENCES brain.source_objects(object_id)
);

ALTER TABLE brain.source_tombstones
  ADD CONSTRAINT source_tombstones_restored_version_fkey
  FOREIGN KEY (source_id, restored_version_id)
  REFERENCES brain.source_versions(source_id, source_version_id);

ALTER TABLE brain.source_tombstones
  ADD CONSTRAINT source_tombstones_restored_intent_fkey
  FOREIGN KEY (source_id, restored_by_intent_id)
  REFERENCES brain.ingest_intents(source_id, intent_id);

ALTER TABLE brain.logical_sources
  ADD CONSTRAINT logical_sources_current_version_fkey
  FOREIGN KEY (source_id, current_version_id)
  REFERENCES brain.source_versions(source_id, source_version_id);

ALTER TABLE brain.logical_sources
  ADD CONSTRAINT logical_sources_active_tombstone_fkey
  FOREIGN KEY (source_id, active_tombstone_id)
  REFERENCES brain.source_tombstones(source_id, tombstone_id);

CREATE OR REPLACE FUNCTION brain.reject_source_lifecycle_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, brain_meta, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
END;
$fn$;

CREATE OR REPLACE FUNCTION brain.guard_logical_source_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
    OR NEW.origin_fingerprint IS DISTINCT FROM OLD.origin_fingerprint
    OR NEW.origin IS DISTINCT FROM OLD.origin
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'logical source identity is immutable';
  END IF;
  IF NEW.next_sequence < OLD.next_sequence
    OR NEW.current_sequence < OLD.current_sequence
    OR NEW.current_sequence > NEW.next_sequence THEN
    RAISE EXCEPTION 'logical source sequence cannot rewind';
  END IF;
  IF (
    NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
    OR NEW.active_tombstone_id IS DISTINCT FROM OLD.active_tombstone_id
  ) AND NEW.current_sequence <= OLD.current_sequence THEN
    RAISE EXCEPTION 'logical source pointer changes require a newer sequence';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION brain.guard_source_tombstone_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.restored_at IS NULL
    AND NEW.tombstone_id IS NOT DISTINCT FROM OLD.tombstone_id
    AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
    AND NEW.sequence IS NOT DISTINCT FROM OLD.sequence
    AND NEW.prior_version_id IS NOT DISTINCT FROM OLD.prior_version_id
    AND NEW.request_key IS NOT DISTINCT FROM OLD.request_key
    AND NEW.request_fingerprint IS NOT DISTINCT FROM OLD.request_fingerprint
    AND NEW.reason IS NOT DISTINCT FROM OLD.reason
    AND NEW.actor_assurance IS NOT DISTINCT FROM OLD.actor_assurance
    AND NEW.assurance_evidence IS NOT DISTINCT FROM OLD.assurance_evidence
    AND NEW.provenance IS NOT DISTINCT FROM OLD.provenance
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NEW.restored_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'source tombstone may only transition once to restored';
END;
$fn$;

CREATE OR REPLACE FUNCTION brain.guard_ingest_intent_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
BEGIN
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'prepared'
    AND NEW.state = 'complete'
    AND NEW.intent_id IS NOT DISTINCT FROM OLD.intent_id
    AND NEW.request_key IS NOT DISTINCT FROM OLD.request_key
    AND NEW.request_fingerprint IS NOT DISTINCT FROM OLD.request_fingerprint
    AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
    AND NEW.prepared_sequence IS NOT DISTINCT FROM OLD.prepared_sequence
    AND NEW.source_version_id IS NOT DISTINCT FROM OLD.source_version_id
    AND NEW.version_fingerprint IS NOT DISTINCT FROM OLD.version_fingerprint
    AND NEW.object_id IS NOT DISTINCT FROM OLD.object_id
    AND NEW.object_sha256 IS NOT DISTINCT FROM OLD.object_sha256
    AND NEW.object_key IS NOT DISTINCT FROM OLD.object_key
    AND NEW.size_bytes IS NOT DISTINCT FROM OLD.size_bytes
    AND NEW.expected_tombstone_id IS NOT DISTINCT FROM OLD.expected_tombstone_id
    AND NEW.request_payload IS NOT DISTINCT FROM OLD.request_payload
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ingest intent may only transition from prepared to complete';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.reject_source_lifecycle_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain.guard_logical_source_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain.guard_source_tombstone_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain.guard_ingest_intent_update() FROM PUBLIC;

CREATE TRIGGER runtime_protected_tables_immutable
  BEFORE UPDATE OR DELETE ON brain_meta.runtime_protected_tables
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER runtime_protected_tables_no_truncate
  BEFORE TRUNCATE ON brain_meta.runtime_protected_tables
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_objects_immutable
  BEFORE UPDATE OR DELETE ON brain.source_objects
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_objects_no_truncate
  BEFORE TRUNCATE ON brain.source_objects
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER logical_sources_guard_update
  BEFORE UPDATE ON brain.logical_sources
  FOR EACH ROW EXECUTE FUNCTION brain.guard_logical_source_update();

CREATE TRIGGER logical_sources_no_delete
  BEFORE DELETE ON brain.logical_sources
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER logical_sources_no_truncate
  BEFORE TRUNCATE ON brain.logical_sources
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_versions_immutable
  BEFORE UPDATE OR DELETE ON brain.source_versions
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_versions_no_truncate
  BEFORE TRUNCATE ON brain.source_versions
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_version_labels_immutable
  BEFORE UPDATE OR DELETE ON brain.source_version_labels
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_version_labels_no_truncate
  BEFORE TRUNCATE ON brain.source_version_labels
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_tombstones_guard_update
  BEFORE UPDATE ON brain.source_tombstones
  FOR EACH ROW EXECUTE FUNCTION brain.guard_source_tombstone_update();

CREATE TRIGGER source_tombstones_no_delete
  BEFORE DELETE ON brain.source_tombstones
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_tombstones_no_truncate
  BEFORE TRUNCATE ON brain.source_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER ingest_intents_guard_update
  BEFORE UPDATE ON brain.ingest_intents
  FOR EACH ROW EXECUTE FUNCTION brain.guard_ingest_intent_update();

CREATE TRIGGER ingest_intents_no_delete
  BEFORE DELETE ON brain.ingest_intents
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER ingest_intents_no_truncate
  BEFORE TRUNCATE ON brain.ingest_intents
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

INSERT INTO brain_meta.runtime_protected_tables (table_name) VALUES
  ('source_objects'),
  ('logical_sources'),
  ('source_versions'),
  ('source_version_labels'),
  ('source_tombstones'),
  ('ingest_intents');

REVOKE ALL PRIVILEGES ON brain.source_objects FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.logical_sources FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.source_versions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.source_version_labels FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.source_tombstones FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.ingest_intents FROM PUBLIC;
