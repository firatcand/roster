import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import chalk from 'chalk';
import { ROSTER_ROOT } from './paths.ts';
import { RosterError, EXIT_ERROR } from './errors.ts';
import { TOOL_VALUES } from './schedule-schema.ts';

const PLAN_CEILINGS_VERSION = 1;

const planCeilingSchema = z
  .object({
    tool: z.enum(TOOL_VALUES),
    label: z.string().min(1),
    msgs_per_window: z.number().int().min(1),
    window_hours: z.number().int().min(1).max(168),
    msgs_per_week: z.number().int().min(1),
    source_url: z.string().url(),
    as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'as_of: must be YYYY-MM-DD'),
  })
  .strict();

const planCeilingsFileSchema = z
  .object({
    version: z.literal(PLAN_CEILINGS_VERSION),
    plans: z.record(z.string().min(1), planCeilingSchema),
  })
  .strict();

export type PlanCeiling = z.infer<typeof planCeilingSchema> & { id: string };
export type PlanCeilings = ReadonlyArray<PlanCeiling>;

const DEFAULT_PATH = resolve(ROSTER_ROOT, 'data', 'plan-ceilings.yaml');

export function loadPlanCeilings(path: string = DEFAULT_PATH): PlanCeilings {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot read plan-ceilings file`,
      body: `  path: ${path}\n  reason: ${e.code ?? e.message}`,
      remedy: `  Restore ${chalk.bold('data/plan-ceilings.yaml')} from the repo or reinstall roster.`,
      exitCode: EXIT_ERROR,
    });
  }

  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} plan-ceilings YAML is malformed`,
      body: `  path: ${path}\n  reason: ${doc.errors[0]!.message}`,
      remedy: `  Restore ${chalk.bold('data/plan-ceilings.yaml')} from the repo.`,
      exitCode: EXIT_ERROR,
    });
  }

  const parsed = planCeilingsFileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const first = parsed.error.issues[0]!;
    const fieldPath = first.path.length === 0 ? '<root>' : first.path.map(String).join('.');
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} plan-ceilings YAML failed validation`,
      body: `  path: ${path}\n  ${fieldPath}: ${first.message}`,
      remedy: `  Edit the file or restore from the repo.`,
      exitCode: EXIT_ERROR,
    });
  }

  return Object.entries(parsed.data.plans)
    .map(([id, ceiling]) => ({ id, ...ceiling }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
