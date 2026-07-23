-- hitl schema v1 (#318 section E): HITL requests + decisions, append-only.
-- State changes are new rows (status projection = latest row per id); #319
-- formalizes the transition table. The meta table carries the component
-- version, the workspace binding row, and the canonical object-store tuple —
-- admin-authored, runtime-read-only (grants enforce).

CREATE SCHEMA IF NOT EXISTS hitl;

CREATE TABLE IF NOT EXISTS hitl.schema_migrations (
  filename   text PRIMARY KEY,
  sha256     text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hitl.meta (
  singleton         boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  component_version integer NOT NULL,
  capabilities      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  workspace_id      uuid,
  workspace_name    text,
  state             text CHECK (state IN ('pending', 'finalized')),
  bound_at          timestamptz,
  bucket            text,
  region            text,
  endpoint          text,
  force_path_style  boolean,
  marker_sha256     text,
  marker_etag       text,
  CHECK ((workspace_id IS NULL) = (state IS NULL))
);

INSERT INTO hitl.meta (singleton, component_version, capabilities)
VALUES (true, 1, '["requests","decisions"]'::jsonb)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS hitl.requests (
  seq          bigserial PRIMARY KEY,
  id           text    NOT NULL,
  workspace_id uuid    NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  action       text    NOT NULL,
  target       text    NOT NULL,
  content_hash text    NOT NULL,
  payload      jsonb   NOT NULL,
  status       text    NOT NULL,
  producer_id  uuid,
  producer_seq bigint,
  created_at   bigint  NOT NULL,
  UNIQUE (workspace_id, id, version)
);

CREATE TABLE IF NOT EXISTS hitl.decisions (
  seq             bigserial PRIMARY KEY,
  id              text    NOT NULL,
  workspace_id    uuid    NOT NULL,
  request_id      text    NOT NULL,
  request_version integer NOT NULL DEFAULT 1,
  status          text    NOT NULL,
  payload         jsonb   NOT NULL,
  producer_id     uuid,
  producer_seq    bigint,
  created_at      bigint  NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS requests_ws_id_idx
  ON hitl.requests (workspace_id, id, version);
CREATE INDEX IF NOT EXISTS decisions_request_idx
  ON hitl.decisions (workspace_id, request_id, request_version);
