-- roster_ops schema v2 (#323): the run + artifact ledger. Builds on the #318 v1
-- schema. Adds the run-event trust/provenance model, the artifact-declaration
-- split (a content blob vs a run's declaration of producing/using it), object
-- version-id tracking, and two SANITIZED projection views (run_index /
-- artifact_index) that expose ONLY validated identifiers + internally-produced
-- sanitized text — never raw payload/provenance/digest — so a future
-- semantic-index job (#325) reads safe inputs.
--
-- This runs as ONE transaction via migrate-core, advisory-locked on the
-- roster_ops migration key. It is intentionally NOT guarded by blanket
-- IF NOT EXISTS: the schema_migrations ledger (filename + sha256) makes it run
-- EXACTLY once — a re-run is skipped, an edited file is refused. The
-- deterministic backfill (v1 artifacts -> internal declarations; v1 run_events
-- -> source='unverified') therefore executes once, in the same transaction as
-- the DDL, so a crash rolls the whole upgrade back atomically.
--
-- Core-only crypto: sha256(bytea) (PG >= 11) and (if ever needed)
-- gen_random_uuid() (PG >= 13) — NO pgcrypto extension. Legacy identifiers that
-- fail the strict projection charset are normalized to a deterministic
-- 'legacy-<sha12>' sentinel; the raw value is preserved ONLY in non-projected
-- columns (run_events.run_id, artifact_declarations.provenance), so a planted
-- secret in a v1 runId/contentType can never reach an index input.

-- Serialize the backfill behind a dedicated advisory lock reserved for #323.
-- The migrate-core transaction already holds the roster_ops migration lock;
-- this xact-level lock is belt-and-braces (it auto-releases at COMMIT).
SELECT pg_advisory_xact_lock(8135323);

-- ---- run_events: additive provenance + store-observation columns ----
-- source is a trust LEVEL (Rev3-R2-1), never a claim any caller can mint.
-- DEFAULT 'unverified' IS the fail-closed reading the plan requires: a client
-- that does not stamp source (a v1 row, or the #318 insert path this migration
-- deliberately does not modify) reads as untrusted, NEVER 'host-attested'. The
-- dedicated stage-2 verbs stamp 'cli'; agent-authored report prose is 'agent'.
-- The CHECK REJECTS 'host-attested' outright: NO #323 path legitimately produces
-- it (it is #322's attested channel), so even a raw runtime INSERT of
-- source='host-attested' is refused at the DB — a runtime writer can never forge
-- the trust level the composer promotes external success from. #322 will replace
-- this CHECK when it introduces its attested channel. The DEFAULT also backfills
-- every existing v1 row to 'unverified' in one metadata-only operation.
ALTER TABLE roster_ops.run_events
  ADD COLUMN source           text NOT NULL DEFAULT 'unverified'
    CHECK (source IN ('cli', 'agent', 'unverified')),
  ADD COLUMN agent            text,
  ADD COLUMN skill            text,
  ADD COLUMN trigger          text,
  ADD COLUMN parent_run_id    text,
  ADD COLUMN origin_task_id   text,
  ADD COLUMN correlation_id   text,
  -- store observations: NEVER part of the event id / payload hash
  -- (Rev3-R2-2, Rev4-R3-4). A retry with a new pid/timestamp is idempotent
  -- (same id + same hash). Duration is derived at read (ended_at - started_at).
  ADD COLUMN pid              text,
  ADD COLUMN started_at       bigint,
  ADD COLUMN ended_at         bigint,
  -- internally-produced sanitized projection of a report event's prose,
  -- populated at write time by the TS sanitizer (stage 2). Legacy rows: NULL.
  ADD COLUMN sanitized_report text;

CREATE INDEX IF NOT EXISTS run_events_origin_task_idx
  ON roster_ops.run_events (workspace_id, origin_task_id);
CREATE INDEX IF NOT EXISTS run_events_parent_run_idx
  ON roster_ops.run_events (workspace_id, parent_run_id);
CREATE INDEX IF NOT EXISTS run_events_agent_idx
  ON roster_ops.run_events (workspace_id, agent);

-- ---- artifacts (blob) gains object version tracking ----
-- object_version_id is a STORE-ASSIGNED OBSERVATION: the S3 x-amz-version-id of
-- the immutable bytes. Nullable — legacy objects predate version capture, and a
-- doctor head() fills it later (Rev4-R3 should-fix: filling it is a separate
-- explicit admin-repair verb, never a read side effect). Never part of any
-- payload hash / delivery-ledger dedup key. The v1 digest constraints are
-- untouched.
ALTER TABLE roster_ops.artifacts
  ADD COLUMN object_version_id text;

-- ---- artifact_declarations: a run declares it produced/used an artifact ----
-- Identity (id) = sha256(workspace_id \n run_id \n declaring_agent \n role \n
-- ref) where ref = digest (internal) or provider:external_id (external), per
-- Rev3-R2-5 + Rev4-R3-2 (role IN the id so a produced+used pair of the same
-- reference by the same run/agent does not collide). Content blobs stay in
-- roster_ops.artifacts keyed by digest (dedup identical bytes once); two runs
-- declaring identical bytes yield one blob + two declaration rows.
CREATE TABLE roster_ops.artifact_declarations (
  seq             bigserial PRIMARY KEY,
  id              text    NOT NULL,
  workspace_id    uuid    NOT NULL,
  run_id          text    NOT NULL,
  declaring_agent text    NOT NULL,
  role            text    NOT NULL CHECK (role IN ('produced', 'used')),
  kind            text    NOT NULL CHECK (kind IN ('internal', 'external')),
  digest          text,
  provider        text,
  external_id     text,
  external_url    text,
  artifact_type   text,
  media_type      text,
  provenance      jsonb   NOT NULL,
  -- external references carry verified=false until a correlated host-attested
  -- tool result exists (#322); never caller-supplied, never runtime-mutated.
  verified        boolean NOT NULL DEFAULT false,
  version_state   text,
  sanitized_text  text,
  created_at      bigint  NOT NULL,
  UNIQUE (workspace_id, id),
  CHECK ((kind = 'internal') = (digest IS NOT NULL)),
  CHECK ((kind = 'external') = (external_id IS NOT NULL)),
  CHECK (kind <> 'external' OR provider IS NOT NULL),
  -- An INTERNAL declaration references a workspace blob by digest and carries NO
  -- external columns (finding: the runtime could insert an internal declaration
  -- with provider/external_id/external_url set — an incoherent hybrid row). The
  -- convergence rule for the referenced blob is deferred/soft (the blob may be
  -- queued in the outbox and not yet committed on this DB), so this is a column-
  -- coherence CHECK, not a hard FK.
  CHECK (kind <> 'internal' OR (provider IS NULL AND external_id IS NULL AND external_url IS NULL)),
  -- version_state is a stored enum set at write and mutated only by admin-repair
  -- (finding: the runtime could insert version_state='garbage'). NULL is allowed
  -- for an external declaration (no blob version).
  CHECK (version_state IS NULL OR version_state IN ('verified', 'unverified')),
  -- An external reference is unverified until a correlated host-attested tool
  -- result exists (#322). NO #323 path sets it true, and even a raw runtime
  -- INSERT of an external declaration with verified=true is refused at the DB —
  -- a runtime writer can never forge an "externally verified" artifact. Internal
  -- declarations are digest-verified by the store, so verified=true is legitimate.
  CHECK (kind <> 'external' OR verified = false)
);

CREATE INDEX IF NOT EXISTS artifact_declarations_run_idx
  ON roster_ops.artifact_declarations (workspace_id, run_id, seq);
CREATE INDEX IF NOT EXISTS artifact_declarations_digest_idx
  ON roster_ops.artifact_declarations (workspace_id, digest);

-- ---- projection-safety helpers (admin-owned, pure, SECURITY INVOKER) ----
-- Two defensive layers protect the safe views from leaking a secret that happens
-- to be charset-valid (finding: projections leak valid-character secrets):
--   looks_secret / safe_ident — a run_id / agent whose SHAPE matches a known
--     credential (ghp_/AKIA/xox/sk-/rk-/JWT/long-hex) is normalized to a
--     'legacy-<sha12>' sentinel at BACKFILL time AND re-normalized in the views,
--     even though it passes the charset rule.
--   scrub_index_text — a SQL-level redaction over the DB-owned sanitized_*
--     columns, invoked by a BEFORE INSERT trigger so even a RAW runtime INSERT
--     (the runtime holds column INSERT) cannot land unredacted secret text in a
--     projection column. The TS sanitizer stays the primary write-time producer;
--     this is the second, non-bypassable layer.
-- Core crypto only (sha256 over bytea, PG >= 11) — no pgcrypto.
CREATE FUNCTION roster_ops.looks_secret(txt text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
    SELECT txt IS NOT NULL AND (
      txt ~ 'gh[posur]_[A-Za-z0-9]{20,}'
      OR txt ~ '(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}'
      OR txt ~ 'xox[baprs]-[A-Za-z0-9-]{10,}'
      OR txt ~ '(^|[^A-Za-z0-9])(sk|rk)-[A-Za-z0-9_-]{16,}'
      OR txt ~ 'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}'
      OR txt ~ '[0-9a-fA-F]{32,}'
    )
  $$;

CREATE FUNCTION roster_ops.safe_ident(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN txt IS NULL THEN NULL
      WHEN txt ~ '^[A-Za-z0-9._:-]{1,128}$' AND NOT roster_ops.looks_secret(txt) THEN txt
      ELSE 'legacy-' || left(encode(sha256(convert_to(txt, 'UTF8')), 'hex'), 12)
    END
  $$;

-- Mirrors the TS sanitizer's redaction rule set (sanitize-index.ts) so the
-- second, non-bypassable SQL layer redacts EVERY secret class the TS layer does
-- (finding: the SQL scrub handled only ghp_/AKIA/xox/sk/JWT/hex and leaked
-- KEY=value assignments, Authorization/Bearer headers, URL credentials, and PEM
-- blocks). Order matches the TS RULES: structural blocks (PEM/JWT) first, then
-- headers, prefixed tokens, URL userinfo, contextual assignments, and finally
-- the broad high-entropy shapes — applied innermost-first below. In PostgreSQL
-- ARE, `.` matches newline by default, so the non-greedy PEM/`[^\n\r]` header
-- patterns are line/block accurate. The sensitive-assignment rule matches a
-- QUOTED-or-unquoted key ("password"/password) and a value that allows
-- BACKSLASH-ESCAPED quotes (finding: a JSON `"password":"…"` and an escaped
-- `pass="…\"…\"…"` leaked because the old rule required an unquoted key and a
-- quote-terminated value); it is kept byte-for-byte aligned with the TS VALUE +
-- sensitive-assignment regexes.
CREATE FUNCTION roster_ops.scrub_index_text(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN txt IS NULL THEN NULL ELSE
      -- 12: long hex blob (>=32) — hex-encoded keys/digests/secrets.
      regexp_replace(
      -- 11: export KEY=<long base64/base64url blob> (encoded secrets).
      regexp_replace(
      -- 10: sensitive assignment (key kept, value redacted).
      regexp_replace(
      -- 9: URL userinfo (user:pass@host) — redact the credentials, keep the shape.
      regexp_replace(
      -- 8: AWS access key id.
      regexp_replace(
      -- 7: OpenAI-style secret keys (sk-, sk-proj-, rk-).
      regexp_replace(
      -- 6: Slack tokens.
      regexp_replace(
      -- 5: GitHub personal/OAuth/app/refresh tokens.
      regexp_replace(
      -- 4: Bearer token following the scheme word.
      regexp_replace(
      -- 3: Authorization / Proxy-Authorization header (value redacted, header kept).
      regexp_replace(
      -- 2: JWT (three base64url segments).
      regexp_replace(
      -- 1: PEM / private-key blocks (multiline).
      regexp_replace(
        txt,
        '-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----', '[REDACTED]', 'g'),
        'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}', '[REDACTED]', 'g'),
        '(authorization|proxy-authorization)([[:space:]]*[:=][[:space:]]*)[^\n\r]*', '\1\2[REDACTED]', 'gi'),
        'bearer[[:space:]]+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]', 'gi'),
        'gh[posur]_[A-Za-z0-9]{20,}', '[REDACTED]', 'g'),
        'xox[baprs]-[A-Za-z0-9-]{10,}', '[REDACTED]', 'g'),
        '(sk|rk)-[A-Za-z0-9_-]{16,}', '[REDACTED]', 'g'),
        '(AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}', '[REDACTED]', 'g'),
        '([a-z][a-z0-9+.-]*://)[^/[:space:]:@]+:[^/[:space:]@]+@', '\1[REDACTED]@', 'gi'),
        '("?[A-Za-z0-9_.-]*(password|passwd|passphrase|pass|secret|token|api[_.-]?key|access[_.-]?key|private[_.-]?key|client[_.-]?secret|auth[_.-]?token|credentials?|session[_.-]?token|refresh[_.-]?token)[A-Za-z0-9_.-]*"?[[:space:]]*[:=][[:space:]]*)("([^"\\]|\\.)*"|''([^''\\]|\\.)*''|[^[:space:]\n\r]+)', '\1[REDACTED]', 'gi'),
        '([A-Za-z_][A-Za-z0-9_]*)([[:space:]]*=[[:space:]]*)([A-Za-z0-9+/_-]{32,}={0,2})', '\1\2[REDACTED]', 'g'),
        '[0-9a-fA-F]{32,}', '[REDACTED]', 'g')
    END
  $$;

-- Byte-boundary cap mirroring the TS sanitizer's truncateToBytes (finding: the
-- cap was in UTF-16 code units, so 16384 CJK chars occupied ~49 KiB UTF-8). The
-- budget is 16384 BYTES; the marker ('…[truncated]', 14 bytes) is reserved, and
-- the cut is backed off any trailing UTF-8 continuation byte (10xxxxxx) so a
-- multibyte sequence is never split (convert_from would otherwise error).
CREATE FUNCTION roster_ops.cap_index_bytes(txt text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE
    b bytea;
    n int;
  BEGIN
    IF txt IS NULL OR octet_length(txt) <= 16384 THEN RETURN txt; END IF;
    b := convert_to(txt, 'UTF8');
    n := 16384 - octet_length('…[truncated]');       -- first byte to drop (0-indexed)
    WHILE n > 0 AND (get_byte(b, n) & 192) = 128 LOOP -- continuation byte → back up
      n := n - 1;
    END LOOP;
    RETURN convert_from(substr(b, 1, n), 'UTF8') || '…[truncated]';
  END;
  $$;

-- Defensive BEFORE INSERT scrub of the DB-owned sanitized_* columns. The runtime
-- role holds INSERT (append-only) on these tables but has NO TRIGGER privilege,
-- so it can neither disable nor bypass this — a raw INSERT of an unredacted
-- secret into sanitized_report / sanitized_text is scrubbed AND byte-capped
-- before it lands.
CREATE FUNCTION roster_ops.scrub_run_event_sanitized() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    NEW.sanitized_report := roster_ops.cap_index_bytes(roster_ops.scrub_index_text(NEW.sanitized_report));
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER run_events_scrub_sanitized
  BEFORE INSERT ON roster_ops.run_events
  FOR EACH ROW EXECUTE FUNCTION roster_ops.scrub_run_event_sanitized();

CREATE FUNCTION roster_ops.scrub_declaration_sanitized() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    NEW.sanitized_text := roster_ops.cap_index_bytes(roster_ops.scrub_index_text(NEW.sanitized_text));
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER artifact_declarations_scrub_sanitized
  BEFORE INSERT ON roster_ops.artifact_declarations
  FOR EACH ROW EXECUTE FUNCTION roster_ops.scrub_declaration_sanitized();

-- ---- deterministic backfill: one internal declaration per v1 artifact blob ----
-- declaring_agent='legacy', role='produced', kind='internal',
-- version_state='unverified'. run_id and media_type are NORMALIZED here (unsafe
-- legacy meta.runId / meta.contentType -> sentinel / NULL) so the base columns
-- are already index-safe; the full raw legacy meta is preserved verbatim in
-- provenance (a non-projected column). ON CONFLICT DO NOTHING keeps the backfill
-- idempotent under the (workspace_id, id) key even though migrate-core already
-- guarantees a single execution.
INSERT INTO roster_ops.artifact_declarations
  (id, workspace_id, run_id, declaring_agent, role, kind,
   digest, artifact_type, media_type, provenance, verified, version_state, created_at)
SELECT
  encode(sha256(convert_to(
    a.workspace_id::text || E'\n' || norm.run_id || E'\n' || 'legacy' || E'\n' || 'produced' || E'\n' || a.digest,
    'UTF8')), 'hex'),
  a.workspace_id,
  norm.run_id,
  'legacy',
  'produced',
  'internal',
  a.digest,
  NULL,
  norm.media_type,
  jsonb_build_object('origin', 'legacy-backfill', 'legacy_meta', a.meta),
  false,
  'unverified',
  a.created_at
FROM roster_ops.artifacts a
CROSS JOIN LATERAL (
  SELECT
    -- safe_ident sentinels BOTH a charset-invalid AND a secret-SHAPED legacy
    -- runId (Rev4-R3-1) so the base run_id column is already index-safe; the raw
    -- legacy meta is preserved verbatim only in provenance (a non-projected column).
    roster_ops.safe_ident(coalesce(a.meta->>'runId', 'unknown')) AS run_id,
    CASE
      WHEN coalesce(a.meta->>'contentType', '') ~ '^[A-Za-z0-9._+/:-]{1,128}$'
        AND NOT roster_ops.looks_secret(a.meta->>'contentType')
        THEN a.meta->>'contentType'
      ELSE NULL
    END AS media_type
) norm
ON CONFLICT (workspace_id, id) DO NOTHING;

-- ---- run_index: sanitized per-run projection (safe index input) ----
-- One row per run. Exposes ONLY validated run_id + agent, a host-lifecycle-
-- derived status (promoted only from trusted sources: 'cli' | 'host-attested'),
-- the internally-produced sanitized_report, and created_at. No raw payload,
-- type, dedupe key, or provenance. run_id / agent are re-normalized defensively
-- here so a legacy row whose raw run_id carries a secret projects the sentinel,
-- never the secret.
CREATE VIEW roster_ops.run_index AS
SELECT
  e.workspace_id,
  -- safe_ident sentinels a charset-invalid OR secret-SHAPED run_id (defensive
  -- second layer over the write-time validation) so a raw-inserted or legacy
  -- secret can never surface verbatim.
  roster_ops.safe_ident(e.run_id) AS run_id,
  max(roster_ops.safe_ident(e.agent)) AS agent,
  CASE
    WHEN bool_or(e.type = 'error'     AND e.source IN ('cli', 'host-attested')) THEN 'errored'
    WHEN bool_or(e.type = 'run-end'   AND e.source IN ('cli', 'host-attested')) THEN 'completed'
    WHEN bool_or(e.type = 'run-start' AND e.source IN ('cli', 'host-attested')) THEN 'running'
    ELSE 'unknown'
  END AS status,
  max(e.sanitized_report) FILTER (WHERE e.type = 'report') AS sanitized_report,
  min(e.created_at) AS created_at
FROM roster_ops.run_events e
GROUP BY e.workspace_id, e.run_id;

-- ---- artifact_index: sanitized artifact projection (safe index input) ----
-- Exposes ONLY validated run_id, artifact_type, media_type, a sanitized
-- external_url HOST (scheme/userinfo/path/query/port stripped), and the
-- internally-produced sanitized_text (Rev4-R3-3). No raw provenance, digest,
-- external_id, or full URL.
CREATE VIEW roster_ops.artifact_index AS
SELECT
  d.workspace_id,
  roster_ops.safe_ident(d.run_id) AS run_id,
  CASE WHEN d.artifact_type ~ '^[A-Za-z0-9._+/:-]{1,128}$' AND NOT roster_ops.looks_secret(d.artifact_type) THEN d.artifact_type ELSE NULL END AS artifact_type,
  CASE WHEN d.media_type    ~ '^[A-Za-z0-9._+/:-]{1,128}$' AND NOT roster_ops.looks_secret(d.media_type)    THEN d.media_type    ELSE NULL END AS media_type,
  CASE WHEN d.host ~ '^[A-Za-z0-9.:_-]{1,253}$' AND NOT roster_ops.looks_secret(d.host) THEN d.host ELSE NULL END AS external_url_host,
  d.sanitized_text,
  d.created_at
FROM (
  SELECT
    ad.*,
    regexp_replace(
      regexp_replace(coalesce(substring(ad.external_url from '://([^/?#]*)'), ''), '^[^@]*@', ''),
      ':[0-9]+$', ''
    ) AS host
  FROM roster_ops.artifact_declarations ad
) d;

-- ---- component + capability bump (admin-authored, runtime-read-only) ----
UPDATE roster_ops.meta SET
  component_version         = 2,
  capabilities              = '["runs","artifacts","outbox","checkpoint","run-ledger"]'::jsonb,
  objects_component_version = 2,
  objects_capabilities      = '["content-addressed","create-only","version-id","list-prefix"]'::jsonb
WHERE singleton;
