CREATE TABLE brain_meta.workspace_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workspace_id text NOT NULL CHECK (
    octet_length(workspace_id) BETWEEN 1 AND 80
    AND workspace_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    AND workspace_id !~* '^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$'
  ),
  fingerprint_format_version smallint NOT NULL CHECK (fingerprint_format_version = 1),
  namespace_fingerprint text NOT NULL CHECK (namespace_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  database_authority_id uuid NOT NULL,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  migration_state text NOT NULL CHECK (migration_state IN ('migrating', 'ready'))
);

REVOKE CREATE ON SCHEMA brain_meta FROM PUBLIC;
REVOKE ALL PRIVILEGES ON brain_meta.workspace_identity FROM PUBLIC;

CREATE FUNCTION brain_meta.reject_workspace_identity_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_meta, pg_temp
AS $fn$
BEGIN
  IF NEW.singleton IS DISTINCT FROM OLD.singleton
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.fingerprint_format_version IS DISTINCT FROM OLD.fingerprint_format_version
    OR NEW.namespace_fingerprint IS DISTINCT FROM OLD.namespace_fingerprint
    OR NEW.database_authority_id IS DISTINCT FROM OLD.database_authority_id
    OR NEW.initialized_at IS DISTINCT FROM OLD.initialized_at THEN
    RAISE EXCEPTION 'workspace identity fields are immutable';
  END IF;
  IF OLD.migration_state = 'migrating' AND NEW.migration_state = 'ready' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workspace identity state may only transition from migrating to ready';
END;
$fn$;

CREATE FUNCTION brain_meta.reject_workspace_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_meta, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'workspace identity cannot be deleted';
END;
$fn$;

CREATE FUNCTION brain_meta.reject_workspace_identity_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, brain_meta, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'workspace identity cannot be truncated';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain_meta.reject_workspace_identity_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_meta.reject_workspace_identity_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION brain_meta.reject_workspace_identity_truncate() FROM PUBLIC;

CREATE TRIGGER workspace_identity_immutable
  BEFORE UPDATE ON brain_meta.workspace_identity
  FOR EACH ROW EXECUTE FUNCTION brain_meta.reject_workspace_identity_update();

CREATE TRIGGER workspace_identity_no_delete
  BEFORE DELETE ON brain_meta.workspace_identity
  FOR EACH ROW EXECUTE FUNCTION brain_meta.reject_workspace_identity_delete();

CREATE TRIGGER workspace_identity_no_truncate
  BEFORE TRUNCATE ON brain_meta.workspace_identity
  FOR EACH STATEMENT EXECUTE FUNCTION brain_meta.reject_workspace_identity_truncate();
