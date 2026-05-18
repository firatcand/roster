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

// Project slugs match kebab plus the scaffold template convention `_demo` /
// `_template` — a leading underscore is allowed for projects only.
const PROJECT_SLUG_RE = /^_?[a-z0-9]+(-[a-z0-9]+)*$/;
const projectString = (label: string) =>
  z
    .string()
    .min(1, { message: `${label}: required` })
    .refine((s) => PROJECT_SLUG_RE.test(s), {
      message: `${label}: must be kebab-case (optionally prefixed with '_' for scaffold templates)`,
    });

const cronString = z
  .string()
  .min(1, { message: 'cron: required' })
  .transform((s) => s.trim())
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
export const INSTALL_STATUS_VALUES = ['pending-ui-install', 'installed'] as const;

const subscriptionAttestationSchema = z
  .object({
    auth_mode: z.literal('chatgpt'),
    env_policy: z.literal('cleared'),
    codex_home: z.string().min(1, { message: 'subscription_attestation.codex_home: required' }),
  })
  .strict();

export type SubscriptionAttestation = z.infer<typeof subscriptionAttestationSchema>;

export const scheduleEntrySchema = z
  .object({
    name: kebabString('name'),
    agent: kebabString('agent'),
    plan: kebabString('plan'),
    project: projectString('project'),
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
    status: z.enum(INSTALL_STATUS_VALUES, {
      error: (issue) => {
        const base = `status: must be one of ${INSTALL_STATUS_VALUES.map((v) => `'${v}'`).join(' | ')}`;
        return issue.code === 'invalid_value' ? `${base} (got '${String(issue.input)}')` : base;
      },
    }),
    subscription_attestation: subscriptionAttestationSchema.optional(),
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
    // ROS-42: opt-in `codex exec --json` event capture. When true, the cron
    // wrapper rendered by codex-install passes --json to codex and redirects
    // stdout to `logs/cron/<name>.events.jsonl`. Without this flag, codex's
    // human-readable stdout/stderr both land in `<name>.log` (legacy behavior).
    // codex-only — Claude UI-handoff schedules cannot capture events because
    // Claude Desktop owns the fire.
    capture_events: z.boolean().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // ROS-35 codex review: attestation required when tool=codex, forbidden when tool=claude.
    // Optional-everywhere left a hole where a codex entry without attestation would
    // validate clean.
    if (entry.tool === 'codex' && entry.subscription_attestation === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subscription_attestation'],
        message: 'subscription_attestation: required when tool=codex',
      });
    }
    if (entry.tool === 'claude' && entry.subscription_attestation !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['subscription_attestation'],
        message: 'subscription_attestation: forbidden when tool=claude (codex-only field)',
      });
    }
    // ROS-42: capture_events is codex-only (Claude UI-handoff has no wrapper).
    if (entry.tool === 'claude' && entry.capture_events === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['capture_events'],
        message: 'capture_events: forbidden when tool=claude (codex-only field; Claude Desktop owns the fire)',
      });
    }
    // ROS-42 codex review impl-pass: capture_events also requires
    // install_mode=via-cron — ui-handoff routes through the desktop app and
    // there's no wrapper to redirect stdout to events.jsonl. Accepting it
    // silently writes a misleading schedules.yaml entry.
    if (entry.tool === 'codex' && entry.install_mode === 'ui-handoff' && entry.capture_events === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['capture_events'],
        message: 'capture_events: requires install_mode=via-cron (ui-handoff routes through the Codex app; no wrapper to redirect stdout)',
      });
    }
  });

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type ToolValue = (typeof TOOL_VALUES)[number];
export type InstallModeValue = (typeof INSTALL_MODE_VALUES)[number];
export type InstallStatusValue = (typeof INSTALL_STATUS_VALUES)[number];

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
