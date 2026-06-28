import chalk from 'chalk';
import { createBrainPool, resolveBrainUrl, withBrainClient } from '../lib/brain/connect.ts';
import { runMigrations } from '../lib/brain/migrate.ts';
import { ensureRuntimeRole, buildRuntimeUrl, RUNTIME_ROLE } from '../lib/brain/roles.ts';
import { runDoctor } from '../lib/brain/doctor.ts';
import { saveEntity } from '../lib/brain/save.ts';
import type { FactPair } from '../lib/brain-args.ts';
import { appendEvent } from '../lib/brain/event.ts';
import { createLink } from '../lib/brain/link.ts';
import { mergeEntities } from '../lib/brain/merge.ts';
import { getEntity } from '../lib/brain/get.ts';
import { createTable, listTables } from '../lib/brain/table.ts';
import { runReadOnlyQuery } from '../lib/brain/sql.ts';
import { mountFile } from '../lib/brain/mount.ts';
import { exportBrain, type ExportFormat } from '../lib/brain/export.ts';
import { importBrain } from '../lib/brain/import.ts';
import { loadConfig, setConfig, getConfigRows } from '../lib/brain/config.ts';
import { resolveEmbedder } from '../lib/brain/embed.ts';
import { query as runQuery, type QueryHit } from '../lib/brain/search.ts';
import { reindexBrain, countReindexTargets } from '../lib/brain/reindex.ts';
import { EMBED_MODEL } from '../lib/brain/config.ts';
import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';

export type BrainInitOptions = {
  json: boolean;
  silent: boolean;
  embeddings: boolean;
  adminUrl?: string;
  role?: string;
};

export type BrainDoctorOptions = {
  json: boolean;
  silent: boolean;
  adminUrl?: string;
  role?: string;
};

export async function executeBrainInit(opts: BrainInitOptions): Promise<number> {
  const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
  const roleName = opts.role ?? RUNTIME_ROLE;
  const pool = createBrainPool('admin', adminUrl);
  try {
    const migration = await runMigrations(pool);
    const role = await withBrainClient(pool, (client) => ensureRuntimeRole(client, roleName));
    const runtimeUrl = role.password ? buildRuntimeUrl(adminUrl, role.password, roleName) : null;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            applied: migration.applied,
            skipped: migration.skipped,
            roleCreated: role.created,
            embeddings: opts.embeddings,
            runtimeUrl: runtimeUrl,
          },
          null,
          2,
        ),
      );
    } else if (!opts.silent) {
      console.log('');
      console.log(chalk.bold('roster brain init'));
      console.log(`  ${chalk.green('✓')} migrations applied: ${migration.applied.length}, up-to-date: ${migration.skipped.length}`);
      console.log(`  ${chalk.green('✓')} runtime role ${role.created ? 'created' : 'already present'}`);
      if (runtimeUrl) {
        console.log('');
        console.log(chalk.yellow('  Runtime connection string (shown once — store it now):'));
        console.log(`  ${runtimeUrl}`);
      }
      console.log('');
      console.log(chalk.dim('  Semantic search embeddings are OFF (no paid API calls).'));
      console.log(chalk.dim('  Enable: roster brain config set embeddings.enabled true  (needs OPENAI_API_KEY)'));
      console.log('');
    }
    return EXIT_OK;
  } finally {
    await pool.end();
  }
}

export async function executeBrainDoctor(opts: BrainDoctorOptions): Promise<number> {
  const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
  const roleName = opts.role ?? RUNTIME_ROLE;
  const pool = createBrainPool('admin', adminUrl);
  try {
    const report = await runDoctor(pool, roleName);
    if (opts.json) {
      console.log(JSON.stringify({ ...report }, null, 2));
    } else if (!opts.silent) {
      console.log('');
      console.log(chalk.bold('roster brain doctor'));
      for (const c of report.checks) {
        const mark = c.ok ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${mark} ${c.name} — ${c.detail}`);
      }
      console.log(`  ${chalk.dim('·')} tables: ${report.tables.length === 0 ? '(none)' : report.tables.join(', ')}`);
      console.log(`  ${chalk.dim('·')} pending migrations: ${report.pending.length === 0 ? '(none)' : report.pending.join(', ')}`);
      console.log('');
      console.log(report.ok ? chalk.green('  brain healthy') : chalk.red('  brain UNHEALTHY'));
      console.log('');
    }
    return report.ok ? EXIT_OK : EXIT_ERROR;
  } finally {
    await pool.end();
  }
}

type RuntimeVerbOptions = { json: boolean; runtimeUrl?: string };

async function withRuntimePool<T>(
  opts: RuntimeVerbOptions,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const url = opts.runtimeUrl ?? resolveBrainUrl('runtime');
  const pool = createBrainPool('runtime', url);
  try {
    return await withBrainClient(pool, fn);
  } finally {
    await pool.end();
  }
}

export type BrainSaveOptions = RuntimeVerbOptions & {
  kind: string;
  slug: string;
  title?: string;
  fields: FactPair[];
  source?: string;
  confidence?: number;
  actor?: string;
};

export async function executeBrainSave(opts: BrainSaveOptions): Promise<number> {
  const result = await withRuntimePool(opts, (client) =>
    saveEntity(client, {
      kind: opts.kind,
      slug: opts.slug,
      title: opts.title,
      fields: opts.fields,
      source: opts.source,
      confidence: opts.confidence,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `${chalk.green('✓')} ${opts.kind}/${opts.slug} ${result.created ? 'created' : 'exists'}; +${result.factIds.length} fact(s)`,
    );
    if (result.created && result.create_safety === 'probable' && result.candidates.length > 0) {
      const top = result.candidates
        .slice(0, 3)
        .map((c) => `${c.kind}/${c.slug} (${c.similarity.toFixed(2)})`)
        .join(', ');
      console.log(
        `  ${chalk.yellow('⚠')} possible duplicate of: ${top} — run ${chalk.bold(`roster brain merge ${opts.slug} <into-slug>`)} if so`,
      );
    }
  }
  return EXIT_OK;
}

export type BrainMergeOptions = RuntimeVerbOptions & {
  fromSlug: string;
  intoSlug: string;
  kind?: string;
  actor?: string;
};

export async function executeBrainMerge(opts: BrainMergeOptions): Promise<number> {
  const result = await withRuntimePool(opts, (client) =>
    mergeEntities(client, {
      fromSlug: opts.fromSlug,
      intoSlug: opts.intoSlug,
      kind: opts.kind,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(
      `${chalk.green('✓')} merged ${opts.fromSlug} → ${opts.intoSlug}; canonical #${result.canonicalId}; +${result.aliasesAdded} alias(es)`,
    );
  }
  return EXIT_OK;
}

export type BrainEventOptions = RuntimeVerbOptions & {
  kind: string;
  slug?: string;
  payload: unknown;
  actor?: string;
};

export async function executeBrainEvent(opts: BrainEventOptions): Promise<number> {
  const result = await withRuntimePool(opts, (client) =>
    appendEvent(client, { kind: opts.kind, slug: opts.slug, payload: opts.payload, actor: opts.actor }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`${chalk.green('✓')} event '${opts.kind}' #${result.eventId}`);
  }
  return EXIT_OK;
}

export type BrainLinkOptions = RuntimeVerbOptions & {
  srcSlug: string;
  rel: string;
  dstSlug: string;
  kindSrc?: string;
  kindDst?: string;
  props?: unknown;
  actor?: string;
};

export async function executeBrainLink(opts: BrainLinkOptions): Promise<number> {
  const result = await withRuntimePool(opts, (client) =>
    createLink(client, {
      srcSlug: opts.srcSlug,
      rel: opts.rel,
      dstSlug: opts.dstSlug,
      kindSrc: opts.kindSrc,
      kindDst: opts.kindDst,
      props: opts.props,
      actor: opts.actor,
    }),
  );
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`${chalk.green('✓')} ${opts.srcSlug} -[${opts.rel}]-> ${opts.dstSlug} #${result.edgeId}`);
  }
  return EXIT_OK;
}

export type BrainGetOptions = RuntimeVerbOptions & { kind: string; slug: string };

export async function executeBrainGet(opts: BrainGetOptions): Promise<number> {
  const truth = await withRuntimePool(opts, (client) => getEntity(client, opts.kind, opts.slug));
  if (truth.entity === null) {
    if (opts.json) console.log(JSON.stringify({ ok: false, found: false }, null, 2));
    else console.log(chalk.yellow(`no entity ${opts.kind}/${opts.slug}`));
    return EXIT_ERROR;
  }
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...truth }, null, 2));
  } else {
    console.log(chalk.bold(`${truth.entity.kind}/${truth.entity.slug}${truth.entity.title ? ` — ${truth.entity.title}` : ''}`));
    for (const f of truth.facts) {
      const attrib = f.actor || f.source ? chalk.dim(` (${[f.source, f.actor].filter(Boolean).join('/')})`) : '';
      console.log(`  ${f.key} = ${JSON.stringify(f.value)}${attrib}`);
    }
    for (const ev of truth.events) console.log(`  ${chalk.dim('event')} ${ev.kind}`);
    for (const ed of truth.edges) {
      const arrow = ed.direction === 'out' ? '->' : '<-';
      console.log(`  ${chalk.dim('edge')} ${arrow} ${ed.rel} ${ed.other_kind}/${ed.other_slug}`);
    }
  }
  return EXIT_OK;
}

export type BrainTableOptions =
  | (RuntimeVerbOptions & { op: 'create'; name: string; columns: { name: string; type: string }[] })
  | (RuntimeVerbOptions & { op: 'list' });

export async function executeBrainTable(opts: BrainTableOptions): Promise<number> {
  if (opts.op === 'create') {
    await withRuntimePool(opts, (client) => createTable(client, opts.name, opts.columns));
    if (opts.json) console.log(JSON.stringify({ ok: true, created: opts.name }, null, 2));
    else console.log(`${chalk.green('✓')} table brain.${opts.name} created`);
    return EXIT_OK;
  }
  const tables = await withRuntimePool(opts, (client) => listTables(client));
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, tables }, null, 2));
  } else if (tables.length === 0) {
    console.log(chalk.dim('(no user tables)'));
  } else {
    for (const t of tables) {
      console.log(`${chalk.bold(t.name)}: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`);
    }
  }
  return EXIT_OK;
}

export type BrainMountOptions = RuntimeVerbOptions & { file: string };

export async function executeBrainMount(opts: BrainMountOptions): Promise<number> {
  const result = await withRuntimePool(opts, async (client) => {
    const cfg = await loadConfig(client);
    const embedder = resolveEmbedder(cfg);
    return mountFile(client, opts.file, embedder);
  });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (result.mounted) {
    const emb = result.embedded ? ', embedded' : '';
    console.log(`${chalk.green('✓')} mounted ${result.sourcePath} (+${result.chunks} chunk(s)${emb})`);
  } else {
    console.log(`${chalk.dim('·')} ${result.sourcePath} unchanged — no new chunks`);
  }
  return EXIT_OK;
}

export type BrainQueryOptions = RuntimeVerbOptions & { text: string; kind?: string; limit?: number };

export async function executeBrainQuery(opts: BrainQueryOptions): Promise<number> {
  const hits = await withRuntimePool(opts, async (client) => {
    const cfg = await loadConfig(client);
    const embedder = resolveEmbedder(cfg);
    return runQuery(client, opts.text, { kind: opts.kind, limit: opts.limit }, embedder, cfg);
  });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, hits }, null, 2));
  } else if (hits.length === 0) {
    console.log(chalk.dim('no hits'));
  } else {
    for (const h of hits) console.log(formatHit(h));
  }
  return EXIT_OK;
}

function formatHit(h: QueryHit): string {
  const score = h.score.toFixed(4);
  if (h.type === 'document') {
    return `${chalk.dim(score)} ${chalk.bold('doc')} ${h.source_path}#${h.chunk_index} — ${h.snippet}`;
  }
  const via = h.via === 'graph' ? chalk.dim(' (graph)') : '';
  return `${chalk.dim(score)} ${chalk.bold('ent')} ${h.kind}/${h.slug}${h.title ? ` — ${h.title}` : ''}${via}`;
}

export type BrainReindexOptions = {
  json: boolean;
  since?: string;
  model?: string;
  yes: boolean;
  adminUrl?: string;
};

export async function executeBrainReindex(opts: BrainReindexOptions): Promise<number> {
  if (opts.model !== undefined && opts.model !== EMBED_MODEL && opts.model !== `openai:${EMBED_MODEL}`) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} unsupported --model ${chalk.yellow(opts.model)}`,
      body: `  Only 'openai:${EMBED_MODEL}' is supported today.`,
      remedy: `  Drop --model (uses the configured model) or pass openai:${EMBED_MODEL}.`,
      exitCode: EXIT_ERROR,
    });
  }
  const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
  const pool = createBrainPool('admin', adminUrl);
  try {
    const cfg = await withBrainClient(pool, (c) => loadConfig(c));
    const embedder = resolveEmbedder(cfg);
    if (!embedder) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} embeddings are not enabled`,
        body: '  reindex needs embeddings on + an API key (OPENAI_API_KEY in the environment).',
        remedy: '  Enable with: roster brain config set embeddings.enabled true',
        exitCode: EXIT_ERROR,
      });
    }
    const targeted = await withBrainClient(pool, (c) => countReindexTargets(c, embedder.model, opts.since));
    if (targeted === 0) {
      if (opts.json) console.log(JSON.stringify({ ok: true, targeted: 0, embedded: 0, remaining: 0 }, null, 2));
      else console.log(`${chalk.green('✓')} nothing to reindex — all active chunks are embedded`);
      return EXIT_OK;
    }
    // Bulk-cost guard: a single reindex can embed a whole corpus. Never spend
    // without an explicit --yes; without it, preview the count and stop.
    if (!opts.yes) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, targeted, embedded: 0, remaining: targeted, pending_confirmation: true }, null, 2));
      } else {
        console.log(`${chalk.yellow('⚠')} ${targeted} active chunk(s) need embedding — that's ${targeted} paid embedding call(s).`);
        console.log(`  Re-run with ${chalk.bold('--yes')} to proceed.`);
      }
      return EXIT_OK;
    }
    const result = await reindexBrain(pool, embedder, { since: opts.since }, (done, total) => {
      if (!opts.json) process.stderr.write(`\r  embedding ${done}/${total}…`);
    });
    if (!opts.json) process.stderr.write('\n');
    if (opts.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    else console.log(`${chalk.green('✓')} reindexed ${result.embedded} chunk(s); ${result.remaining} remaining`);
    return EXIT_OK;
  } finally {
    await pool.end();
  }
}

export type BrainConfigOptions =
  | (RuntimeVerbOptions & { op: 'get'; key?: string })
  | { json: boolean; op: 'set'; key: string; value: string; adminUrl?: string };

export async function executeBrainConfig(opts: BrainConfigOptions): Promise<number> {
  if (opts.op === 'set') {
    const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
    const pool = createBrainPool('admin', adminUrl);
    try {
      const res = await withBrainClient(pool, (client) => setConfig(client, opts.key, opts.value));
      if (opts.json) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      else console.log(`${chalk.green('✓')} ${res.key} = ${JSON.stringify(res.value)}`);
      return EXIT_OK;
    } finally {
      await pool.end();
    }
  }
  const rows = await withRuntimePool(opts, (client) => getConfigRows(client));
  const filtered = opts.key === undefined ? rows : rows.filter((r) => r.key === opts.key);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, config: filtered }, null, 2));
  } else if (filtered.length === 0) {
    console.log(chalk.dim(opts.key ? `${opts.key} unset (using default)` : '(no overrides set; using defaults)'));
  } else {
    for (const r of filtered) console.log(`${r.key} = ${JSON.stringify(r.value)}`);
  }
  return EXIT_OK;
}

export type BrainSqlOptions = RuntimeVerbOptions & { query: string };

export async function executeBrainSql(opts: BrainSqlOptions): Promise<number> {
  const result = await withRuntimePool(opts, (client) => runReadOnlyQuery(client, opts.query));
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, rowCount: result.rowCount, rows: result.rows }, null, 2));
  } else {
    console.log(JSON.stringify(result.rows, null, 2));
  }
  return EXIT_OK;
}

export type BrainExportOptions = {
  json: boolean;
  outDir?: string;
  format: ExportFormat;
  adminUrl?: string;
};

export async function executeBrainExport(opts: BrainExportOptions): Promise<number> {
  const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
  const pool = createBrainPool('admin', adminUrl);
  try {
    const exportedAt = new Date().toISOString();
    const outDir = opts.outDir ?? `./brain-export-${exportedAt.replace(/[:.]/g, '-')}`;
    const result = await exportBrain(pool, { outDir, format: opts.format, exportedAt });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      console.log(
        `${chalk.green('✓')} exported ${result.totalRows} row(s) across ${result.tables.length} table(s) → ${result.outDir} (${result.format})`,
      );
    }
    return EXIT_OK;
  } finally {
    await pool.end();
  }
}

export type BrainImportOptions = {
  json: boolean;
  dir: string;
  adminUrl?: string;
};

export async function executeBrainImport(opts: BrainImportOptions): Promise<number> {
  const adminUrl = opts.adminUrl ?? resolveBrainUrl('admin');
  const pool = createBrainPool('admin', adminUrl);
  try {
    const result = await importBrain(pool, opts.dir);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } else {
      console.log(
        `${chalk.green('✓')} restored ${result.totalRows} row(s) across ${result.tables.length} table(s) (${result.format})`,
      );
    }
    return EXIT_OK;
  } finally {
    await pool.end();
  }
}
