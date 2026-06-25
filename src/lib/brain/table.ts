import type pg from 'pg';

export type ColumnSpec = {
  name: string;
  type: string;
};

export type TableInfo = {
  name: string;
  columns: { name: string; type: string }[];
};

export async function createTable(
  client: pg.PoolClient | pg.Client,
  name: string,
  columns: ColumnSpec[],
): Promise<void> {
  await client.query(`SELECT brain.create_table($1, $2::jsonb)`, [name, JSON.stringify(columns)]);
}

const CORE_TABLES = new Set([
  'entities',
  'facts',
  'events',
  'edges',
  'documents',
  'mounts',
]);

export async function listTables(
  client: pg.PoolClient | pg.Client,
  includeCore = false,
): Promise<TableInfo[]> {
  const t = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'brain' ORDER BY tablename`,
  );
  const result: TableInfo[] = [];
  for (const row of t.rows) {
    if (!includeCore && CORE_TABLES.has(row.tablename)) continue;
    const cols = await client.query<{ name: string; type: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = ('brain.' || quote_ident($1))::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [row.tablename],
    );
    result.push({ name: row.tablename, columns: cols.rows });
  }
  return result;
}
