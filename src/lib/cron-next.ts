import { validateCronExpression } from './schedule-schema.ts';
import { RosterError, EXIT_ERROR } from './errors.ts';
import chalk from 'chalk';

// Brute-force minute-stepping next-fire finder for cron expressions.
// UTC only. Caller's local timezone is intentionally NOT considered — the
// crontab daemon owns timezone for via-cron schedules, and Desktop Scheduled
// Tasks / Codex Automations own it for UI-handoff schedules. ROS-42 may add
// an optional timezone parameter for end-user display; this PR keeps it
// scope-bounded.

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

type FieldMask = ReadonlySet<number>;

// Cron daemons honor day-of-week 0 OR 7 for Sunday. Normalize 7 → 0.
function normalizeDow(dow: number): number {
  return dow === 7 ? 0 : dow;
}

function expandField(
  field: string,
  min: number,
  max: number,
  fieldName: (typeof FIELD_NAMES)[number],
): FieldMask {
  const out = new Set<number>();
  const atoms = field.split(',');
  for (const atom of atoms) {
    let stepStr: string | undefined;
    let base = atom;
    const slashIdx = atom.indexOf('/');
    if (slashIdx >= 0) {
      base = atom.slice(0, slashIdx);
      stepStr = atom.slice(slashIdx + 1);
    }
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid step in ${fieldName} field: '${atom}'`);
    }

    let rangeStart: number;
    let rangeEnd: number;
    if (base === '*') {
      rangeStart = min;
      rangeEnd = max;
    } else if (base.includes('-')) {
      const [aStr, bStr] = base.split('-') as [string, string];
      rangeStart = Number(aStr);
      rangeEnd = Number(bStr);
      if (
        !Number.isInteger(rangeStart) ||
        !Number.isInteger(rangeEnd) ||
        rangeStart < min ||
        rangeEnd > max ||
        rangeStart > rangeEnd
      ) {
        throw new Error(`invalid range in ${fieldName} field: '${atom}'`);
      }
    } else {
      const n = Number(base);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`invalid value in ${fieldName} field: '${atom}'`);
      }
      rangeStart = n;
      rangeEnd = n;
    }

    for (let v = rangeStart; v <= rangeEnd; v += step) {
      out.add(fieldName === 'day-of-week' ? normalizeDow(v) : v);
    }
  }
  return out;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

type CronMasks = {
  minute: FieldMask;
  hour: FieldMask;
  dom: FieldMask;
  month: FieldMask;
  dow: FieldMask;
  // Vixie/POSIX cron semantics: when BOTH dom and dow are restricted (not *),
  // fire if EITHER matches. When one is *, AND-match.
  domRestricted: boolean;
  dowRestricted: boolean;
};

function parseCron(expr: string): CronMasks {
  const trimmed = expr.trim();
  const resolved = trimmed.startsWith('@') ? (ALIASES[trimmed] ?? '') : trimmed;
  if (resolved.length === 0) {
    throw new Error(`unsupported alias '${trimmed}'`);
  }
  const fields = resolved.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5 fields, got ${fields.length}`);
  }
  const [minF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  return {
    minute: expandField(minF, 0, 59, 'minute'),
    hour: expandField(hourF, 0, 23, 'hour'),
    dom: expandField(domF, 1, 31, 'day-of-month'),
    month: expandField(monthF, 1, 12, 'month'),
    dow: expandField(dowF, 0, 7, 'day-of-week'),
    // Vixie cron: a dom/dow field is "restricted" iff it does NOT start with
    // `*`. So `*/2`, `*/5`, and bare `*` are unrestricted; `5`, `1-5`, `1,15`
    // are restricted. Both restricted → OR; either unrestricted → AND.
    // Codex review finding #2 (ROS-36): previous `!== '*'` treated `*/2` as
    // restricted, producing wrong matches for expressions like `0 0 */2 * 1`.
    domRestricted: !domF.startsWith('*'),
    dowRestricted: !dowF.startsWith('*'),
  };
}

function matches(d: Date, m: CronMasks): boolean {
  if (!m.minute.has(d.getUTCMinutes())) return false;
  if (!m.hour.has(d.getUTCHours())) return false;
  if (!m.month.has(d.getUTCMonth() + 1)) return false;

  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  const domHit = m.dom.has(dom);
  const dowHit = m.dow.has(dow);
  // Vixie semantics: BOTH restricted → OR; otherwise AND.
  // When dom or dow is starred (unrestricted), the expanded mask covers every
  // possible value so the AND-side hit is trivially true and falls through.
  if (m.domRestricted && m.dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

const MAX_STEPS = 366 * 24 * 60; // 366 days of minutes

export type NextFireResult =
  | { ok: true; next: Date }
  | { ok: false; reason: string };

export function nextFireTime(cronExpr: string, fromUtc: Date): NextFireResult {
  const validation = validateCronExpression(cronExpr);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  let masks: CronMasks;
  try {
    masks = parseCron(cronExpr);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  // Step to the start of the next minute (cron fires at minute boundaries;
  // never re-fire at the exact same minute we were called from).
  const start = new Date(
    Date.UTC(
      fromUtc.getUTCFullYear(),
      fromUtc.getUTCMonth(),
      fromUtc.getUTCDate(),
      fromUtc.getUTCHours(),
      fromUtc.getUTCMinutes(),
      0,
      0,
    ),
  );
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const candidate = new Date(start.getTime());
  for (let i = 0; i < MAX_STEPS; i++) {
    if (matches(candidate, masks)) return { ok: true, next: new Date(candidate.getTime()) };
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return {
    ok: false,
    reason: `no fire within 366 days starting at ${fromUtc.toISOString()}`,
  };
}

export function nextFireOrThrow(cronExpr: string, fromUtc: Date): Date {
  const r = nextFireTime(cronExpr, fromUtc);
  if (!r.ok) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot compute next fire time`,
      body: `  cron='${cronExpr}': ${r.reason}`,
      remedy: `  Verify the cron expression with ${chalk.bold('roster schedule validate')}.`,
      exitCode: EXIT_ERROR,
    });
  }
  return r.next;
}
