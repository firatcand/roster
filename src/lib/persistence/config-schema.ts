import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import chalk from 'chalk';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { flattenZodErrors } from '../schedule-schema.ts';

export const PERSISTENCE_YAML_VERSION = 1;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

// S3 bucket naming: 3-63 chars, lowercase alnum + dot/hyphen, alnum at both
// ends. (Deliberately not enforcing the stricter IP-form and adjacent-dot
// rules — invalid names surface as a clear S3 error.)
const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const versionField = z
  .number({ message: 'must be the integer 1' })
  .int({ message: 'must be an integer' })
  .refine((n) => n === PERSISTENCE_YAML_VERSION, {
    message: `unsupported schema version (expected ${PERSISTENCE_YAML_VERSION})`,
  });

const workspaceSchema = z
  .object({
    id: z.string({ message: 'required' }).refine(isUuidV4, { message: 'must be a UUID v4' }),
    name: z.string({ message: 'required' }).min(1, { message: 'required' }),
  })
  .strict();

const endpointString = z.string().superRefine((raw, ctx) => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be an http(s) URL' });
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: `must be an http(s) URL (got '${u.protocol}//')` });
  }
  // persistence.yaml is credential-free by construction; reject a URL that
  // smuggles user:pass@host so nothing secret can be committed here.
  if (u.username !== '' || u.password !== '') {
    ctx.addIssue({
      code: 'custom',
      message: 'must not contain credentials (user:pass@) — object-store credentials are env-only',
    });
  }
});

const objectsSchema = z
  .object({
    bucket: z
      .string({ message: 'required' })
      .refine((s) => S3_BUCKET_RE.test(s), {
        message: 'must be a valid S3 bucket name (3-63 chars: lowercase letters, digits, dots, hyphens)',
      }),
    region: z
      .string()
      .regex(/^[a-z0-9-]+$/, { message: 'must be a region token (e.g. us-east-1, auto)' })
      .nullable()
      .default(null),
    endpoint: endpointString.nullable().default(null),
    force_path_style: z.boolean({ message: 'must be true|false' }).default(false),
  })
  .strict();

const localConfigSchema = z
  .object({
    version: versionField,
    workspace: workspaceSchema,
    backend: z.literal('local'),
  })
  .strict();

const postgresS3ConfigSchema = z
  .object({
    version: versionField,
    workspace: workspaceSchema,
    backend: z.literal('postgres-s3'),
    postgres: z
      .object({
        database: z.enum(['brain', 'dedicated'], { message: "must be 'brain' | 'dedicated'" }),
      })
      .strict(),
    objects: objectsSchema,
  })
  .strict();

export const persistenceConfigSchema = z.discriminatedUnion('backend', [
  localConfigSchema,
  postgresS3ConfigSchema,
]);

export type PersistenceWorkspace = z.infer<typeof workspaceSchema>;
export type LocalPersistenceConfig = z.infer<typeof localConfigSchema>;
export type PostgresS3PersistenceConfig = z.infer<typeof postgresS3ConfigSchema>;
export type PersistenceConfig = z.infer<typeof persistenceConfigSchema>;

export type PersistenceBootstrapState = 'legacy-implicit' | 'configured-local' | 'postgres-s3';

// The three bootstrap states of section A, distinguishable by callers:
// - legacy-implicit: no persistence.yaml; everything behaves as today.
// - configured-local: file present with backend local; ledger active.
// - postgres-s3: file present with backend postgres-s3 (env URLs resolved later).
export type LoadedPersistence =
  | { state: 'legacy-implicit'; backend: 'local'; legacy: true; config: null }
  | { state: 'configured-local'; backend: 'local'; legacy: false; config: LocalPersistenceConfig }
  | { state: 'postgres-s3'; backend: 'postgres-s3'; legacy: false; config: PostgresS3PersistenceConfig };

export function persistenceConfigPath(cwd: string): string {
  return join(cwd, 'roster', 'persistence.yaml');
}

function configError(path: string, issues: ReadonlyArray<string>): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} invalid persistence config`,
    body: [`  ${path}`, ...issues.map((i) => `    ${i}`)].join('\n'),
    remedy: '  Fix the field(s) above in roster/persistence.yaml and re-run.',
    exitCode: EXIT_ERROR,
  });
}

function futureVersionError(path: string, version: number): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} persistence.yaml was written by a newer roster`,
    body: [
      `  ${path}`,
      `    version: ${version} (this CLI supports up to version ${PERSISTENCE_YAML_VERSION})`,
    ].join('\n'),
    remedy: `  Upgrade the CLI: ${chalk.bold('npm install -g @firatcand/roster@latest')}`,
    exitCode: EXIT_ERROR,
  });
}

export function loadPersistenceConfig(cwd: string): LoadedPersistence {
  const path = persistenceConfigPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'legacy-implicit', backend: 'local', legacy: true, config: null };
    }
    throw configError(path, [`unreadable: ${(err as Error).message}`]);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw configError(path, [`not valid YAML: ${(err as Error).message}`]);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError(path, ['must be a YAML mapping with version, workspace, backend']);
  }
  const versionRaw = (parsed as Record<string, unknown>).version;
  // Future version is checked BEFORE full schema validation (and before any
  // backend I/O): a newer file may legitimately carry fields this CLI does not
  // know, and the remedy is "upgrade roster", not a field-by-field complaint.
  if (typeof versionRaw === 'number' && Number.isInteger(versionRaw) && versionRaw > PERSISTENCE_YAML_VERSION) {
    throw futureVersionError(path, versionRaw);
  }
  const result = persistenceConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw configError(
      path,
      flattenZodErrors(result.error).map((i) => `${i.path}: ${i.message}`),
    );
  }
  const config = result.data;
  if (config.backend === 'local') {
    return { state: 'configured-local', backend: 'local', legacy: false, config };
  }
  return { state: 'postgres-s3', backend: 'postgres-s3', legacy: false, config };
}
