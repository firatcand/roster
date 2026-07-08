-- ROS-157: brain file system. S3 holds the file bytes (mutable); this table is
-- the append-only LEDGER of every file event. Latest-id-wins per
-- (kind, slug, filename) defines current state; op='rm' rows are tombstones, so
-- a delete is recorded as history rather than erased.
--
-- source_path is the exact `s3://<bucket>/<key>` URI the put indexed under — the
-- join key into brain.mounts/brain.documents. It is recorded verbatim on every
-- row so a later bucket/prefix config change can never detach a tombstone from
-- the chunks it must hide.
CREATE TABLE brain.files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  slug text NOT NULL,
  filename text NOT NULL,
  op text NOT NULL CHECK (op IN ('put', 'rm')),
  source_path text NOT NULL,
  bucket text NOT NULL,
  s3_key text NOT NULL,
  size_bytes bigint,
  content_hash text,
  etag text,
  content_type text,
  -- The indexing generation for a text file (NULL for binaries and rm rows).
  mount_id bigint REFERENCES brain.mounts (id),
  actor text,
  -- A put must carry the bytes' hash; an rm never does. This is the ledger's
  -- integrity spine — it makes `op` and the payload columns agree.
  CONSTRAINT files_put_has_hash CHECK ((op = 'put') = (content_hash IS NOT NULL))
);

CREATE INDEX files_addr_id_idx ON brain.files (kind, slug, filename, id);
CREATE INDEX files_source_path_id_idx ON brain.files (source_path, id);

-- Current files = the latest event per address, minus tombstones.
CREATE VIEW brain.current_files AS
  SELECT *
  FROM (
    SELECT DISTINCT ON (kind, slug, filename) *
    FROM brain.files
    ORDER BY kind, slug, filename, id DESC
  ) latest
  WHERE latest.op = 'put';

-- Tombstone-aware current_documents. Same latest-with-chunks-mount core as 004
-- (redefined in 007), plus an address-aware visibility predicate over the file
-- ledger. Redefining the view (rather than joining the ledger inside search.ts)
-- makes every reader — both search arms, `brain sql`, reindex, and gc —
-- ledger-aware with zero TypeScript changes.
--
-- Visibility is decided on the file ADDRESS (kind, slug, filename), NOT on the
-- raw source_path — because a bucket/prefix config change re-puts one file at a
-- new s3:// URI, and latest-id-wins must follow the address, not the URI. A
-- managed chunk's source_path is current only while it is the head of its
-- address AND that head is a put:
--
--   * rm hides chunks — the address head is a tombstone.
--   * re-put after rm resurfaces them — a newer 'put' row becomes the head;
--     unchanged bytes reuse the old (still latest-with-chunks) mount.
--   * re-put at a NEW source_path (config change) hides the old URI's chunks and
--     shows the new URI's — the address head moved, so the view self-corrects
--     without any compensating tombstone from the verb layer.
--   * plain `brain mount` paths never appear in the ledger, so they are never
--     hidden (the LEFT JOIN leaves source_addr NULL → always visible).
--
-- CREATE OR REPLACE with an unchanged column list preserves the view's grants
-- (the 007 precedent).
CREATE OR REPLACE VIEW brain.current_documents AS
  WITH latest AS (
    SELECT DISTINCT ON (m.source_path) m.id AS mount_id, m.source_path
    FROM brain.mounts m
    WHERE EXISTS (SELECT 1 FROM brain.documents d WHERE d.mount_id = m.id)
    ORDER BY m.source_path, m.id DESC
  ),
  -- The address each managed source_path was last filed under (uses
  -- files_source_path_id_idx).
  source_addr AS (
    SELECT DISTINCT ON (source_path)
      source_path, kind, slug, filename
    FROM brain.files
    ORDER BY source_path, id DESC
  ),
  -- The current head of every file address: latest ledger row per
  -- (kind, slug, filename) (uses files_addr_id_idx).
  file_head AS (
    SELECT DISTINCT ON (kind, slug, filename)
      kind, slug, filename, op, source_path AS head_path
    FROM brain.files
    ORDER BY kind, slug, filename, id DESC
  )
  SELECT d.*
  FROM brain.documents d
  JOIN latest l ON d.mount_id = l.mount_id
  LEFT JOIN source_addr sa ON sa.source_path = l.source_path
  LEFT JOIN file_head fh
    ON fh.kind = sa.kind AND fh.slug = sa.slug AND fh.filename = sa.filename
  WHERE sa.source_path IS NULL
     OR (fh.op = 'put' AND fh.head_path = l.source_path);
