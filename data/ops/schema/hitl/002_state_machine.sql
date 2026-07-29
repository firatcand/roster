-- hitl schema v2 (#319): the durable HITL state machine. Builds on the #318 v1
-- schema (001_init.sql: requests.id / requests.version / decisions.request_version
-- / UNIQUE (workspace_id, id, version)).
--
-- What v2 adds:
--   * the approval PACKET — every field a human sees when deciding, bound by a
--     byte-exact packet_hash so editing anything invalidates the old approval;
--   * SEALED GENERATIONS — a group is open only until a terminal decision; a
--     later same-key submission opens generation G+1 (an independent approval);
--   * DB-ENFORCED integrity — a BEFORE INSERT trigger on decisions serializes on
--     the per-group advisory lock and refuses a reopened terminal, a non-head
--     version, a superseded version, and a wrong-direction expiry, so even a RAW
--     runtime INSERT cannot corrupt the machine;
--   * two projections — hitl.request_state (authoritative, sweep-independent)
--     and hitl.request_index (sanitized + validated ids only).
--
-- This runs as ONE transaction via migrate-core under the hitl migration
-- advisory lock (8135318). Deliberately NOT guarded by blanket IF NOT EXISTS:
-- the schema_migrations ledger (filename + sha256) makes it run EXACTLY once —
-- a re-run is skipped, an edited file is refused — so the destructive parts
-- (the id re-key, the generation partition, dropping the v1 unique) execute
-- once and roll back atomically on any failure.
--
-- Core-only crypto: sha256(bytea) (PG >= 11). No pgcrypto.
--
-- ORDERING (D2), top to bottom:
--   1. helper functions (pure, IMMUTABLE, SECURITY INVOKER)
--   2. PREFLIGHT — refuse a legacy tree that cannot be partitioned unambiguously
--   3. additive nullable columns (+ the generated `terminal` column)
--   4. backfill part 1: compute the identity/generation MAP into a temp table
--      (reads only — mutates nothing)
--   5. DROP the v1 UNIQUE (workspace_id, id, version)
--   6. backfill part 2: apply the map (decisions first, then the re-keyed
--      requests)
--   7. new constraints / unique / FK / indexes / triggers / views
--   8. SET NOT NULL
--   9. meta component_version -> 2, capabilities += state-machine
--
-- Deviation from D2's literal "backfill → drop old constraint" order, forced by
-- the re-key: the moment generation 2 version 1 exists alongside generation 1
-- version 1 under the SAME derived id, the v1 UNIQUE (workspace_id, id,
-- version) is violated MID-UPDATE. The map is still computed before the drop —
-- nothing observes a table without a uniqueness guarantee, because the whole
-- migration is one transaction.

-- =============================================================================
-- 1. helper functions
-- =============================================================================

-- Length-prefixed field framing, byte-identical to frameFields() in
-- src/lib/persistence/hitl-machine.ts:
--   frame([a,b,…]) = "<utf8 byte length>:<field>" concatenated in order.
-- A NULL field is a PROGRAMMING ERROR, not an empty string: string_agg would
-- silently drop it and two different packets could collide, so we fail loud and
-- force callers through hitl.presence() for optional fields.
CREATE FUNCTION hitl.frame(parts text[]) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE
    out text := '';
    p   text;
  BEGIN
    FOREACH p IN ARRAY parts LOOP
      IF p IS NULL THEN
        RAISE EXCEPTION 'hitl.frame: NULL field — optional fields must use hitl.presence()';
      END IF;
      out := out || octet_length(convert_to(p, 'UTF8'))::text || ':' || p;
    END LOOP;
    RETURN out;
  END;
  $$;

-- The presence pair for an optional field: absent => ['0',''], present =>
-- ['1',value]. Mirrors presence()/presenceJson() in hitl-machine.ts. Encoding
-- absence structurally (rather than as a JSON null) means neither side ever has
-- to reproduce the other's string-escaping rules.
CREATE FUNCTION hitl.presence(v text) RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN v IS NULL THEN ARRAY['0', ''] ELSE ARRAY['1', v] END
  $$;

CREATE FUNCTION hitl.digest_framed(parts text[]) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(sha256(convert_to(hitl.frame(parts), 'UTF8')), 'hex')
  $$;

-- ASCII whitespace ONLY (space, tab, LF, VT, FF, CR) — the exact set
-- normalizeTarget() strips in hitl-machine.ts. NOT btrim's default (space only)
-- and NOT a Unicode trim/normalization (normalize() needs PG >= 13 and JS's
-- trim() covers a wider set), because both sides must agree byte for byte.
CREATE FUNCTION hitl.normalize_target(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT btrim(t, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13))
  $$;

-- The closed editorial allowlist (owner decision 2). MUST stay byte-identical
-- to EDITORIAL_ACTIONS in hitl-machine.ts — test/hitl-migration.test.ts pins
-- the two against each other. Anything else, including an unknown action, is
-- 'execution': fail-safe, so a novel action name can never grant itself the
-- weaker expiry-optional editorial regime.
CREATE FUNCTION hitl.classify_action(action text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN action IN ('approve-draft', 'approve-lesson', 'select-candidate', 'acknowledge-error')
        THEN 'editorial'
      ELSE 'execution'
    END
  $$;

CREATE FUNCTION hitl.request_key(function_name text, action text, target text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT hitl.digest_framed(ARRAY[
      'hitl.request_key.v1', function_name, action, hitl.normalize_target(target)
    ])
  $$;

CREATE FUNCTION hitl.target_hash(target text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT hitl.digest_framed(ARRAY['hitl.target_hash.v1', hitl.normalize_target(target)])
  $$;

-- functionName is the one request_key input with no column of its own: it rides
-- in whichever content channel is live (`payload` for an inline body,
-- `payload_ref.meta` for an offloaded one). The resolution rule is byte-identical
-- to the TS side (hitl-store.ts / hitl-local-migrate.ts): anything that is not a
-- NON-EMPTY STRING — absent, null, empty, or a number/object — is the same
-- 'unknown' sentinel, so the two never derive different keys for one row.
CREATE FUNCTION hitl.function_name(p_payload jsonb, p_payload_ref jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(
      nullif(CASE WHEN jsonb_typeof(p_payload->'functionName') = 'string'
                  THEN p_payload->>'functionName' END, ''),
      nullif(CASE WHEN jsonb_typeof(p_payload_ref->'meta'->'functionName') = 'string'
                  THEN p_payload_ref->'meta'->>'functionName' END, ''),
      'unknown')
  $$;

-- request_id = sha256(workspace_id, request_key): the stable logical id the
-- WHOLE group (every generation, every version) lives under.
CREATE FUNCTION hitl.request_id(workspace_id uuid, request_key text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT hitl.digest_framed(ARRAY['hitl.request_id.v1', workspace_id::text, request_key])
  $$;

-- The packet digest. Field order and encoding mirror packetHashOf() exactly.
-- The three jsonb-shaped inputs arrive as ALREADY-CANONICAL text (the caller
-- passes canonicalJson(...)), because JS canonical JSON sorts object keys
-- lexicographically while jsonb sorts by (length, bytes) — reproducing JS
-- canonicalization inside SQL is not worth the fragility. Legacy/v1-shaped rows
-- pass NULL for the optional fields, so the migration and the fill trigger only
-- ever exercise the absent encoding.
--
-- `p_title` and the origin/agent trio are APPROVAL-VISIBLE (they are rendered
-- beside the ask), so they are packet identity: re-submitting the same body
-- under a different title or requesting agent is a different approval question,
-- not an idempotent replay. `p_title` is a plain framed field — never NULL; a
-- legacy row with no title normalizes to '' on both sides.
CREATE FUNCTION hitl.packet_hash_v1(
  p_action       text,
  p_action_kind  text,
  p_target       text,
  p_content_kind text,
  p_content_digest text,
  p_expires_at   bigint,
  p_canon_version int,
  p_title        text,
  p_summary      text,
  p_warnings_canonical text,
  p_side_effects_canonical text,
  p_choices_canonical text,
  p_origin_run_id text,
  p_origin_task_id text,
  p_requesting_agent text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT hitl.digest_framed(
    ARRAY[
      'hitl.packet_hash.v1',
      p_action,
      p_action_kind,
      hitl.normalize_target(p_target),
      hitl.target_hash(p_target),
      p_content_kind,
      p_content_digest
    ]
    || hitl.presence(CASE WHEN p_expires_at IS NULL THEN NULL ELSE p_expires_at::text END)
    || ARRAY[p_canon_version::text, coalesce(p_title, '')]
    || hitl.presence(p_summary)
    || hitl.presence(p_warnings_canonical)
    || hitl.presence(p_side_effects_canonical)
    || hitl.presence(p_choices_canonical)
    || hitl.presence(p_origin_run_id)
    || hitl.presence(p_origin_task_id)
    || hitl.presence(p_requesting_agent)
  )
$$;

-- Wall clock in epoch ms. VOLATILE on purpose (clock_timestamp, not now()): the
-- effective-status projection and the trigger's expiry-direction check must see
-- the REAL time at evaluation, not the statement/transaction start.
CREATE FUNCTION hitl.now_ms() RETURNS bigint
  LANGUAGE sql VOLATILE AS $$
    SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  $$;

-- ---- projection safety (independent copies of the #323 helpers) ----
-- Deliberately NOT roster_ops.looks_secret/safe_ident: the hitl schema migrates
-- FIRST and independently (its own ledger, its own advisory lock, its own
-- component version), so a cross-schema call would make hitl's DDL depend on a
-- roster_ops migration that has not run yet on a fresh database. Kept in sync
-- with sanitize-index.ts / 002_run_ledger.sql.
CREATE FUNCTION hitl.looks_secret(txt text) RETURNS boolean
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

-- A projected identifier: safe charset and not secret-SHAPED, else a
-- deterministic sentinel. Never the raw value.
CREATE FUNCTION hitl.safe_token(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
      WHEN txt IS NULL THEN NULL
      WHEN txt ~ '^[A-Za-z0-9._:-]{1,128}$' AND NOT hitl.looks_secret(txt) THEN txt
      ELSE 'legacy-' || left(encode(sha256(convert_to(txt, 'UTF8')), 'hex'), 12)
    END
  $$;

-- A projected DIGEST id (request_id / request_key / target_hash / packet_hash).
-- These are internally-derived sha256 hex by construction; anything that is not
-- exactly that shape is NOT projected at all (NULL), so a raw-inserted value
-- can never surface through the index view. looks_secret deliberately does not
-- apply — a 64-hex digest is what this column IS.
CREATE FUNCTION hitl.safe_digest(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN txt ~ '^[0-9a-f]{64}$' THEN txt ELSE NULL END
  $$;

-- SQL mirror of sanitize-index.ts's redaction rules, applied by a BEFORE INSERT
-- trigger to the DB-owned sanitized_summary column: the runtime holds INSERT on
-- hitl.requests but no TRIGGER privilege, so a raw INSERT of unredacted secret
-- text into a projection column is scrubbed before it lands. The TS sanitizer
-- stays the primary write-time producer; this is the non-bypassable layer.
CREATE FUNCTION hitl.scrub_index_text(txt text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN txt IS NULL THEN NULL ELSE
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
      regexp_replace(
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

CREATE FUNCTION hitl.cap_index_bytes(txt text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
  DECLARE
    b bytea;
    n int;
  BEGIN
    IF txt IS NULL OR octet_length(txt) <= 16384 THEN RETURN txt; END IF;
    b := convert_to(txt, 'UTF8');
    n := 16384 - octet_length('…[truncated]');
    WHILE n > 0 AND (get_byte(b, n) & 192) = 128 LOOP
      n := n - 1;
    END LOOP;
    RETURN convert_from(substr(b, 1, n), 'UTF8') || '…[truncated]';
  END;
  $$;

-- =============================================================================
-- 2. PREFLIGHT — refuse an ambiguous legacy tree with a per-key report
-- =============================================================================
-- The generation partition reads legacy history as a story: same-key rows in
-- (created_at, seq) order, cut into a new generation at every terminal-decision
-- boundary. Some legacy shapes make that story unreadable, and GUESSING would
-- silently mint a wrong approval scope. Those shapes refuse the upgrade here,
-- BEFORE any DDL, naming the exact rows an operator must fix.
DO $preflight$
DECLARE
  problems text[] := ARRAY[]::text[];
  rec      record;
  total    int;
BEGIN
  FOR rec IN
    WITH keyed AS (
      -- v1's identity is (workspace_id, id, VERSION) — one legacy id can carry
      -- several versions, and hitl.decisions names the exact one through
      -- request_version. EVERY join below is therefore keyed by the full triple:
      -- matching on id alone would let a decision attach to an arbitrary version
      -- (and a decision naming a version that does not exist would slip past the
      -- orphan check entirely).
      SELECT
        r.seq, r.workspace_id, r.id, r.version, r.created_at,
        hitl.request_key(hitl.function_name(r.payload, NULL), r.action, r.target) AS request_key
      FROM hitl.requests r
    ),
    dec AS (
      SELECT d.workspace_id, d.request_id, d.request_version, d.id, d.status, d.created_at,
             (d.status <> 'deferred') AS is_terminal
        FROM hitl.decisions d
    ),
    -- (a) a decision with no request VERSION row: nothing to attach a
    -- generation to.
    orphan AS (
      SELECT 'decision ' || d.id AS scope,
             'references request ' || d.request_id || ' version ' || d.request_version::text
               || ' which does not exist' AS detail
        FROM dec d
       WHERE NOT EXISTS (
         SELECT 1 FROM keyed k
          WHERE k.workspace_id = d.workspace_id AND k.id = d.request_id AND k.version = d.request_version
       )
    ),
    -- (b) an unknown decision status: the closed v2 CHECK would reject it, and
    -- terminality itself would be a guess.
    bad_status AS (
      SELECT 'decision ' || d.id AS scope,
             'status ''' || d.status || ''' is not a decision status' AS detail
        FROM dec d
       WHERE d.status NOT IN ('approved', 'changes-requested', 'rejected', 'deferred', 'expired', 'cancelled')
    ),
    -- (c) two terminal decisions on one legacy request VERSION: no
    -- deterministic winner.
    dup_terminal AS (
      SELECT 'request ' || d.request_id || ' version ' || d.request_version::text AS scope,
             'carries ' || count(*)::text || ' terminal decisions (' || string_agg(d.status, ', ' ORDER BY d.status) || ')' AS detail
        FROM dec d
       WHERE d.is_terminal
       GROUP BY d.workspace_id, d.request_id, d.request_version
      HAVING count(*) > 1
    ),
    -- (d) two decisions of the SAME status on one request version: the v2
    -- duplicate guard (one terminal, one deferred per version) cannot hold.
    dup_status AS (
      SELECT 'request ' || d.request_id || ' version ' || d.request_version::text AS scope,
             'carries ' || count(*)::text || ' ''' || d.status || ''' decisions' AS detail
        FROM dec d
       GROUP BY d.workspace_id, d.request_id, d.request_version, d.status
      HAVING count(*) > 1
    ),
    -- (e) a decision stamped BEFORE the request version it decides: chronology
    -- is unusable, so the terminal boundary cannot be placed.
    backdated AS (
      SELECT 'decision ' || d.id AS scope,
             'is stamped ' || d.created_at::text || ', before its request ' || d.request_id || ' at ' || k.created_at::text AS detail
        FROM dec d
        JOIN keyed k
          ON k.workspace_id = d.workspace_id AND k.id = d.request_id AND k.version = d.request_version
       WHERE d.created_at < k.created_at
    ),
    -- (f) the real ambiguity: a same-key row was created BEFORE the previous
    -- row's terminal decision landed, so we cannot tell whether it was a
    -- revision inside the open generation or a fresh post-terminal generation.
    overlap AS (
      SELECT 'request_key ' || left(cur.request_key, 12) AS scope,
             'request ' || cur.id || ' version ' || cur.version::text || ' was terminally decided at ' || cur.terminal_at::text
               || ' but the next same-key request ' || cur.next_id || ' version ' || cur.next_version::text
               || ' already existed at ' || cur.next_created::text
               || ' — the generation boundary is ambiguous' AS detail
        FROM (
          SELECT k.*,
                 (SELECT min(d.created_at) FROM dec d
                   WHERE d.workspace_id = k.workspace_id AND d.request_id = k.id
                     AND d.request_version = k.version AND d.is_terminal) AS terminal_at,
                 lead(k.id)         OVER (PARTITION BY k.workspace_id, k.request_key ORDER BY k.created_at, k.seq) AS next_id,
                 lead(k.version)    OVER (PARTITION BY k.workspace_id, k.request_key ORDER BY k.created_at, k.seq) AS next_version,
                 lead(k.created_at) OVER (PARTITION BY k.workspace_id, k.request_key ORDER BY k.created_at, k.seq) AS next_created
            FROM keyed k
        ) cur
       WHERE cur.terminal_at IS NOT NULL
         AND cur.next_id IS NOT NULL
         AND cur.terminal_at >= cur.next_created
    ),
    all_problems AS (
      SELECT * FROM orphan
      UNION ALL SELECT * FROM bad_status
      UNION ALL SELECT * FROM dup_terminal
      UNION ALL SELECT * FROM dup_status
      UNION ALL SELECT * FROM backdated
      UNION ALL SELECT * FROM overlap
    )
    SELECT scope, detail FROM all_problems ORDER BY scope, detail
  LOOP
    problems := problems || (rec.scope || ': ' || rec.detail);
  END LOOP;

  total := coalesce(array_length(problems, 1), 0);
  IF total > 0 THEN
    RAISE EXCEPTION E'hitl 002 preflight refused the v1->v2 upgrade: % legacy condition(s) make generation partitioning ambiguous.\n  - %\nResolve or purge the rows above, then re-run ''roster ops setup''.',
      total,
      array_to_string((SELECT array_agg(p) FROM unnest(problems[1:20]) AS p), E'\n  - ')
      USING ERRCODE = 'raise_exception';
  END IF;
END
$preflight$;

-- =============================================================================
-- 3. additive columns (all nullable except the defaulted / generated ones)
-- =============================================================================

ALTER TABLE hitl.requests
  -- identity + grouping
  ADD COLUMN request_key              text,
  ADD COLUMN generation               integer NOT NULL DEFAULT 1,
  -- the pre-v2 value of `id`, kept for auditability: the backfill re-keys
  -- legacy rows onto the derived request_id (see section 4).
  ADD COLUMN legacy_id                text,
  -- approval packet
  ADD COLUMN target_hash              text,
  ADD COLUMN packet_hash              text,
  ADD COLUMN canonicalization_version integer,
  ADD COLUMN action_kind              text,
  ADD COLUMN expires_at               bigint,
  ADD COLUMN payload_ref              jsonb,
  ADD COLUMN summary                  text,
  ADD COLUMN warnings                 jsonb,
  ADD COLUMN side_effects             jsonb,
  ADD COLUMN choices                  jsonb,
  -- provenance
  ADD COLUMN origin_run_id            text,
  ADD COLUMN origin_task_id           text,
  ADD COLUMN requesting_agent         text,
  -- D3: durable cross-group supersession (`replaces`). NULL unless this row
  -- supersedes another group's head; the anti-join below makes that head
  -- non-authoritative without ever UPDATE-ing it.
  ADD COLUMN supersedes_request_id    text,
  ADD COLUMN supersedes_generation    integer,
  ADD COLUMN supersedes_version       integer,
  -- D-should-b: the DB-owned sanitized projection column. Written at INSERT by
  -- the store's sanitizeForIndex output and re-scrubbed by the fill trigger;
  -- hitl.request_index selects THIS, never the raw summary/target.
  ADD COLUMN sanitized_summary        text;

-- Large payloads live in the object store; exactly one of payload/payload_ref.
ALTER TABLE hitl.requests ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE hitl.decisions
  ADD COLUMN decided_at bigint,
  ADD COLUMN feedback   text,
  ADD COLUMN generation integer NOT NULL DEFAULT 1,
  -- deferred is the ONLY non-terminal decision (it stays in the actionable
  -- queue). Generated + stored so the partial unique index below can enforce
  -- "at most one terminal decision per version" without trusting the writer.
  ADD COLUMN terminal   boolean GENERATED ALWAYS AS (status <> 'deferred') STORED;

-- =============================================================================
-- 4. backfill
-- =============================================================================
-- Two things happen here that deserve to be called out:
--
--   RE-KEY. v1 computed requests.id = sha256(workspace, {functionName, action,
--   target, contentHash}) — the CONTENT is in the id, so two revisions of one
--   proposal landed under DIFFERENT ids. v2's model is "a group's whole history
--   lives under one request_id = sha256(workspace, request_key)". Leaving the
--   legacy ids alone would strand every legacy revision in its own single-row
--   group and make the terminal-boundary partition a no-op, so the backfill
--   re-derives id from request_key and remaps decisions.request_id to match.
--   The old value is preserved in requests.legacy_id (nothing is lost) and the
--   PG HITL surface has no CLI consumer yet (#320), so no external reference
--   breaks. `version` is rewritten by the same partition.
--
--   GENERATION PARTITION. Same-key rows ordered by (created_at, seq); the
--   generation counter increments after every row that carries a terminal
--   decision, and versions run 1..N inside each generation. The preflight above
--   already refused every input shape where that reading is ambiguous.

CREATE TEMP TABLE hitl_v2_backfill ON COMMIT DROP AS
WITH keyed AS (
  SELECT
    r.seq,
    r.workspace_id,
    r.id AS legacy_id,
    -- The legacy VERSION is part of the map's key: decisions name
    -- (request_id, request_version), so the remap below must join on both.
    r.version AS legacy_version,
    r.action,
    r.target,
    r.content_hash,
    r.created_at,
    coalesce(r.payload->>'title', '') AS title,
    hitl.request_key(hitl.function_name(r.payload, NULL), r.action, r.target) AS request_key,
    hitl.classify_action(r.action) AS action_kind,
    -- Legacy rows whose stored content_hash does not equal sha256(body) were
    -- never write-verified, so they are hash-EXEMPT (canonicalization_version
    -- 0). The exemption is about not REFUSING the migration; D8 makes those
    -- rows categorically non-authoritative, so exempting them grants nothing.
    -- The body must be a JSON STRING — the same rule the fill trigger and the
    -- TS conversion apply, so one legacy row can never convert as verified on
    -- one backend and exempt on the other. An EMPTY string that hashes to
    -- sha256('') is verified: verifiable is verifiable.
    CASE
      WHEN jsonb_typeof(r.payload->'body') = 'string'
       AND r.content_hash = encode(sha256(convert_to(r.payload->>'body', 'UTF8')), 'hex')
      THEN 1 ELSE 0
    END AS canonicalization_version,
    CASE
      WHEN r.payload->>'expiresAt' ~ '^-?[0-9]+$' THEN (r.payload->>'expiresAt')::bigint
      ELSE NULL
    END AS legacy_expires_at
  FROM hitl.requests r
),
sealed AS (
  SELECT
    k.*,
    EXISTS (
      SELECT 1 FROM hitl.decisions d
       WHERE d.workspace_id = k.workspace_id AND d.request_id = k.legacy_id
         AND d.request_version = k.legacy_version AND d.terminal
    ) AS has_terminal
  FROM keyed k
),
partitioned AS (
  SELECT
    s.*,
    coalesce(
      sum(CASE WHEN s.has_terminal THEN 1 ELSE 0 END) OVER (
        PARTITION BY s.workspace_id, s.request_key
        ORDER BY s.created_at, s.seq
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ), 0) AS sealed_before
  FROM sealed s
),
resolved AS (
  SELECT
    p.*,
    (p.sealed_before + 1)::int AS generation,
    row_number() OVER (
      PARTITION BY p.workspace_id, p.request_key, p.sealed_before
      ORDER BY p.created_at, p.seq
    )::int AS version,
    -- A legacy execution row with no recorded expiry gets the default TTL from
    -- its OWN created_at: this is history at rest, so an old row is allowed to
    -- land already-expired (unlike a live insert — see the fill trigger).
    coalesce(
      p.legacy_expires_at,
      CASE WHEN p.action_kind = 'execution' THEN p.created_at + 86400000 ELSE NULL END
    ) AS expires_at
  FROM partitioned p
)
SELECT
  r.seq,
  r.workspace_id,
  r.legacy_id,
  r.legacy_version,
  hitl.request_id(r.workspace_id, r.request_key) AS new_id,
  r.request_key,
  r.generation,
  r.version,
  r.action_kind,
  r.canonicalization_version,
  r.expires_at,
  hitl.target_hash(r.target) AS target_hash,
  -- The title is packet identity (it is rendered on the approval card), and a
  -- legacy row has no origin/agent provenance — exactly the bytes packetHashOf()
  -- derives for the same converted row on the local backend.
  hitl.packet_hash_v1(
    r.action, r.action_kind, r.target, 'inline', r.content_hash,
    r.expires_at, r.canonicalization_version, r.title,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL
  ) AS packet_hash
FROM resolved r;

CREATE UNIQUE INDEX ON hitl_v2_backfill (seq);
CREATE INDEX ON hitl_v2_backfill (workspace_id, legacy_id, legacy_version);

-- =============================================================================
-- 5. drop the v1 unique — (workspace_id, id, version) would collide the moment
--    generation 2 opens at version 1.
-- =============================================================================
DO $drop_v1_unique$
DECLARE
  cname text;
BEGIN
  SELECT c.conname INTO cname
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'hitl' AND t.relname = 'requests' AND c.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM unnest(c.conkey) k
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
         = ARRAY['id', 'version', 'workspace_id'];
  IF cname IS NULL THEN
    RAISE EXCEPTION 'hitl 002: the v1 UNIQUE (workspace_id, id, version) on hitl.requests is missing — schema drift?';
  END IF;
  EXECUTE format('ALTER TABLE hitl.requests DROP CONSTRAINT %I', cname);
END
$drop_v1_unique$;

-- decisions FIRST: they join on the pre-re-key legacy (id, version) PAIR. The
-- version half is what makes the mapping deterministic — the preflight already
-- refused every decision whose named version does not exist, so this join hits
-- exactly one backfill row.
UPDATE hitl.decisions d
   SET request_id      = b.new_id,
       generation      = b.generation,
       request_version = b.version,
       decided_at      = d.created_at
  FROM hitl_v2_backfill b
 WHERE d.workspace_id   = b.workspace_id
   AND d.request_id     = b.legacy_id
   AND d.request_version = b.legacy_version;

UPDATE hitl.requests r
   SET id                       = b.new_id,
       legacy_id                = b.legacy_id,
       request_key              = b.request_key,
       generation               = b.generation,
       version                  = b.version,
       action_kind              = b.action_kind,
       target_hash              = b.target_hash,
       packet_hash              = b.packet_hash,
       canonicalization_version = b.canonicalization_version,
       expires_at               = b.expires_at
  FROM hitl_v2_backfill b
 WHERE r.seq = b.seq;


-- =============================================================================
-- 6. constraints, FK, indexes, triggers, views
-- =============================================================================

ALTER TABLE hitl.requests
  ADD CONSTRAINT requests_version_identity_key UNIQUE (workspace_id, id, generation, version),
  ADD CONSTRAINT requests_action_kind_check
    CHECK (action_kind IN ('editorial', 'execution')),
  -- Exactly one content channel: small exact text inline, or an immutable
  -- object-store reference.
  ADD CONSTRAINT requests_payload_channel_check
    CHECK ((payload IS NULL) <> (payload_ref IS NULL)),
  -- An execution request MUST expire. Editorial MAY be open-ended — the
  -- `now < expires_at` guard simply does not apply to it.
  ADD CONSTRAINT requests_execution_expiry_check
    CHECK (action_kind <> 'execution' OR expires_at IS NOT NULL),
  ADD CONSTRAINT requests_canonicalization_check
    CHECK (canonicalization_version >= 0),
  ADD CONSTRAINT requests_generation_version_check
    CHECK (generation >= 1 AND version >= 1),
  -- The supersession pointer is all-or-nothing.
  ADD CONSTRAINT requests_supersedes_coherent_check
    CHECK (num_nonnulls(supersedes_request_id, supersedes_generation, supersedes_version) IN (0, 3));

ALTER TABLE hitl.decisions
  ADD CONSTRAINT decisions_status_check
    CHECK (status IN ('approved', 'changes-requested', 'rejected', 'deferred', 'expired', 'cancelled')),
  ADD CONSTRAINT decisions_generation_check CHECK (generation >= 1),
  -- Decision/FK identity is (request_id, generation, version): a decision can
  -- only ever name a request VERSION that exists.
  ADD CONSTRAINT decisions_request_version_fkey
    FOREIGN KEY (workspace_id, request_id, generation, request_version)
    REFERENCES hitl.requests (workspace_id, id, generation, version);

-- At most ONE terminal decision per version — the deterministic single winner
-- for concurrent deciders (the loser gets 23505 -> ConflictError).
CREATE UNIQUE INDEX decisions_one_terminal_idx
  ON hitl.decisions (workspace_id, request_id, generation, request_version)
  WHERE terminal;

-- ...and at most one decision of any GIVEN status per version, which is what
-- blocks a duplicate `deferred` (deferred is non-terminal, so the index above
-- does not cover it).
CREATE UNIQUE INDEX decisions_status_once_idx
  ON hitl.decisions (workspace_id, request_id, generation, request_version, status);

CREATE INDEX decisions_version_seq_idx
  ON hitl.decisions (workspace_id, request_id, generation, request_version, seq DESC);

CREATE INDEX requests_key_head_idx
  ON hitl.requests (workspace_id, request_key, generation DESC, version DESC);
CREATE INDEX requests_expires_idx
  ON hitl.requests (workspace_id, expires_at);
CREATE INDEX requests_origin_task_idx
  ON hitl.requests (workspace_id, origin_task_id);
CREATE INDEX requests_origin_run_idx
  ON hitl.requests (workspace_id, origin_run_id);
CREATE INDEX requests_action_idx
  ON hitl.requests (workspace_id, action);
-- D-should-b: the supersession anti-join the projection and the trigger run on
-- every authority check.
CREATE INDEX requests_supersedes_idx
  ON hitl.requests (workspace_id, supersedes_request_id, supersedes_generation, supersedes_version)
  WHERE supersedes_request_id IS NOT NULL;

-- THE supersession anti-join, written once. A head is superseded when a live row
-- in some OTHER group points at exactly it (D3); it is served by the partial
-- index above. Every consumer calls this rather than restating the join:
-- hitl.request_state's `superseded` projection, the decision trigger's
-- decidability gate, and the requests trigger's allocation gate below. Declared
-- here (not with the section-1 helpers) because it reads columns section 3 adds.
CREATE FUNCTION hitl.head_superseded(p_workspace uuid, p_request_id text, p_generation int, p_version int)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM hitl.requests s
     WHERE s.workspace_id = p_workspace
       AND s.supersedes_request_id = p_request_id
       AND s.supersedes_generation = p_generation
       AND s.supersedes_version = p_version
  );
  $$;

-- ---- BEFORE INSERT on requests: derive what the writer omitted + scrub ----
-- Two jobs. (1) DERIVE-AND-VERIFY the four columns that are pure functions of
-- the row's own true inputs — action_kind = classify_action(action),
-- request_key = request_key(functionName, action, target), target_hash =
-- target_hash(target), and canonicalization_version (the content check further
-- down, which is per content CHANNEL). They are RECOMPUTED here every time: a writer that
-- omitted them (the v1-shaped #318 store, the legacy drain, a raw runtime
-- INSERT) gets them filled, and a writer that ASSERTED a different value is
-- REFUSED, never silently overwritten — a caller claiming a derivation it did
-- not compute is a bug or an attack, and both deserve to fail loudly.
-- Trusting them was the hole: with plain INSERT alone one could store
-- action='publish-post' as action_kind='editorial' with NO expiry (editorial may
-- be open-ended) and, once approved, hold an expiry-free EXECUTION approval that
-- both hitl.request_state.authoritative and canAuthorizeExecution() accepted;
-- and naming an arbitrary request_key opened a SECOND group for one real
-- (function, action, target), because the canonical-id check below only ever
-- proved the id matched the key the caller supplied.
-- Recomputation is also what makes that id check meaningful: the key it derives
-- from is now itself derived, so deterministic canonical ids are sufficient and
-- no separate UNIQUE (request_key) is needed.
-- (2) VALIDATE ALLOCATION, not just derivation (round-5 finding 2). Deriving a
-- row's identity says nothing about WHERE in its group's history the row may
-- land, and that was application-enforced only: the runtime holds INSERT on
-- hitl.requests, so a raw INSERT could add generation 2 version 1 to a group
-- whose head another group had already superseded — the existing pointer names
-- generation 1 version 1, so the new head read as unsuperseded, actionable and
-- approvable. Under the SAME per-group advisory lock the store and the decision
-- trigger take (re-entrant, so a store transaction that already holds it pays
-- nothing), an insert is now refused when it
--   (a) extends a group whose current head is superseded — permanent closure,
--       enforced by the database and not merely by planSubmission;
--   (b) claims a (generation, version) that is not the legal next step for that
--       group: no gaps, no reuse, no revision inside a sealed generation, and no
--       generation G+1 while generation G is still open; or
--   (c) names a supersession target that is not the current, not-already-
--       superseded head of the group it claims to replace, or one that is
--       EFFECTIVELY expired with no durable terminal decision (round-7); or
--   (d) revises a head that is EFFECTIVELY expired (round-6 finding 2).
-- SEALING and EXPIRY are two separate rules here, and the pair is what closes an
-- expired generation completely:
--   * G+1 is admitted only against a DURABLE terminal decision, never the clock.
--     Every store path that opens G+1 over an expired head materializes that
--     head's `expired` decision in the SAME transaction first, so the
--     decision-only test accepts every legal allocation while staying immune to
--     a clock that crosses the deadline between the store's plan and this
--     trigger.
--   * an in-place REVISION (g, v+1) is additionally refused while the head is
--     EFFECTIVELY expired (past `expires_at`, no terminal decision). Judging
--     that one by the durable decision alone was the hole: a raw G1/V2 landed on
--     an expired-but-unswept head, became the group's awaiting/actionable head,
--     and HID V1 from every future sweep — so the expiry the model requires was
--     never recorded at all. No legal store allocation is lost to it, because
--     `sealed` (the projection the store plans against) already counts the clock
--     and no store path ever plans a revision of an expired head.
--   * a SUPERSESSION pointer (c) is refused on the same clock-judged terms, for
--     the same loss: the pointer closes the source head permanently, so an
--     un-materialized expiry under it can never be written afterwards by anyone.
-- Together: an expired head accepts NOTHING until its expiry is durable, and
-- once it is, only G+1. Both rules are monotone in the same direction — a
-- decision is never un-recorded and a deadline never un-passes — so neither can
-- flip from refuse back to accept, and the ONE window either leaves (a deadline
-- crossed between the store's plan and this insert) resolves as a synchronous
-- ConflictError the caller re-plans as G+1, exactly like the decision trigger's
-- own expiry-direction check.
-- (3) sanitized_summary is re-scrubbed and byte-capped so the index projection
-- cannot be poisoned by a writer that holds only INSERT.
-- packet_hash is NOT recomputed: it covers jsonb fields whose JS canonical form
-- SQL cannot reproduce. A writer that supplies packet-visible fields WITHOUT a
-- packet hash is refused rather than hashed with those fields silently absent.
CREATE FUNCTION hitl.fill_request_derived() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    iso         text;
    body        text;
    now_ms      bigint;
    fn          text;
    true_kind   text;
    true_key    text;
    true_target_hash text;
    derived_key boolean := false;
    content_verified boolean;
    true_canon  int;
    canonical   text;
    rival       text;
    src_key     text;
    head        record;
    src_head    record;
    head_sealed boolean;
  BEGIN
    -- The SAME isolation contract the decisions trigger states, for the same
    -- reason: the allocation gate below locks the group and THEN reads its
    -- state, which only sees the lock holder's committed rows when each
    -- post-lock statement takes a fresh snapshot. Under REPEATABLE READ /
    -- SERIALIZABLE the snapshot predates the lock, so a writer queued behind a
    -- `replaces` reads the group as it was BEFORE the supersession and allocates
    -- a head beside the replacement — unsuperseded, actionable, and approvable
    -- alongside it. The store opens every HITL transaction at READ COMMITTED
    -- explicitly, so this refuses only a writer that did not.
    iso := current_setting('transaction_isolation');
    IF iso <> 'read committed' THEN
      RAISE EXCEPTION 'hitl: requests must be written at READ COMMITTED (this transaction is ''%'') — the allocation gate''s lock-then-read serialization cannot see a concurrent supersession or terminal decision under a snapshot taken before the lock', iso;
    END IF;

    fn := hitl.function_name(NEW.payload, NEW.payload_ref);
    true_kind := hitl.classify_action(NEW.action);
    true_key := hitl.request_key(fn, NEW.action, NEW.target);
    true_target_hash := hitl.target_hash(NEW.target);

    IF NEW.action_kind IS NULL THEN
      NEW.action_kind := true_kind;
    ELSIF NEW.action_kind IS DISTINCT FROM true_kind THEN
      RAISE EXCEPTION 'hitl: action_kind ''%'' is not the classification of action ''%'' (which is ''%'') — action_kind is DERIVED, never asserted',
        NEW.action_kind, NEW.action, true_kind
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.request_key IS NULL THEN
      derived_key := true;
      NEW.request_key := true_key;
    ELSIF NEW.request_key IS DISTINCT FROM true_key THEN
      -- The raw target is deliberately NOT echoed (it is caller-authored text
      -- the index projection scrubs); its hash identifies it precisely enough.
      RAISE EXCEPTION 'hitl: request_key % is not the key of (function %, action %) over this row''s own target % — request_key is DERIVED, never asserted',
        left(NEW.request_key, 12), fn, NEW.action, left(true_target_hash, 12)
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.target_hash IS NULL THEN
      NEW.target_hash := true_target_hash;
    ELSIF NEW.target_hash IS DISTINCT FROM true_target_hash THEN
      RAISE EXCEPTION 'hitl: target_hash % does not hash this row''s own target — target_hash is DERIVED, never asserted',
        left(NEW.target_hash, 12)
        USING ERRCODE = 'check_violation';
    END IF;

    -- CANONICAL IDENTITY. `id` is not a free-form label: it IS
    -- sha256(workspace_id, request_key), which is what makes "one group per
    -- request_key" true. Without this check, inserting the same
    -- function/action/target under an arbitrary id created a SECOND group that
    -- the head lookup, the projection and the decision trigger all treated as
    -- independent — so two rows for one request could each be authoritative.
    --   * a writer that DERIVED its key here (the v1-shaped / legacy-drain
    --     shape) is RE-KEYED onto the canonical id, old value preserved in
    --     legacy_id — that path is still reachable and must keep working;
    --   * a writer that SUPPLIED request_key (the v2 store) is refused, because
    --     an id that disagrees with its own key is a bug, not a legacy shape.
    canonical := hitl.request_id(NEW.workspace_id, NEW.request_key);
    IF NEW.id IS DISTINCT FROM canonical THEN
      IF derived_key THEN
        NEW.legacy_id := coalesce(NEW.legacy_id, NEW.id);
        NEW.id := canonical;
      ELSE
        RAISE EXCEPTION 'hitl: request id % is not the canonical request id % for its request_key — one request_key has exactly one group',
          NEW.id, canonical
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    -- Everything below reads GROUP STATE, so serialize on the per-group lock
    -- first — the same lock id the store's inGroupTxn and the decision trigger
    -- take, which makes this re-entrant inside a store transaction. A `replaces`
    -- row touches two groups, so both locks are taken in the SAME sorted order
    -- inGroupTxn uses (request_key is a lowercase sha256 hex string, so "C"
    -- order IS the store's JS sort order) — a raw INSERT can then queue behind a
    -- store transaction but never cycle with one. The source group's request_key
    -- is IMMUTABLE for the row, so reading it before the lock is safe; the same
    -- pre-lock read the decision trigger does.
    IF NEW.supersedes_request_id IS NOT NULL THEN
      SELECT s.request_key INTO src_key
        FROM hitl.requests s
       WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.supersedes_request_id
       LIMIT 1;
      -- Refused HERE rather than in (c) below, so (c)'s head read always runs
      -- holding the source group's lock. A PARTIAL pointer is deliberately left
      -- to requests_supersedes_coherent_check, which owns that shape.
      IF src_key IS NULL AND NEW.supersedes_generation IS NOT NULL AND NEW.supersedes_version IS NOT NULL THEN
        RAISE EXCEPTION 'hitl: supersedes % is not the current head of any request group — that group has no versions',
          NEW.supersedes_request_id
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF src_key IS NOT NULL AND src_key COLLATE "C" < NEW.request_key THEN
      PERFORM pg_advisory_xact_lock(hashtext(src_key) # 1212765260);
      PERFORM pg_advisory_xact_lock(hashtext(NEW.request_key) # 1212765260);
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext(NEW.request_key) # 1212765260);
      IF src_key IS NOT NULL AND src_key <> NEW.request_key THEN
        PERFORM pg_advisory_xact_lock(hashtext(src_key) # 1212765260);
      END IF;
    END IF;

    -- Belt and braces: no OTHER id may already hold this request_key (a row
    -- that predates the check, or a key/id pair minted by a future writer).
    SELECT x.id INTO rival
      FROM hitl.requests x
     WHERE x.workspace_id = NEW.workspace_id
       AND x.request_key = NEW.request_key
       AND x.id <> NEW.id
     LIMIT 1;
    IF rival IS NOT NULL THEN
      RAISE EXCEPTION 'hitl: request_key % already belongs to group % — refusing to open a second group under %',
        left(NEW.request_key, 12), rival, NEW.id
        USING ERRCODE = 'unique_violation';
    END IF;
    -- CONTENT VERIFICATION. canonicalization_version is not a label a writer may
    -- choose: it is the row's own assertion that its stored content_hash COVERS
    -- its stored content, and it is the assertion D8, hitl.request_state
    -- .authoritative and validateApproval() all rest on. So it is DERIVED here
    -- and REFUSED when asserted differently — the same posture as action_kind /
    -- request_key / target_hash above, and in BOTH directions: this schema
    -- derives exactly two values (1 when the content is verified, 0 when it is
    -- not), so a 0 asserted over verified content and a "forward-compatible"
    -- positive version the schema cannot verify are refused the same way an
    -- overstated 1 is. The TS side ships exactly one canonicalization version;
    -- introducing a second one is a schema change that teaches this function how
    -- to derive it, never a value a writer may assert past it.
    -- Without it a plain INSERT stored
    -- payload.body = 'benign text' beside content_hash = sha256('something
    -- executable') with canonicalization_version = 1, and the resulting approval
    -- authorized the packet the approver never saw.
    -- What "verified" means is per CHANNEL, because that is what the row binds:
    --   * inline  — payload->'body' must be a JSON STRING whose sha256 equals
    --               content_hash (byte-identical to the TS rule in
    --               hitl-store.ts / hitl-local-migrate.ts, which also require a
    --               string; an empty body that hashes to sha256('') IS verified);
    --   * ref     — the row carries no bytes at all, so what it binds is the
    --               REFERENCE: payload_ref->>'digest' must equal content_hash.
    --               The bytes themselves are verified against that digest by
    --               every reader that materializes them (resolveBody re-hashes
    --               what the object store returned), which is the only layer
    --               that can see them.
    -- Version 0 stays the legacy exemption (never write-verified) — and stays
    -- categorically non-authoritative per D8, so exempting it grants nothing.
    IF NEW.payload_ref IS NULL THEN
      body := CASE WHEN jsonb_typeof(NEW.payload->'body') = 'string' THEN NEW.payload->>'body' END;
      content_verified := body IS NOT NULL
        AND NEW.content_hash = encode(sha256(convert_to(body, 'UTF8')), 'hex');
    ELSE
      content_verified := NEW.payload_ref->>'digest' IS NOT NULL
        AND NEW.content_hash = NEW.payload_ref->>'digest';
    END IF;
    true_canon := CASE WHEN content_verified THEN 1 ELSE 0 END;
    IF NEW.canonicalization_version IS NULL THEN
      NEW.canonicalization_version := true_canon;
    ELSIF NEW.canonicalization_version IS DISTINCT FROM true_canon THEN
      RAISE EXCEPTION 'hitl: canonicalization_version % is not the value this row''s own % content derives (%): content_hash % % that content — canonicalization_version is DERIVED, never asserted',
        NEW.canonicalization_version,
        CASE WHEN NEW.payload_ref IS NULL THEN 'inline' ELSE 'payload_ref' END,
        true_canon, left(NEW.content_hash, 12),
        CASE WHEN content_verified THEN 'covers' ELSE 'does not cover' END
        USING ERRCODE = 'check_violation';
    END IF;
    -- The expiry default lives INSIDE the derive branch on purpose. A writer
    -- that supplied its own packet_hash computed that hash over its own expiry;
    -- silently substituting a different one here would leave a stored packet
    -- hash that no longer covers the stored expiry. Such a row is refused by
    -- requests_execution_expiry_check instead.
    IF NEW.packet_hash IS NULL THEN
      IF NEW.summary IS NOT NULL OR NEW.warnings IS NOT NULL OR NEW.side_effects IS NOT NULL
         OR NEW.choices IS NOT NULL OR NEW.payload_ref IS NOT NULL THEN
        RAISE EXCEPTION 'hitl: packet_hash must be supplied when the row carries summary/warnings/side_effects/choices/payload_ref'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.expires_at IS NULL AND NEW.action_kind = 'execution' THEN
        -- A request is never BORN expired: the default TTL runs from the LATER
        -- of the caller's created_at stamp and the server clock, so a v1-shaped
        -- writer with a zeroed/backdated stamp still gets a decidable request.
        now_ms := hitl.now_ms();
        NEW.expires_at := greatest(NEW.created_at, now_ms) + 86400000;
      END IF;
      NEW.packet_hash := hitl.packet_hash_v1(
        NEW.action, NEW.action_kind, NEW.target, 'inline', NEW.content_hash,
        NEW.expires_at, NEW.canonicalization_version, coalesce(NEW.payload->>'title', ''),
        NULL, NULL, NULL, NULL,
        NEW.origin_run_id, NEW.origin_task_id, NEW.requesting_agent);
    END IF;
    -- ---- ALLOCATION (a) + (b): where in ITS OWN group may this row land? ----
    SELECT r.generation, r.version, r.expires_at INTO head
      FROM hitl.requests r
     WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.id
     ORDER BY r.generation DESC, r.version DESC
     LIMIT 1;
    IF NOT FOUND THEN
      IF NEW.generation <> 1 OR NEW.version <> 1 THEN
        RAISE EXCEPTION 'hitl: request % has no history — the first row of a group is generation 1 version 1, not generation % version %',
          NEW.id, NEW.generation, NEW.version
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF hitl.head_superseded(NEW.workspace_id, NEW.id, head.generation, head.version) THEN
        RAISE EXCEPTION 'hitl: request % generation % version % was superseded by another request group — this group is closed and takes no further version',
          NEW.id, head.generation, head.version
          USING ERRCODE = 'unique_violation';
      END IF;
      head_sealed := EXISTS (
        SELECT 1 FROM hitl.decisions d
         WHERE d.workspace_id = NEW.workspace_id
           AND d.request_id = NEW.id
           AND d.generation = head.generation
           AND d.terminal
      );
      IF NEW.generation = head.generation THEN
        IF head_sealed THEN
          RAISE EXCEPTION 'hitl: generation % of request % is sealed — a revision cannot be allocated in it; open generation % version 1',
            head.generation, NEW.id, head.generation + 1
            USING ERRCODE = 'unique_violation';
        END IF;
        -- EFFECTIVELY expired, decision not yet materialized: revising in place
        -- would make this new version the head and hide the expired one from
        -- every future sweep, so the expiry the model requires would never be
        -- recorded. Record it first; the next generation then opens against the
        -- durable decision. (Same clock the projection and the decision trigger
        -- read — clock_timestamp(), not statement time.)
        now_ms := hitl.now_ms();
        IF head.expires_at IS NOT NULL AND now_ms >= head.expires_at THEN
          RAISE EXCEPTION 'hitl: request % generation % version % expired at % (now %) — record its expiry decision and open generation %, a revision cannot be allocated over an expired head',
            NEW.id, head.generation, head.version, head.expires_at, now_ms, head.generation + 1
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.version <> head.version + 1 THEN
          RAISE EXCEPTION 'hitl: request % generation % is at version % — the next version is %, not %',
            NEW.id, head.generation, head.version, head.version + 1, NEW.version
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.generation = head.generation + 1 THEN
        IF NOT head_sealed THEN
          RAISE EXCEPTION 'hitl: generation % of request % is still open — generation % cannot be opened until generation % carries a terminal decision',
            head.generation, NEW.id, NEW.generation, head.generation
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.version <> 1 THEN
          RAISE EXCEPTION 'hitl: generation % of request % opens at version 1, not version %',
            NEW.generation, NEW.id, NEW.version
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'hitl: request % is at generation % — a row may only extend it or open generation %, not generation %',
          NEW.id, head.generation, head.generation + 1, NEW.generation
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- ---- ALLOCATION (c): what may this row claim to supersede? ----
    -- The pointer is all-or-nothing (requests_supersedes_coherent_check owns the
    -- partial shape), so validate only the complete one.
    IF NEW.supersedes_request_id IS NOT NULL AND NEW.supersedes_generation IS NOT NULL
       AND NEW.supersedes_version IS NOT NULL THEN
      IF NEW.supersedes_request_id = NEW.id THEN
        RAISE EXCEPTION 'hitl: request % cannot supersede its own group — a same-key edit is a revision, not a supersession',
          NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      -- Read under the source group's OWN lock, taken above.
      SELECT r.generation, r.version, r.expires_at INTO src_head
        FROM hitl.requests r
       WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.supersedes_request_id
       ORDER BY r.generation DESC, r.version DESC
       LIMIT 1;
      IF NOT FOUND OR src_head.generation <> NEW.supersedes_generation
         OR src_head.version <> NEW.supersedes_version THEN
        RAISE EXCEPTION 'hitl: supersedes % generation % version % is not the current head of that group (head is generation % version %)',
          NEW.supersedes_request_id, NEW.supersedes_generation, NEW.supersedes_version,
          src_head.generation, src_head.version
          USING ERRCODE = 'check_violation';
      END IF;
      IF hitl.head_superseded(NEW.workspace_id, NEW.supersedes_request_id, NEW.supersedes_generation, NEW.supersedes_version) THEN
        RAISE EXCEPTION 'hitl: request % generation % version % is already superseded by another request group — one head is replaced exactly once',
          NEW.supersedes_request_id, NEW.supersedes_generation, NEW.supersedes_version
          USING ERRCODE = 'unique_violation';
      END IF;
      -- Rule (d), applied to a head closed by ANOTHER group instead of in place:
      -- an EFFECTIVELY expired source whose durable decision has not been
      -- written yet may not be superseded, because
      -- the supersession row makes it undecidable forever (the decision trigger
      -- refuses every decision on a superseded version, system expiry included,
      -- and both candidate scans skip it) — the transition would be lost, not
      -- deferred. Record it first, exactly as every store path now does inside
      -- the same two-lock transaction. Judged by the CLOCK for the same reason
      -- (d) is: the loss is caused by the deadline having passed, not by any
      -- decision. Monotone in both inputs, so the one window it leaves — a
      -- deadline crossed between the store's read and this insert — surfaces as
      -- the synchronous ConflictError the caller re-plans, never a silent hole.
      now_ms := hitl.now_ms();
      IF src_head.expires_at IS NOT NULL AND now_ms >= src_head.expires_at
         AND NOT EXISTS (
           SELECT 1 FROM hitl.decisions d
            WHERE d.workspace_id = NEW.workspace_id
              AND d.request_id = NEW.supersedes_request_id
              AND d.generation = NEW.supersedes_generation
              AND d.request_version = NEW.supersedes_version
              AND d.terminal
         ) THEN
        RAISE EXCEPTION 'hitl: request % generation % version % expired at % (now %) — record its expiry decision before superseding it, or the transition is lost',
          NEW.supersedes_request_id, NEW.supersedes_generation, NEW.supersedes_version,
          src_head.expires_at, now_ms
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    NEW.sanitized_summary := hitl.cap_index_bytes(hitl.scrub_index_text(NEW.sanitized_summary));
    RETURN NEW;
  END;
  $$;

CREATE TRIGGER requests_fill_derived
  BEFORE INSERT ON hitl.requests
  FOR EACH ROW EXECUTE FUNCTION hitl.fill_request_derived();

-- ---- BEFORE INSERT on decisions: the state machine, enforced by the DB ----
-- Admin-owned and PLAIN (no SECURITY DEFINER — the ops role invariant checker
-- treats a definer-rights function owned by a writer as an escape hatch).
--
-- D4 isolation contract: the lock-then-read serialization below is only sound
-- under READ COMMITTED, where each post-lock statement takes a FRESH snapshot
-- and therefore sees every decision committed by the holder that just released
-- the lock. Under REPEATABLE READ / SERIALIZABLE the snapshot predates the lock
-- and a concurrent terminal decision is invisible, so this trigger REFUSES to
-- run there; the store opens HITL transactions at READ COMMITTED explicitly.
CREATE FUNCTION hitl.enforce_decision() RETURNS trigger
  LANGUAGE plpgsql AS $$
  DECLARE
    iso    text;
    req    record;
    prior  record;
    head   record;
    now_ms bigint;
  BEGIN
    iso := current_setting('transaction_isolation');
    IF iso <> 'read committed' THEN
      RAISE EXCEPTION 'hitl: decisions must be written at READ COMMITTED (this transaction is ''%'') — the decision trigger''s lock-then-read serialization cannot see concurrent terminal decisions under a snapshot taken before the lock', iso;
    END IF;

    NEW.decided_at := coalesce(NEW.decided_at, NEW.created_at);

    -- request_key is IMMUTABLE for a row, so reading it before the lock is
    -- safe; every STATE-dependent read happens after it.
    SELECT r.request_key, r.expires_at INTO req
      FROM hitl.requests r
     WHERE r.workspace_id = NEW.workspace_id
       AND r.id = NEW.request_id
       AND r.generation = NEW.generation
       AND r.version = NEW.request_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'hitl: decision references request % generation % version %, which does not exist',
        NEW.request_id, NEW.generation, NEW.request_version
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(req.request_key) # 1212765260);  -- 0x4849544C, must equal HITL_GROUP_LOCK_MASK

    SELECT d.id, d.status INTO prior
      FROM hitl.decisions d
     WHERE d.workspace_id = NEW.workspace_id
       AND d.request_id = NEW.request_id
       AND d.generation = NEW.generation
       AND d.request_version = NEW.request_version
       AND d.terminal
     LIMIT 1;
    IF FOUND THEN
      -- D-should(a): the sweep's system expiry is deterministic
      -- (id = sha256(ws,'expired',request_id,generation,version)), so an
      -- IDENTICAL row arriving from a concurrent sweep is a no-op, not a
      -- conflict. Returning NEW lets the (workspace_id, id) unique absorb it
      -- under ON CONFLICT DO NOTHING; without this exemption the RAISE below
      -- would fire before ON CONFLICT could ever be evaluated and concurrent
      -- sweeps would diverge instead of converging. Short-circuits ON PURPOSE:
      -- the head/expiry checks would (correctly) refuse a re-materialization of
      -- an OLD generation's expiry.
      IF NEW.status = 'expired' AND prior.status = 'expired' AND prior.id = NEW.id THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'hitl: request % generation % version % already carries the terminal decision ''%''',
        NEW.request_id, NEW.generation, NEW.request_version, prior.status
        USING ERRCODE = 'unique_violation';
    END IF;

    -- Only the current version of the HIGHEST generation may be decided. The
    -- group is scoped by request_id, which IS the materialization of
    -- request_key (id = sha256(workspace_id, request_key)) for every row the v2
    -- store writes and for every row the backfill re-keyed. Scoping by id
    -- rather than by request_key additionally keeps a TRANSITIONAL v1-shaped
    -- INSERT (whose id still carries the content hash, so two same-key rows can
    -- exist under different ids) from being read as a rival head. The advisory
    -- lock above is still taken on the BROADER request_key, so all rows of a
    -- key serialize together either way.
    SELECT r.id, r.generation, r.version INTO head
      FROM hitl.requests r
     WHERE r.workspace_id = NEW.workspace_id
       AND r.id = NEW.request_id
     ORDER BY r.generation DESC, r.version DESC
     LIMIT 1;
    IF head.id <> NEW.request_id OR head.generation <> NEW.generation OR head.version <> NEW.request_version THEN
      RAISE EXCEPTION 'hitl: request % generation % version % is not the current head (head is % generation % version %)',
        NEW.request_id, NEW.generation, NEW.request_version, head.id, head.generation, head.version
        USING ERRCODE = 'unique_violation';
    END IF;

    -- A sealed generation accepts nothing further, even on a version that is
    -- not itself terminal (defence in depth: that shape is already an invariant
    -- violation).
    IF EXISTS (
      SELECT 1 FROM hitl.decisions d
       WHERE d.workspace_id = NEW.workspace_id
         AND d.request_id = NEW.request_id
         AND d.generation = NEW.generation
         AND d.terminal
    ) THEN
      RAISE EXCEPTION 'hitl: generation % of request % is already sealed', NEW.generation, NEW.request_id
        USING ERRCODE = 'unique_violation';
    END IF;

    -- D3: a head another group superseded via `replaces` is not decidable.
    IF hitl.head_superseded(NEW.workspace_id, NEW.request_id, NEW.generation, NEW.request_version) THEN
      RAISE EXCEPTION 'hitl: request % generation % version % was superseded by another request group',
        NEW.request_id, NEW.generation, NEW.request_version
        USING ERRCODE = 'unique_violation';
    END IF;

    -- Expiry direction, on the REAL clock read after the lock (never now(),
    -- which is transaction start and would let a long transaction decide a
    -- request that expired while it waited).
    now_ms := hitl.now_ms();
    IF NEW.status = 'expired' THEN
      IF req.expires_at IS NULL OR now_ms < req.expires_at THEN
        RAISE EXCEPTION 'hitl: cannot record an expiry for request % — it does not expire until % (now %)',
          NEW.request_id, coalesce(req.expires_at::text, 'never'), now_ms
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF req.expires_at IS NOT NULL AND now_ms >= req.expires_at THEN
        RAISE EXCEPTION 'hitl: request % expired at % (now %) — record the expiry, not a ''%'' decision',
          NEW.request_id, req.expires_at, now_ms, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    RETURN NEW;
  END;
  $$;

CREATE TRIGGER decisions_enforce_machine
  BEFORE INSERT ON hitl.decisions
  FOR EACH ROW EXECUTE FUNCTION hitl.enforce_decision();

-- ---- hitl.request_state: the authoritative projection ----
-- One row per request GROUP: the current version of its highest generation,
-- with decisions folded in. `effective_status` is SWEEP-INDEPENDENT — a request
-- past its expiry with no terminal decision reads 'expired' whether or not the
-- expiry sweep has materialized the durable decision yet, so the actionable
-- queue and the authority predicate can never depend on the sweep having run.
-- Mirrors deriveRequestState() in hitl-machine.ts.
CREATE VIEW hitl.request_state AS
SELECT
  h.workspace_id,
  h.request_id,
  h.request_key,
  h.generation,
  h.version,
  h.action,
  h.action_kind,
  h.target,
  h.target_hash,
  h.packet_hash,
  h.canonicalization_version,
  h.expires_at,
  h.created_at,
  h.seq,
  h.terminal_status,
  h.terminal_decision_id,
  h.decided_at,
  h.deferred,
  h.superseded,
  e.effective_status,
  (h.terminal_status IS NOT NULL OR (h.expires_at IS NOT NULL AND h.now_ms >= h.expires_at)) AS sealed,
  (
    e.effective_status = 'approved'
    AND NOT h.superseded
    -- D8: a legacy row whose content hash was never verified can never
    -- authorize execution, whatever its decision says.
    AND h.canonicalization_version > 0
    AND (
      CASE
        WHEN h.expires_at IS NULL THEN h.action_kind = 'editorial'
        ELSE h.now_ms < h.expires_at
      END
    )
  ) AS authoritative
FROM (
  -- Grouped by request_id — the materialization of request_key — for the same
  -- reason the trigger scopes its head lookup that way.
  SELECT DISTINCT ON (r.workspace_id, r.id)
    r.workspace_id,
    r.id AS request_id,
    r.request_key,
    r.generation,
    r.version,
    r.action,
    r.action_kind,
    r.target,
    r.target_hash,
    r.packet_hash,
    r.canonicalization_version,
    r.expires_at,
    r.created_at,
    r.seq,
    hitl.now_ms() AS now_ms,
    t.status AS terminal_status,
    t.id AS terminal_decision_id,
    t.decided_at,
    EXISTS (
      SELECT 1 FROM hitl.decisions dd
       WHERE dd.workspace_id = r.workspace_id AND dd.request_id = r.id
         AND dd.generation = r.generation AND dd.request_version = r.version
         AND dd.status = 'deferred'
    ) AS deferred,
    hitl.head_superseded(r.workspace_id, r.id, r.generation, r.version) AS superseded
  FROM hitl.requests r
  LEFT JOIN LATERAL (
    SELECT d.id, d.status, d.decided_at
      FROM hitl.decisions d
     WHERE d.workspace_id = r.workspace_id AND d.request_id = r.id
       AND d.generation = r.generation AND d.request_version = r.version
       AND d.terminal
     ORDER BY d.decided_at, d.seq
     LIMIT 1
  ) t ON true
  ORDER BY r.workspace_id, r.id, r.generation DESC, r.version DESC
) h
CROSS JOIN LATERAL (
  SELECT CASE
    -- Terminal dominates: an approval recorded before the deadline stays
    -- 'approved' as a STATUS; `authoritative` above is what refuses to act on
    -- it once the clock passes.
    WHEN h.terminal_status IS NOT NULL THEN h.terminal_status
    WHEN h.expires_at IS NOT NULL AND h.now_ms >= h.expires_at THEN 'expired'
    WHEN h.deferred THEN 'deferred'
    ELSE 'awaiting'
  END AS effective_status
) e;

-- ---- hitl.request_index: the sanitized projection ----
-- Safe inputs for a future semantic-index job (#325) and nothing else:
-- internally-derived digests that PROVE their shape, closed enums, numbers, and
-- the DB-owned sanitized_summary. Never the raw target, summary, payload,
-- feedback, or any caller-authored free text.
CREATE VIEW hitl.request_index AS
SELECT
  s.workspace_id,
  hitl.safe_digest(s.request_id) AS request_id,
  hitl.safe_digest(s.request_key) AS request_key,
  hitl.safe_digest(s.target_hash) AS target_hash,
  hitl.safe_digest(s.packet_hash) AS packet_hash,
  hitl.safe_token(s.action) AS action,
  s.action_kind,
  s.generation,
  s.version,
  s.effective_status,
  s.canonicalization_version,
  s.expires_at,
  s.created_at,
  r.sanitized_summary
FROM hitl.request_state s
JOIN hitl.requests r
  ON r.workspace_id = s.workspace_id
 AND r.id = s.request_id
 AND r.generation = s.generation
 AND r.version = s.version;

-- =============================================================================
-- 7. SET NOT NULL (the backfill + the fill trigger together guarantee these)
-- =============================================================================

ALTER TABLE hitl.requests
  ALTER COLUMN request_key              SET NOT NULL,
  ALTER COLUMN target_hash              SET NOT NULL,
  ALTER COLUMN packet_hash              SET NOT NULL,
  ALTER COLUMN canonicalization_version SET NOT NULL,
  ALTER COLUMN action_kind              SET NOT NULL;

ALTER TABLE hitl.decisions
  ALTER COLUMN decided_at SET NOT NULL;

-- =============================================================================
-- 8. component + capability bump (admin-authored, runtime-read-only)
-- =============================================================================
UPDATE hitl.meta
   SET component_version = 2,
       capabilities = '["requests","decisions","state-machine"]'::jsonb
 WHERE singleton;
