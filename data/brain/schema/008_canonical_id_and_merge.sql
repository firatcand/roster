-- ROS-146: index-friendly canonical resolution for large brains.
--
-- 1. A materialized brain.entities.canonical_id cache, derived from the
--    append-only merge map (entity_merges stays the source of truth), so
--    canonicalized reads filter on an indexed plain column instead of the
--    STABLE brain.canonical_id() function (which cannot back an index).
-- 2. The merge operation moves into an admin-owned SECURITY DEFINER function so
--    the cache can never be bypassed by a direct entity_merges INSERT; the
--    runtime role's raw INSERT on entity_merges / entity_aliases is revoked in
--    roles.ts. This also makes the cycle guard unbypassable.

-- --- materialized canonical_id cache -----------------------------------------

ALTER TABLE brain.entities ADD COLUMN canonical_id bigint;

UPDATE brain.entities SET canonical_id = brain.canonical_id(id);

-- New entities are their own canonical until merged. The BEFORE INSERT trigger
-- fills it from the freshly-assigned identity id; COALESCE preserves an explicit
-- value supplied by an id-preserving import (which runs as the admin/owner).
CREATE OR REPLACE FUNCTION brain.entities_set_canonical()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.canonical_id := COALESCE(NEW.canonical_id, NEW.id);
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER entities_set_canonical_trg
  BEFORE INSERT ON brain.entities
  FOR EACH ROW EXECUTE FUNCTION brain.entities_set_canonical();

ALTER TABLE brain.entities ALTER COLUMN canonical_id SET NOT NULL;

CREATE INDEX entities_canonical_id_idx ON brain.entities (canonical_id);

-- Index every dedup-prefilter disjunct and every canonicalized-get join so they
-- use indexes (BitmapOr / Index Scan), not seq scans, on large brains.
CREATE INDEX entities_lower_slug_idx ON brain.entities (lower(slug));
CREATE INDEX entities_lower_title_idx ON brain.entities (lower(title));
CREATE INDEX facts_entity_id_idx ON brain.facts (entity_id);
CREATE INDEX events_entity_id_idx ON brain.events (entity_id);
CREATE INDEX edges_src_id_idx ON brain.edges (src_id);
CREATE INDEX edges_dst_id_idx ON brain.edges (dst_id);
CREATE INDEX entity_merges_into_id_idx ON brain.entity_merges (into_id);

-- --- cache maintenance --------------------------------------------------------

-- Recompute entities.canonical_id for `affected` and every entity whose CURRENT
-- merge chain resolves through it (reverse reachability over the latest-row-per
-- from_id forest), so transitive/reparenting merges are covered. Admin-owned so
-- the runtime role never needs UPDATE on entities.
CREATE OR REPLACE FUNCTION brain.refresh_canonical(affected bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
BEGIN
  WITH RECURSIVE preds(node) AS (
    SELECT affected
    UNION
    SELECT m.from_id
      FROM brain.entity_merges m
      JOIN preds p ON p.node = m.into_id
     WHERE m.id = (SELECT mm.id FROM brain.entity_merges mm
                    WHERE mm.from_id = m.from_id ORDER BY mm.id DESC LIMIT 1)
  )
  UPDATE brain.entities e
     SET canonical_id = brain.canonical_id(e.id)
    FROM preds
   WHERE e.id = preds.node;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.refresh_canonical(bigint) FROM PUBLIC;

-- --- merge moved into the database -------------------------------------------

-- The single authority for recording a merge: takes the global advisory lock,
-- rejects cycles (now unbypassable), writes the append-only merge + alias rows,
-- and refreshes the canonical cache -- all atomically within one statement.
-- Returns the merge id, alias count, and the post-merge canonical id of p_from.
CREATE OR REPLACE FUNCTION brain.merge_entities(p_from bigint, p_into bigint, p_actor text)
RETURNS TABLE (merge_id bigint, aliases_added integer, canonical_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
DECLARE
  v_reaches boolean;
  v_merge_id bigint;
  v_aliases integer := 0;
  v_from_kind text;
  v_into_kind text;
  v_from_slug text;
  v_from_title text;
BEGIN
  IF p_from IS NULL OR p_into IS NULL THEN
    RAISE EXCEPTION 'merge requires both entity ids';
  END IF;
  IF p_from = p_into THEN
    RAISE EXCEPTION 'cannot merge an entity into itself';
  END IF;

  -- This SECURITY DEFINER function is the runtime-callable boundary (the TS
  -- wrapper resolves slugs but a runtime role can call it directly with raw
  -- ids). Validate both entities exist and share a kind so a direct call can't
  -- forge a cross-kind canonical chain.
  SELECT kind INTO v_from_kind FROM brain.entities WHERE id = p_from;
  SELECT kind INTO v_into_kind FROM brain.entities WHERE id = p_into;
  IF v_from_kind IS NULL OR v_into_kind IS NULL THEN
    RAISE EXCEPTION 'merge target entity not found';
  END IF;
  IF v_from_kind <> v_into_kind THEN
    RAISE EXCEPTION 'cannot merge entities of different kinds (% vs %)', v_from_kind, v_into_kind;
  END IF;

  -- Serialize the guard+insert against other merges (auto-released at statement end).
  PERFORM pg_advisory_xact_lock(8135140);

  -- Recording from->into makes from's latest-row successor into. That closes a
  -- loop iff from already lies anywhere on into's canonical chain (incl. a
  -- reparented intermediate node). Walk into's latest-row chain; reject if it
  -- reaches from.
  WITH RECURSIVE chain AS (
    SELECT p_into AS node, 0 AS depth
    UNION ALL
    SELECT m.into_id, c.depth + 1
      FROM chain c
      JOIN LATERAL (
        SELECT into_id FROM brain.entity_merges
         WHERE from_id = c.node ORDER BY id DESC LIMIT 1
      ) m ON true
     WHERE c.depth < 10000
  )
  SELECT bool_or(node = p_from) INTO v_reaches FROM chain;
  IF v_reaches THEN
    RAISE EXCEPTION 'merge would create a cycle';
  END IF;

  INSERT INTO brain.entity_merges (from_id, into_id, actor)
       VALUES (p_from, p_into, p_actor)
    RETURNING id INTO v_merge_id;

  SELECT slug, title INTO v_from_slug, v_from_title
    FROM brain.entities WHERE id = p_from;

  IF v_from_slug IS NOT NULL AND length(v_from_slug) > 0 THEN
    INSERT INTO brain.entity_aliases (entity_id, alias, source, actor)
         VALUES (p_into, v_from_slug, 'merge', p_actor);
    v_aliases := v_aliases + 1;
  END IF;
  IF v_from_title IS NOT NULL AND length(v_from_title) > 0 THEN
    INSERT INTO brain.entity_aliases (entity_id, alias, source, actor)
         VALUES (p_into, v_from_title, 'merge', p_actor);
    v_aliases := v_aliases + 1;
  END IF;

  PERFORM brain.refresh_canonical(p_from);

  RETURN QUERY SELECT v_merge_id, v_aliases, brain.canonical_id(p_from);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.merge_entities(bigint, bigint, text) FROM PUBLIC;

-- --- index-friendly resolved facts view --------------------------------------

-- Resolve via the materialized column (join) instead of calling the STABLE
-- canonical_id() per row, so a filter on canonical_id is index-backed.
CREATE OR REPLACE VIEW brain.resolved_current_facts AS
  SELECT DISTINCT ON (en.canonical_id, f.key)
         f.id, f.recorded_at, en.canonical_id, f.key, f.value, f.source, f.confidence, f.actor
  FROM brain.facts f
  JOIN brain.entities en ON en.id = f.entity_id
  ORDER BY en.canonical_id, f.key, f.id DESC;

-- --- close the upgrade window -------------------------------------------------

-- On an existing brain, registered runtime roles already hold raw INSERT on the
-- merge tables. Revoke it atomically with this migration (REVOKE INSERT clears
-- column-level grants too) so there is no window where a role can bypass
-- brain.merge_entities, and so non-current roles are fixed even though a later
-- applyGrants only re-grants the one role it is given. applyGrants re-establishes
-- the correct minimal set (SELECT only) on every role-ensure.
DO $$
DECLARE r text;
BEGIN
  EXECUTE 'REVOKE INSERT ON brain.entity_merges FROM PUBLIC';
  EXECUTE 'REVOKE INSERT ON brain.entity_aliases FROM PUBLIC';
  -- Join pg_roles so a stale registry row for a since-dropped role does not make
  -- REVOKE ... FROM <missing_role> error and abort the whole upgrade.
  FOR r IN SELECT rr.rolname FROM brain_meta.runtime_roles rr
             JOIN pg_roles pr ON pr.rolname = rr.rolname LOOP
    EXECUTE format('REVOKE INSERT ON brain.entity_merges FROM %I', r);
    EXECUTE format('REVOKE INSERT ON brain.entity_aliases FROM %I', r);
  END LOOP;
END $$;
