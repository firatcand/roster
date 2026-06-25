CREATE SCHEMA IF NOT EXISTS brain;
CREATE SCHEMA IF NOT EXISTS brain_meta;

CREATE TABLE IF NOT EXISTS brain_meta.schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain_meta.runtime_roles (
  rolname text PRIMARY KEY,
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brain.entities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  slug text NOT NULL,
  title text,
  body jsonb,
  UNIQUE (kind, slug)
);

CREATE TABLE IF NOT EXISTS brain.facts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  entity_id bigint NOT NULL,
  key text NOT NULL,
  value jsonb
);

CREATE TABLE IF NOT EXISTS brain.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  entity_id bigint,
  kind text NOT NULL,
  payload jsonb
);

CREATE TABLE IF NOT EXISTS brain.edges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  src_id bigint NOT NULL,
  dst_id bigint NOT NULL,
  rel text NOT NULL,
  props jsonb
);

CREATE TABLE IF NOT EXISTS brain.documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  uri text NOT NULL,
  chunk_ix int NOT NULL DEFAULT 0,
  body text,
  meta jsonb
);

CREATE OR REPLACE VIEW brain.current_facts AS
  SELECT DISTINCT ON (entity_id, key) id, recorded_at, entity_id, key, value
  FROM brain.facts
  ORDER BY entity_id, key, id DESC;

CREATE OR REPLACE VIEW brain.current_edges AS
  SELECT DISTINCT ON (src_id, dst_id, rel) id, recorded_at, src_id, dst_id, rel, props
  FROM brain.edges
  ORDER BY src_id, dst_id, rel, id DESC;
