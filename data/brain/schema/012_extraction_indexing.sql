-- #370: versioned, cited extraction and indexing over the 011 immutable source
-- lifecycle. Lexical (tsvector/GIN) and structured (jsonb/partial GIN) indexing
-- require no embedding credential; embeddings are optional, provider-neutral,
-- and EXACT-ONLY here — measured ANN indexes belong to the retrieval ticket.

-- Active-extractor registry. Admin-owned; the runtime role gets no direct grant
-- and reads it only through the owner-privileged current view. Version bumps
-- ship as later migrations, guarded to a monotone increase.
CREATE TABLE brain_meta.active_extractors (
  extractor_name text PRIMARY KEY CHECK (
    extractor_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND octet_length(extractor_name) BETWEEN 1 AND 80
  ),
  active_version integer NOT NULL CHECK (active_version >= 1)
);

INSERT INTO brain_meta.active_extractors (extractor_name, active_version) VALUES
  ('roster-text', 1),
  ('roster-structured', 1);

CREATE TABLE brain.source_extractions (
  extraction_id text PRIMARY KEY CHECK (extraction_id ~ '^sha256:[a-f0-9]{64}$'),
  source_id text NOT NULL,
  source_version_id text NOT NULL,
  extractor_name text NOT NULL CHECK (
    extractor_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND octet_length(extractor_name) BETWEEN 1 AND 80
  ),
  extractor_version integer NOT NULL CHECK (extractor_version >= 1),
  status text NOT NULL CHECK (status IN ('complete', 'unsupported')),
  unsupported_reason text CHECK (
    unsupported_reason IN ('media-type', 'invalid-utf8', 'binary', 'too-large')
  ),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 0 AND 65536),
  text_sha256 text CHECK (text_sha256 IS NULL OR text_sha256 ~ '^[a-f0-9]{64}$'),
  structured jsonb CHECK (
    structured IS NULL
    OR (
      jsonb_typeof(structured) IN ('object', 'array')
      AND octet_length(structured::text) <= 262144
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_version_id, extractor_name, extractor_version),
  UNIQUE (extraction_id, source_version_id),
  FOREIGN KEY (source_id, source_version_id)
    REFERENCES brain.source_versions(source_id, source_version_id),
  CONSTRAINT source_extractions_status_shape CHECK (
    (status = 'complete' AND unsupported_reason IS NULL AND text_sha256 IS NOT NULL)
    OR (
      status = 'unsupported'
      AND unsupported_reason IS NOT NULL
      AND chunk_count = 0
      AND text_sha256 IS NULL
      AND structured IS NULL
    )
  )
);

CREATE INDEX source_extractions_structured_gin
  ON brain.source_extractions USING gin (structured jsonb_path_ops)
  WHERE structured IS NOT NULL;

CREATE INDEX source_extractions_extractor_idx
  ON brain.source_extractions (extractor_name, extractor_version);

CREATE TABLE brain.source_chunks (
  chunk_id text PRIMARY KEY CHECK (chunk_id ~ '^sha256:[a-f0-9]{64}$'),
  extraction_id text NOT NULL,
  source_version_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 65535),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 16384),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_start bigint NOT NULL CHECK (byte_start >= 0),
  byte_end bigint NOT NULL CHECK (byte_end > byte_start),
  line_start integer NOT NULL CHECK (line_start >= 1),
  line_end integer NOT NULL CHECK (line_end >= line_start),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (extraction_id, chunk_index),
  FOREIGN KEY (extraction_id, source_version_id)
    REFERENCES brain.source_extractions(extraction_id, source_version_id)
);

CREATE INDEX source_chunks_tsv_idx ON brain.source_chunks USING gin (tsv);
CREATE INDEX source_chunks_version_idx ON brain.source_chunks (source_version_id, chunk_index);

-- Immutable embedding-spec registry. No ANN index name and no lifecycle state:
-- rows never change, so the plain reject-mutation guard applies without
-- exceptions. Embedding reads in this ticket are exact-only.
CREATE TABLE brain.embedding_indexes (
  embedding_spec_id text PRIMARY KEY CHECK (embedding_spec_id ~ '^sha256:[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (
    provider ~ '^[a-z0-9][a-z0-9._-]*$'
    AND octet_length(provider) BETWEEN 1 AND 128
  ),
  model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 255 AND model !~ '[[:cntrl:]]'),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  spec_version integer NOT NULL CHECK (spec_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimensions, spec_version)
);

CREATE TABLE brain.chunk_embeddings (
  chunk_id text NOT NULL REFERENCES brain.source_chunks(chunk_id),
  embedding_spec_id text NOT NULL REFERENCES brain.embedding_indexes(embedding_spec_id),
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  embedding vector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, embedding_spec_id),
  CONSTRAINT chunk_embeddings_dims_match CHECK (vector_dims(embedding) = dimensions)
);

CREATE OR REPLACE FUNCTION brain.guard_chunk_embedding_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, brain_meta, pg_temp
AS $fn$
DECLARE
  spec_dimensions integer;
  chunk_privacy text;
BEGIN
  SELECT dimensions INTO spec_dimensions
    FROM brain.embedding_indexes
   WHERE embedding_spec_id = NEW.embedding_spec_id;
  IF spec_dimensions IS NULL THEN
    RAISE EXCEPTION 'chunk embedding names an unregistered embedding spec';
  END IF;
  IF spec_dimensions <> NEW.dimensions THEN
    RAISE EXCEPTION 'chunk embedding dimensions disagree with the embedding spec';
  END IF;
  SELECT version_row.privacy_class INTO chunk_privacy
    FROM brain.source_chunks chunk_row
    JOIN brain.source_versions version_row
      ON version_row.source_version_id = chunk_row.source_version_id
   WHERE chunk_row.chunk_id = NEW.chunk_id;
  IF chunk_privacy IS NULL THEN
    RAISE EXCEPTION 'chunk embedding names an unknown source chunk';
  END IF;
  IF chunk_privacy = 'secret' THEN
    RAISE EXCEPTION 'secret-class content is never embedded';
  END IF;
  RETURN NEW;
END;
$fn$;

-- Server-side content integrity: the stored digest is a claim until the database
-- proves it. PostgreSQL 11+ ships sha256(bytea) in pg_catalog, so this needs no
-- extension (pgcrypto is deliberately NOT introduced).
CREATE OR REPLACE FUNCTION brain.guard_source_chunk_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, brain_meta, pg_temp
AS $fn$
BEGIN
  IF encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') <> NEW.content_sha256 THEN
    RAISE EXCEPTION 'source chunk content does not match its content digest';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION brain.guard_active_extractor_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain, brain_meta, pg_temp
AS $fn$
BEGIN
  IF NEW.extractor_name IS DISTINCT FROM OLD.extractor_name THEN
    RAISE EXCEPTION 'active extractor identity is immutable';
  END IF;
  IF NEW.active_version <= OLD.active_version THEN
    RAISE EXCEPTION 'active extractor version may only increase';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.guard_chunk_embedding_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain.guard_source_chunk_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain.guard_active_extractor_update() FROM PUBLIC;

CREATE TRIGGER chunk_embeddings_guard_insert
  BEFORE INSERT ON brain.chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION brain.guard_chunk_embedding_insert();

CREATE TRIGGER source_chunks_guard_insert
  BEFORE INSERT ON brain.source_chunks
  FOR EACH ROW EXECUTE FUNCTION brain.guard_source_chunk_insert();

CREATE TRIGGER active_extractors_guard_update
  BEFORE UPDATE ON brain_meta.active_extractors
  FOR EACH ROW EXECUTE FUNCTION brain.guard_active_extractor_update();

CREATE TRIGGER active_extractors_no_delete
  BEFORE DELETE ON brain_meta.active_extractors
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER active_extractors_no_truncate
  BEFORE TRUNCATE ON brain_meta.active_extractors
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_extractions_immutable
  BEFORE UPDATE OR DELETE ON brain.source_extractions
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_extractions_no_truncate
  BEFORE TRUNCATE ON brain.source_extractions
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_chunks_immutable
  BEFORE UPDATE OR DELETE ON brain.source_chunks
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER source_chunks_no_truncate
  BEFORE TRUNCATE ON brain.source_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER embedding_indexes_immutable
  BEFORE UPDATE OR DELETE ON brain.embedding_indexes
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER embedding_indexes_no_truncate
  BEFORE TRUNCATE ON brain.embedding_indexes
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER chunk_embeddings_immutable
  BEFORE UPDATE OR DELETE ON brain.chunk_embeddings
  FOR EACH ROW EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

CREATE TRIGGER chunk_embeddings_no_truncate
  BEFORE TRUNCATE ON brain.chunk_embeddings
  FOR EACH STATEMENT EXECUTE FUNCTION brain.reject_source_lifecycle_mutation();

-- Runtime-readable projection of the admin-owned registry. Views in brain.*
-- receive runtime SELECT from applyGrants and run with owner privileges, so
-- every role can prove compiled-versus-durable extractor agreement before it
-- consumes or produces active-version content.
CREATE VIEW brain.active_extractors AS
  SELECT extractor_name, active_version FROM brain_meta.active_extractors;

-- Current chunks: the ACTIVE extractor version first, then completeness. A
-- missing or unsupported active-version extraction is an explicit gap, never
-- stale earlier-version exposure.
CREATE VIEW brain.current_source_chunks AS
  SELECT chunk_row.*,
         extraction_row.extractor_name,
         extraction_row.extractor_version,
         version_row.source_id,
         version_row.privacy_class,
         version_row.trust_class,
         version_row.media_type,
         version_row.object_id
    FROM brain.source_chunks chunk_row
    JOIN brain.source_extractions extraction_row
      ON extraction_row.extraction_id = chunk_row.extraction_id
    JOIN brain_meta.active_extractors active_row
      ON active_row.extractor_name = extraction_row.extractor_name
     AND active_row.active_version = extraction_row.extractor_version
    JOIN brain.source_versions version_row
      ON version_row.source_version_id = extraction_row.source_version_id
    JOIN brain.logical_sources source_row
      ON source_row.source_id = version_row.source_id
     AND source_row.current_version_id = version_row.source_version_id
     AND source_row.active_tombstone_id IS NULL
   WHERE extraction_row.status = 'complete';

INSERT INTO brain_meta.runtime_protected_tables (table_name) VALUES
  ('source_extractions'),
  ('source_chunks'),
  ('embedding_indexes'),
  ('chunk_embeddings');

REVOKE ALL PRIVILEGES ON brain.source_extractions FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.source_chunks FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.embedding_indexes FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain.chunk_embeddings FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_meta.active_extractors FROM PUBLIC;
