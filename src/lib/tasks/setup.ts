import { join } from 'node:path';
import YAML from 'yaml';
import chalk from 'chalk';
import { atomicWriteFile } from '../schedule-yaml.ts';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { NotionAdapter } from './adapters/notion.ts';
import type { StatusOption } from './adapters/types.ts';
import type { CanonicalState } from './machine.ts';
import {
  crossCheckStatusMap,
  parseTrackerConfig,
  TrackerConfigError,
  TRACKER_YAML_VERSION,
  type TrackerConfig,
} from './tracker-schema.ts';

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface Heuristic {
  state: CanonicalState;
  required: boolean;
  patterns: RegExp[];
}

// Required states are listed first so they claim their best match before the
// optional states — combined with the used-name set below this guarantees no
// two canonical states resolve to the same board status.
const HEURISTICS: Heuristic[] = [
  { state: 'ready', required: true, patterns: [/\bready\b/i, /to.?do/i, /\bnot started\b/i, /\bnew\b/i] },
  { state: 'active', required: true, patterns: [/in.?progress/i, /\bdoing\b/i, /\bactive\b/i, /\bwip\b/i, /\bstarted\b/i] },
  { state: 'done', required: true, patterns: [/\bdone\b/i, /complete/i, /\bshipped\b/i, /\bclosed\b/i, /\bmerged\b/i] },
  { state: 'blocked', required: false, patterns: [/block/i, /\bwaiting\b/i, /\bstuck\b/i] },
  { state: 'review', required: false, patterns: [/review/i, /\bqa\b/i, /testing/i] },
  { state: 'claimed', required: false, patterns: [/claim/i, /assigned/i, /picked/i] },
  { state: 'cancelled', required: false, patterns: [/cancel/i, /won.?t/i, /dropped/i, /abandon/i] },
  { state: 'backlog', required: false, patterns: [/backlog/i, /icebox/i] },
];

export interface ProposedMap {
  map: Partial<Record<CanonicalState, string>>;
  unresolvedRequired: CanonicalState[];
}

export function proposeStatusMap(statuses: StatusOption[]): ProposedMap {
  const used = new Set<string>();
  const map: Partial<Record<CanonicalState, string>> = {};
  const claim = (state: CanonicalState, name: string): void => {
    map[state] = name;
    used.add(name);
  };

  // Pass 1 — match by status NAME only. This is precise: it stops a general
  // state (e.g. ready ← /to.?do/) from grabbing a neighbour that merely shares
  // a Notion group/category (e.g. a "Backlog" option living in the "To-do" group).
  for (const h of HEURISTICS) {
    const match = statuses.find((s) => !used.has(s.name) && h.patterns.some((p) => p.test(s.name)));
    if (match) claim(h.state, match.name);
  }
  // Pass 2 — only for still-unresolved REQUIRED states, fall back to the Notion
  // group/category (handles boards whose status names are idiosyncratic).
  for (const h of HEURISTICS) {
    if (!h.required || map[h.state]) continue;
    const match = statuses.find((s) => !used.has(s.name) && !!s.category && h.patterns.some((p) => p.test(s.category!)));
    if (match) claim(h.state, match.name);
  }

  const unresolvedRequired = HEURISTICS.filter((h) => h.required && !map[h.state]).map((h) => h.state);
  return { map, unresolvedRequired };
}

export interface TaskSetupOptions {
  cwd: string;
  dataSourceId: string;
  overrides?: Partial<Record<CanonicalState, string>>;
  statusProperty?: string;
  assigneeProperty?: string;
  write: boolean;
  token?: string;
  fetchImpl?: FetchImpl;
}

// A config that may still have unmapped required states — the shape produced by
// a preview/--json run before the user has supplied every required mapping.
export interface DraftTrackerConfig {
  version: number;
  tracker: 'notion';
  data_source_id: string;
  status_property: string;
  assignee_property: string;
  unique_id_property?: string;
  project_property?: string;
  project_filter?: string[];
  status_map: Partial<Record<CanonicalState, string>>;
}

export interface TaskSetupResult {
  config: TrackerConfig | DraftTrackerConfig;
  written: boolean;
  warnings: string[];
  path: string;
}

function pickOne(names: string[], explicit: string | undefined, label: string, flag: string): string {
  if (explicit) {
    if (!names.includes(explicit)) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} ${flag} ${chalk.yellow(`'${explicit}'`)} is not a ${label} property on the board`,
        body: `  Available: ${names.length ? names.join(', ') : '(none)'}`,
        remedy: `  Pass ${chalk.bold(flag)} with one of the names above.`,
        exitCode: EXIT_ERROR,
      });
    }
    return explicit;
  }
  if (names.length === 0) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} the board has no ${label} property`,
      body: `  roster tasks needs one ${label} column to operate.`,
      remedy: `  Add it in Notion, then re-run ${chalk.bold('roster task setup')}.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (names.length > 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} the board has multiple ${label} properties`,
      body: `  Found: ${names.join(', ')}`,
      remedy: `  Disambiguate with ${chalk.bold(`${flag} <name>`)}.`,
      exitCode: EXIT_ERROR,
    });
  }
  return names[0]!;
}

export async function runTaskSetup(opts: TaskSetupOptions): Promise<TaskSetupResult> {
  const adapter = new NotionAdapter({
    dataSourceId: opts.dataSourceId,
    token: opts.token,
    fetchImpl: opts.fetchImpl,
  });
  const board = await adapter.describeBoard();
  const warnings: string[] = [];

  const statusProp = pickOne(board.statusProperties.map((s) => s.name), opts.statusProperty, 'status', '--status-property');
  const assigneeProp = pickOne(board.assigneeProperties, opts.assigneeProperty, 'assignee (people)', '--assignee-property');
  const statusOptions = board.statusProperties.find((s) => s.name === statusProp)!.options;

  const proposal = proposeStatusMap(statusOptions);
  const map: Partial<Record<CanonicalState, string>> = { ...proposal.map, ...(opts.overrides ?? {}) };

  const stillMissing = (['ready', 'active', 'done'] as CanonicalState[]).filter((s) => !map[s]);
  if (stillMissing.length > 0) {
    warnings.push(
      `Could not confidently map required state(s): ${stillMissing.join(', ')}. Re-run with --map ${stillMissing
        .map((s) => `${s}=<StatusName>`)
        .join(',')}.`,
    );
  }
  if (!board.uniqueId) {
    warnings.push(
      'No unique-id property found. Add a "Unique ID" column in Notion (e.g. prefix TASK) by hand — the API cannot create it — then re-run setup so TASK-123 handles work.',
    );
  }

  const boardStatusNames = statusOptions.map((o) => o.name);
  const path = join(opts.cwd, 'roster', 'tracker.yaml');

  const draft: DraftTrackerConfig = {
    version: TRACKER_YAML_VERSION,
    tracker: 'notion',
    data_source_id: opts.dataSourceId.replace(/^collection:\/\//, '').trim(),
    status_property: statusProp,
    assignee_property: assigneeProp,
    ...(board.uniqueId ? { unique_id_property: board.uniqueId.property } : {}),
    status_map: map,
  };

  // Validate every mapping that IS present (existence + no duplicate status) in
  // BOTH preview and write — a bad or ambiguous --map must never preview as ok.
  // A missing required state is handled separately: a warning in preview, a hard
  // stop on --yes.
  try {
    crossCheckStatusMap(draft.status_map, boardStatusNames);
  } catch (err) {
    if (err instanceof TrackerConfigError) throw configErrorToRoster(err);
    throw err;
  }

  if (opts.write) {
    if (stillMissing.length > 0) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} refusing to write tracker.yaml — required states unmapped`,
        body: `  Unmapped: ${stillMissing.join(', ')}`,
        remedy: `  Re-run with --map ${stillMissing.map((s) => `${s}=<StatusName>`).join(',')} --yes.`,
        exitCode: EXIT_ERROR,
      });
    }
    let config: TrackerConfig;
    try {
      config = parseTrackerConfig(draft);
    } catch (err) {
      if (err instanceof TrackerConfigError) throw configErrorToRoster(err);
      throw err;
    }
    atomicWriteFile(path, YAML.stringify(config));
    return { config, written: true, warnings, path };
  }

  return { config: draft, written: false, warnings, path };
}

function configErrorToRoster(err: TrackerConfigError): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} tracker.yaml would be invalid`,
    body: err.issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'),
    remedy: `  Fix the mapping (e.g. ${chalk.bold('--map ready=<StatusName>')}) and re-run.`,
    exitCode: EXIT_ERROR,
  });
}
