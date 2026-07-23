-- roster_ops schema v1 (#318 section E): run events, artifact index, and the
-- server-side delivery ledger that dedups outbox replay by
-- (workspace_id, namespace, record_id) with payload-hash equality.
-- Append-only posture: runtime gets INSERT on the event/append tables only —
-- never UPDATE/DELETE/TRUNCATE, never meta. The meta table additionally owns
-- the objects component (version + negotiated capabilities), since the object
-- store has no metadata home of its own.

CREATE SCHEMA IF NOT EXISTS roster_ops;

CREATE TABLE IF NOT EXISTS roster_ops.schema_migrations (
  filename   text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roster_ops.meta (
  singleton                 boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  component_version         integer NOT NULL,
  capabilities              jsonb   NOT NULL DEFAULT '[]'::jsonb,
  objects_component_version integer NOT NULL,
  objects_capabilities      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  workspace_id              uuid,
  workspace_name            text,
  state                     text CHECK (state IN ('pending', 'finalized')),
  bound_at                  timestamptz,
  bucket                    text,
  region                    text,
  endpoint                  text,
  force_path_style          boolean,
  marker_sha256             text,
  marker_etag               text,
  CHECK ((workspace_id IS NULL) = (state IS NULL))
);

INSERT INTO roster_ops.meta
  (singleton, component_version, capabilities, objects_component_version, objects_capabilities)
VALUES
  (true, 1, '["runs","artifacts","outbox","checkpoint"]'::jsonb,
   1, '["content-addressed","create-only"]'::jsonb)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS roster_ops.run_events (
  seq          bigserial PRIMARY KEY,
  id           text   NOT NULL,
  workspace_id uuid   NOT NULL,
  run_id       text   NOT NULL,
  dedupe_key   text   NOT NULL,
  type         text   NOT NULL,
  payload      jsonb  NOT NULL,
  producer_id  uuid,
  producer_seq bigint,
  created_at   bigint NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS run_events_run_idx
  ON roster_ops.run_events (workspace_id, run_id, seq);

CREATE TABLE IF NOT EXISTS roster_ops.artifacts (
  seq          bigserial PRIMARY KEY,
  id           text   NOT NULL,
  workspace_id uuid   NOT NULL,
  digest       text   NOT NULL,
  size         bigint NOT NULL,
  meta         jsonb  NOT NULL,
  producer_id  uuid,
  producer_seq bigint,
  created_at   bigint NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, digest)
);

CREATE TABLE IF NOT EXISTS roster_ops.delivery_ledger (
  workspace_id uuid NOT NULL,
  namespace    text NOT NULL,
  record_id    text NOT NULL,
  payload_hash text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, namespace, record_id)
);
