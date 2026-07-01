import { z } from 'zod';
import { flattenZodErrors, type FieldError } from '../schedule-schema.ts';

export const TRACKER_YAML_VERSION = 1;

const statusMapSchema = z
  .object({
    ready: z.string().min(1, { message: 'status_map.ready: required' }),
    active: z.string().min(1, { message: 'status_map.active: required' }),
    done: z.string().min(1, { message: 'status_map.done: required' }),
    backlog: z.string().min(1).optional(),
    claimed: z.string().min(1).optional(),
    blocked: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
    cancelled: z.string().min(1).optional(),
  })
  .strict();

export const trackerConfigSchema = z
  .object({
    version: z
      .number()
      .int()
      .refine((n) => n === TRACKER_YAML_VERSION, { message: `version: unsupported (expected ${TRACKER_YAML_VERSION})` }),
    tracker: z.enum(['notion']),
    data_source_id: z.string().min(1, { message: 'data_source_id: required' }),
    status_property: z.string().min(1, { message: 'status_property: required' }),
    assignee_property: z.string().min(1, { message: 'assignee_property: required' }),
    unique_id_property: z.string().min(1).optional(),
    project_property: z.string().min(1).optional(),
    project_filter: z.array(z.string().min(1)).optional(),
    status_map: statusMapSchema,
  })
  .strict();

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;

export class TrackerConfigError extends Error {
  readonly issues: FieldError[];
  constructor(issues: FieldError[]) {
    super('tracker.yaml is invalid:\n' + issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'));
    this.name = 'TrackerConfigError';
    this.issues = issues;
  }
}

export function parseTrackerConfig(raw: unknown): TrackerConfig {
  const result = trackerConfigSchema.safeParse(raw);
  if (!result.success) throw new TrackerConfigError(flattenZodErrors(result.error));
  return result.data;
}

// Validate a (possibly partial) status map against the board: every mapped name
// must be a real board status option, and no board status may back two canonical
// states. Accepts the raw map so a preview can validate before every required
// state is filled.
export function crossCheckStatusMap(
  statusMap: Record<string, string | undefined>,
  boardStatusNames: readonly string[],
): void {
  const known = new Set(boardStatusNames);
  const issues: FieldError[] = [];
  const statesByStatus = new Map<string, string[]>();
  for (const [state, name] of Object.entries(statusMap)) {
    if (!name) continue;
    if (!known.has(name)) {
      issues.push({
        path: `status_map.${state}`,
        message: `"${name}" is not a status option on the board (have: ${boardStatusNames.join(', ') || 'none'})`,
      });
    }
    const arr = statesByStatus.get(name) ?? [];
    arr.push(state);
    statesByStatus.set(name, arr);
  }
  for (const [name, states] of statesByStatus) {
    if (states.length > 1) {
      issues.push({
        path: `status_map.${states.join('+')}`,
        message: `status "${name}" is mapped to multiple canonical states (${states.join(', ')}) — each needs a distinct status`,
      });
    }
  }
  if (issues.length > 0) throw new TrackerConfigError(issues);
}
