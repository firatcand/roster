REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA brain FROM PUBLIC;

CREATE OR REPLACE FUNCTION brain.create_table(name text, columns jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, brain, pg_temp
AS $fn$
DECLARE
  col jsonb;
  col_name text;
  col_type text;
  type_sql text;
  cols_sql text := '';
  allowed_types jsonb := '{
    "text": "text",
    "int": "integer",
    "bigint": "bigint",
    "numeric": "numeric",
    "boolean": "boolean",
    "timestamptz": "timestamptz",
    "jsonb": "jsonb",
    "uuid": "uuid"
  }'::jsonb;
BEGIN
  IF name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'invalid table name: %', name;
  END IF;

  IF jsonb_typeof(columns) <> 'array' THEN
    RAISE EXCEPTION 'columns must be a json array';
  END IF;

  FOR col IN SELECT * FROM jsonb_array_elements(columns)
  LOOP
    col_name := col->>'name';
    col_type := col->>'type';

    IF col_name IS NULL OR col_name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
      RAISE EXCEPTION 'invalid column name: %', col_name;
    END IF;
    IF col_name IN ('id', 'recorded_at') THEN
      RAISE EXCEPTION 'column name % is reserved', col_name;
    END IF;

    type_sql := allowed_types->>col_type;
    IF type_sql IS NULL THEN
      RAISE EXCEPTION 'disallowed column type: %', col_type;
    END IF;

    cols_sql := cols_sql || format(', %I %s', col_name, type_sql);
  END LOOP;

  EXECUTE format(
    'CREATE TABLE brain.%I (
       id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       recorded_at timestamptz NOT NULL DEFAULT now()%s
     )',
    name, cols_sql
  );

  EXECUTE format('ALTER TABLE brain.%I OWNER TO CURRENT_USER', name);

  DECLARE
    insert_cols text;
    rw_role text;
  BEGIN
    SELECT string_agg(format('%I', a.attname), ', ')
      INTO insert_cols
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = format('brain.%I', name)::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attgenerated = ''
       AND a.attname NOT IN ('id', 'recorded_at');

    FOR rw_role IN
      SELECT rr.rolname
        FROM brain_meta.runtime_roles rr
        JOIN pg_catalog.pg_roles r ON r.rolname = rr.rolname
       WHERE NOT r.rolsuper
         AND NOT r.rolcreaterole
         AND NOT r.rolcreatedb
         AND NOT r.rolbypassrls
         AND NOT r.rolreplication
         AND r.rolcanlogin
         AND r.rolname <> CURRENT_USER
    LOOP
      EXECUTE format('GRANT SELECT ON brain.%I TO %I', name, rw_role);
      IF insert_cols IS NOT NULL THEN
        EXECUTE format('GRANT INSERT (%s) ON brain.%I TO %I', insert_cols, name, rw_role);
      END IF;
    END LOOP;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION brain.create_table(text, jsonb) FROM PUBLIC;
