CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE brain.entity_merges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  from_id bigint NOT NULL REFERENCES brain.entities(id),
  into_id bigint NOT NULL REFERENCES brain.entities(id),
  actor text,
  CHECK (from_id <> into_id)
);

CREATE INDEX entity_merges_from_id_idx ON brain.entity_merges (from_id);

CREATE TABLE brain.entity_aliases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  entity_id bigint NOT NULL REFERENCES brain.entities(id),
  alias text NOT NULL,
  source text,
  actor text
);

CREATE INDEX entity_aliases_lower_alias_idx ON brain.entity_aliases (lower(alias));
CREATE INDEX entity_aliases_alias_trgm_idx ON brain.entity_aliases USING gin (alias gin_trgm_ops);

CREATE INDEX entities_slug_trgm_idx ON brain.entities USING gin (slug gin_trgm_ops);
CREATE INDEX entities_title_trgm_idx ON brain.entities USING gin (title gin_trgm_ops);

-- Follow the append-only merge map from_id -> into_id transitively until no
-- further merge. The current mapping for a from_id is its latest merge row
-- (max id). Cycle-guarded by a depth cap; a malformed chain returns the last
-- node reached rather than looping forever.
CREATE OR REPLACE FUNCTION brain.canonical_id(start_id bigint)
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  current_id bigint := start_id;
  next_id bigint;
  steps int := 0;
BEGIN
  IF start_id IS NULL THEN
    RETURN NULL;
  END IF;
  LOOP
    SELECT m.into_id INTO next_id
      FROM brain.entity_merges m
     WHERE m.from_id = current_id
     ORDER BY m.id DESC
     LIMIT 1;
    IF next_id IS NULL THEN
      RETURN current_id;
    END IF;
    IF next_id = start_id THEN
      RETURN current_id;
    END IF;
    current_id := next_id;
    steps := steps + 1;
    IF steps > 10000 THEN
      RETURN current_id;
    END IF;
  END LOOP;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.canonical_id(bigint) FROM PUBLIC;

-- Each current fact mapped through the merge map, then latest-wins per
-- (canonical_id, key) so a get on the canonical entity unifies facts across
-- all merged-in entities.
CREATE OR REPLACE VIEW brain.resolved_current_facts AS
  SELECT DISTINCT ON (canonical_id, key)
         id, recorded_at, brain.canonical_id(entity_id) AS canonical_id, key, value, source, confidence, actor
  FROM brain.facts
  ORDER BY brain.canonical_id(entity_id), key, id DESC;
