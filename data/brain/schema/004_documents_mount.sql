CREATE TABLE brain.mounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_path text NOT NULL,
  file_hash text NOT NULL
);

CREATE INDEX mounts_source_path_id_idx ON brain.mounts (source_path, id);

ALTER TABLE brain.documents RENAME COLUMN uri TO source_path;
ALTER TABLE brain.documents RENAME COLUMN chunk_ix TO chunk_index;
ALTER TABLE brain.documents RENAME COLUMN body TO content;
ALTER TABLE brain.documents RENAME COLUMN meta TO frontmatter;

ALTER TABLE brain.documents ADD COLUMN content_hash text NOT NULL;
ALTER TABLE brain.documents ADD COLUMN mount_id bigint NOT NULL;
ALTER TABLE brain.documents
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX documents_tsv_idx ON brain.documents USING gin (tsv);
CREATE INDEX documents_mount_id_idx ON brain.documents (mount_id);
CREATE INDEX documents_source_path_id_idx ON brain.documents (source_path, id);

-- Referential integrity: a chunk must reference a real mount (no dangling mount_id).
ALTER TABLE brain.documents
  ADD CONSTRAINT documents_mount_id_fkey FOREIGN KEY (mount_id) REFERENCES brain.mounts (id);

-- Current = chunks of the latest mount per source_path. Only mounts that
-- actually have chunks are eligible, so an empty mount row can never hide the
-- previous current set.
CREATE OR REPLACE VIEW brain.current_documents AS
  WITH latest AS (
    SELECT DISTINCT ON (m.source_path) m.id AS mount_id
    FROM brain.mounts m
    WHERE EXISTS (SELECT 1 FROM brain.documents d WHERE d.mount_id = m.id)
    ORDER BY m.source_path, m.id DESC
  )
  SELECT d.*
  FROM brain.documents d
  JOIN latest l ON d.mount_id = l.mount_id;
