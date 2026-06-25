import chalk from 'chalk';
import { createBrainPool, resolveBrainUrl, withBrainClient } from '../lib/brain/connect.ts';
import { runMigrations } from '../lib/brain/migrate.ts';
import { ensureRuntimeRole, buildRuntimeUrl, RUNTIME_ROLE } from '../lib/brain/roles.ts';
import { runDoctor } from '../lib/brain/doctor.ts';
import { EXIT_OK, EXIT_ERROR } from '../lib/errors.ts';

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
