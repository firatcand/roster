import { randomBytes } from 'node:crypto';
import type pg from 'pg';

const READ_ONLY_LEADING = /^\s*(select|with)\b/i;

export type SqlResult = {
  rows: Record<string, unknown>[];
  rowCount: number;
};

export function isReadOnlyQuery(query: string): boolean {
  return READ_ONLY_LEADING.test(query);
}

// Defense in depth for the read-only escape hatch:
// 1. Leading-keyword guard: only SELECT/WITH may start the query.
// 2. Single statement: the query runs as a named prepared statement, so
//    PostgreSQL's parser rejects any multi-command string ("cannot insert
//    multiple commands into a prepared statement"). This is lexically exact —
//    it correctly distinguishes `a$tag$` (identifier) from a dollar-quote and
//    handles strings/comments/escapes that a hand-rolled scanner gets wrong.
// 3. READ ONLY transaction: blocks a single data-modifying CTE
//    (`WITH w AS (INSERT ...) SELECT ...`), which is one statement but writes.
export async function runReadOnlyQuery(
  client: pg.PoolClient | pg.Client,
  query: string,
): Promise<SqlResult> {
  if (!isReadOnlyQuery(query)) {
    throw new Error('only SELECT/WITH queries are allowed in brain sql');
  }
  const name = 'brain_sql_' + randomBytes(8).toString('hex');
  await client.query('BEGIN');
  try {
    await client.query('SET TRANSACTION READ ONLY');
    const r = await client.query({ text: query, name });
    await client.query('COMMIT');
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? r.rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query(`DEALLOCATE ${name}`).catch(() => {});
  }
}
