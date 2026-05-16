import { z } from 'zod';

export const SCHEDULES_YAML_VERSION = 1;

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CRON_ALIASES = new Set(['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually']);

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day-of-week (0 and 7 both = Sunday)
] as const;

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

function validateCronAtom(atom: string, range: { min: number; max: number }): boolean {
  if (atom === '*') return true;

  if (atom.includes('/')) {
    const parts = atom.split('/');
    if (parts.length !== 2) return false;
    const [base, stepStr] = parts;
    if (!base || !stepStr) return false;
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) return false;
    if (base === '*') return true;
    return validateCronAtom(base, range);
  }

  if (atom.includes('-')) {
    const parts = atom.split('-');
    if (parts.length !== 2) return false;
    const [aStr, bStr] = parts;
    if (!aStr || !bStr) return false;
    const a = Number(aStr);
    const b = Number(bStr);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a < range.min || b > range.max || a > b) return false;
    return true;
  }

  if (atom.length === 0) return false;
  const n = Number(atom);
  if (!Number.isInteger(n)) return false;
  return n >= range.min && n <= range.max;
}

function validateCronField(field: string, range: { min: number; max: number }): boolean {
  if (field.length === 0) return false;
  // list: A,B,C
  const atoms = field.split(',');
  return atoms.every((atom) => validateCronAtom(atom, range));
}

export type CronValidationResult = { ok: true } | { ok: false; reason: string };

export function validateCronExpression(expr: string): CronValidationResult {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty cron expression' };

  if (trimmed.startsWith('@')) {
    if (CRON_ALIASES.has(trimmed)) return { ok: true };
    return { ok: false, reason: `unsupported alias '${trimmed}' (allowed: @hourly @daily @weekly @monthly @yearly @annually)` };
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, reason: `expected 5 space-separated fields, got ${fields.length}` };
  }

  for (let i = 0; i < 5; i++) {
    const field = fields[i]!;
    const range = FIELD_RANGES[i]!;
    if (!validateCronField(field, range)) {
      return {
        ok: false,
        reason: `${FIELD_NAMES[i]} field '${field}' is invalid (range ${range.min}-${range.max})`,
      };
    }
  }
  return { ok: true };
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const kebabString = (label: string) =>
  z
    .string()
    .min(1, { message: `${label}: required` })
    .refine((s) => KEBAB_RE.test(s), { message: `${label}: must be kebab-case (lowercase letters, digits, hyphens)` });

const cronString = z
  .string()
  .min(1, { message: 'cron: required' })
  .superRefine((expr, ctx) => {
    const result = validateCronExpression(expr);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cron: '${expr}' is not a valid cron expression (${result.reason})`,
      });
    }
  });

const timezoneString = z
  .string()
  .min(1)
  .refine(isValidIanaTimezone, { message: 'timezone: not a valid IANA timezone' });

const retryPolicySchema = z
  .object({
    max_attempts: z
      .number()
      .int({ message: 'retry_policy.max_attempts: must be an integer' })
      .min(1, { message: 'retry_policy.max_attempts: must be ≥ 1' })
      .max(5, { message: 'retry_policy.max_attempts: must be ≤ 5' }),
    backoff_seconds: z
      .number()
      .int({ message: 'retry_policy.backoff_seconds: must be an integer' })
      .min(0, { message: 'retry_policy.backoff_seconds: must be ≥ 0' })
      .max(3600, { message: 'retry_policy.backoff_seconds: must be ≤ 3600' }),
  })
  .strict();

export const TOOL_VALUES = ['claude', 'codex'] as const;
export const INSTALL_MODE_VALUES = ['ui-handoff', 'via-cron'] as const;

export const scheduleEntrySchema = z
  .object({
    name: kebabString('name'),
    agent: kebabString('agent'),
    plan: kebabString('plan'),
    cron: cronString,
    tool: z.enum(TOOL_VALUES, {
      error: (issue) => {
        const base = `tool: must be one of ${TOOL_VALUES.map((v) => `'${v}'`).join(' | ')}`;
        return issue.code === 'invalid_value' ? `${base} (got '${String(issue.input)}')` : base;
      },
    }),
    install_mode: z.enum(INSTALL_MODE_VALUES, {
      error: (issue) => {
        const base = `install_mode: must be one of ${INSTALL_MODE_VALUES.map((v) => `'${v}'`).join(' | ')}`;
        return issue.code === 'invalid_value' ? `${base} (got '${String(issue.input)}')` : base;
      },
    }),
    timezone: timezoneString.optional(),
    max_duration_minutes: z
      .number()
      .int({ message: 'max_duration_minutes: must be an integer' })
      .min(1, { message: 'max_duration_minutes: must be ≥ 1' })
      .max(1440, { message: 'max_duration_minutes: must be ≤ 1440' })
      .optional(),
    hitl_routing: z
      .string()
      .min(1)
      .refine((p) => p.startsWith('roster/'), {
        message: 'hitl_routing: must be a path under roster/',
      })
      .optional(),
    retry_policy: retryPolicySchema.optional(),
  })
  .strict();

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type ToolValue = (typeof TOOL_VALUES)[number];
export type InstallModeValue = (typeof INSTALL_MODE_VALUES)[number];

export const scheduleFileSchema = z
  .object({
    version: z
      .number()
      .int({ message: 'version: must be an integer' })
      .refine((n) => n === SCHEDULES_YAML_VERSION, {
        message: `version: unsupported schema version (expected ${SCHEDULES_YAML_VERSION})`,
      }),
    schedules: z.array(scheduleEntrySchema),
  })
  .strict();

export type ScheduleFile = z.infer<typeof scheduleFileSchema>;

export type FieldError = {
  path: string;
  message: string;
};

export function flattenZodErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((e) => ({
    path: e.path.length === 0 ? '<root>' : e.path.map((p) => String(p)).join('.'),
    message: e.message,
  }));
}

export function findDuplicateNames(entries: ReadonlyArray<{ name: string }>): FieldError[] {
  const seen = new Map<string, number>();
  const errors: FieldError[] = [];
  entries.forEach((entry, i) => {
    const first = seen.get(entry.name);
    if (first !== undefined) {
      errors.push({
        path: `schedules.${i}.name`,
        message: `name: duplicate of entry ${first} ('${entry.name}')`,
      });
    } else {
      seen.set(entry.name, i);
    }
  });
  return errors;
}
