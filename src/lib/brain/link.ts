import type pg from 'pg';

export type LinkInput = {
  srcSlug: string;
  rel: string;
  dstSlug: string;
  kindSrc?: string;
  kindDst?: string;
  props?: unknown;
  actor?: string;
};

export type LinkResult = {
  edgeId: string;
  srcId: string;
  dstId: string;
};

async function resolveBySlug(
  client: pg.PoolClient | pg.Client,
  slug: string,
  kind?: string,
): Promise<string> {
  const params: unknown[] = [slug];
  let where = `slug = $1`;
  if (kind !== undefined) {
    where += ` AND kind = $2`;
    params.push(kind);
  }
  const r = await client.query<{ id: string }>(
    `SELECT id FROM brain.entities WHERE ${where}`,
    params,
  );
  if (r.rowCount === 0) throw new Error(`entity '${slug}' not found`);
  if ((r.rowCount ?? 0) > 1) throw new Error(`slug '${slug}' is ambiguous; pass a kind`);
  return r.rows[0]!.id;
}

export async function createLink(
  client: pg.PoolClient | pg.Client,
  input: LinkInput,
): Promise<LinkResult> {
  const srcId = await resolveBySlug(client, input.srcSlug, input.kindSrc);
  const dstId = await resolveBySlug(client, input.dstSlug, input.kindDst);
  const r = await client.query<{ id: string }>(
    `INSERT INTO brain.edges (src_id, dst_id, rel, props, actor)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
    [srcId, dstId, input.rel, JSON.stringify(input.props ?? null), input.actor ?? null],
  );
  return { edgeId: r.rows[0]!.id, srcId, dstId };
}
