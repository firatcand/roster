-- ROS-138: hybrid semantic search. pgvector embeddings on document chunks +
-- in-DB brain config. Production runs on Neon (pgvector built in); local/CI test
-- Postgres must have the extension installed (CI uses the pgvector/pgvector image).
CREATE EXTENSION IF NOT EXISTS vector;

-- Embeddings live on document chunks. Nullable: NULL when embeddings are
-- disabled or not yet computed for a row. Append-only — set at INSERT time on
-- mount, never UPDATEd; back-filling pre-existing rows is ROS-142 (reindex).
-- embedding_model records the producing model so the vector arm can ignore
-- vectors from a different model (and ROS-142 can detect a model change).
ALTER TABLE brain.documents ADD COLUMN embedding vector(1536);
ALTER TABLE brain.documents ADD COLUMN embedding_model text;

-- current_documents was defined with `SELECT d.*`, which Postgres froze to the
-- columns that existed in 004. Recreate it so the view re-expands d.* and exposes
-- the new embedding columns to the (admin-owned) view that search reads through.
-- CREATE OR REPLACE preserves the existing grants and only appends the new columns.
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

-- Approximate nearest-neighbour over cosine distance (OpenAI embeddings are
-- normalized; cosine is the right metric). NULL embeddings are simply not indexed.
CREATE INDEX documents_embedding_hnsw
  ON brain.documents USING hnsw (embedding vector_cosine_ops);

-- In-DB brain settings (provider/model/enabled + search knobs). NOT secrets —
-- the embedding API key is read from the environment (Infisical), never stored.
-- Lives in brain_meta (not brain.*) so it stays out of the standard table shape
-- the backup/export path serializes.
CREATE TABLE brain_meta.config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
