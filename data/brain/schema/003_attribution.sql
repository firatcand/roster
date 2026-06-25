-- Caller-asserted attribution (source/confidence/actor). These are UNTRUSTED:
-- the runtime role supplies them on INSERT, so they are claims, not provenance.
-- Trusted, non-spoofable audit lives in id (GENERATED ALWAYS) + recorded_at only.
ALTER TABLE brain.facts ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE brain.facts ADD COLUMN IF NOT EXISTS confidence real;
ALTER TABLE brain.facts ADD COLUMN IF NOT EXISTS actor text;

ALTER TABLE brain.events ADD COLUMN IF NOT EXISTS actor text;

ALTER TABLE brain.edges ADD COLUMN IF NOT EXISTS actor text;

CREATE OR REPLACE VIEW brain.current_facts AS
  SELECT DISTINCT ON (entity_id, key)
         id, recorded_at, entity_id, key, value, source, confidence, actor
  FROM brain.facts
  ORDER BY entity_id, key, id DESC;
