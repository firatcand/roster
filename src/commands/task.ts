import chalk from 'chalk';
import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';
import { CANONICAL_STATES, type CanonicalState } from '../lib/tasks/machine.ts';
import { runTaskSetup, type TaskSetupResult } from '../lib/tasks/setup.ts';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parseMap(spec: string): Partial<Record<CanonicalState, string>> {
  const out: Partial<Record<CanonicalState, string>> = {};
  const valid = new Set<string>(CANONICAL_STATES);
  for (const pair of spec.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw usageError(`bad --map segment '${pair.trim()}' — expected <state>=<StatusName>`);
    }
    const state = pair.slice(0, eq).trim();
    const name = pair.slice(eq + 1).trim();
    if (!valid.has(state)) {
      throw usageError(`--map: '${state}' is not a canonical state (${CANONICAL_STATES.join(', ')})`);
    }
    if (name.length === 0) {
      throw usageError(`--map: '${state}=' has an empty status name`);
    }
    out[state as CanonicalState] = name;
  }
  return out;
}

function usageError(detail: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${detail}`,
    body: '  Usage: roster task setup --data-source <collection://…|uuid> [--map ready=…,active=…,done=…] [--status-property N] [--assignee-property N] [--yes] [--json]',
    remedy: `  Run ${chalk.bold('roster task --help')} for details.`,
    exitCode: EXIT_ERROR,
  });
}

function renderPreview(result: TaskSetupResult): void {
  const map = result.config.status_map ?? {};
  console.log('');
  console.log(chalk.bold('roster task setup') + chalk.dim(result.written ? '  (wrote roster/tracker.yaml)' : '  (preview — nothing written)'));
  console.log(`  data source : ${chalk.cyan(result.config.data_source_id ?? '?')}`);
  console.log(`  status prop : ${result.config.status_property ?? '?'}`);
  console.log(`  assignee    : ${result.config.assignee_property ?? '?'}`);
  if (result.config.unique_id_property) console.log(`  unique id   : ${result.config.unique_id_property}`);
  console.log('  status map  :');
  for (const state of CANONICAL_STATES) {
    const v = (map as Record<string, string>)[state];
    if (v) console.log(`    ${state.padEnd(10)} → ${chalk.green(v)}`);
  }
  for (const w of result.warnings) console.log(`  ${chalk.yellow('⚠')} ${w}`);
  if (!result.written) console.log(chalk.dim('\n  Re-run with --yes to write roster/tracker.yaml.'));
  console.log('');
}

async function executeTaskSetup(argv: string[]): Promise<number> {
  const dataSource = flagValue(argv, '--data-source');
  if (!dataSource) throw usageError('--data-source is required');

  const mapSpec = flagValue(argv, '--map');
  const result = await runTaskSetup({
    cwd: flagValue(argv, '--cwd') ?? process.cwd(),
    dataSourceId: dataSource,
    overrides: mapSpec ? parseMap(mapSpec) : undefined,
    statusProperty: flagValue(argv, '--status-property'),
    assigneeProperty: flagValue(argv, '--assignee-property'),
    write: hasFlag(argv, '--yes'),
  });

  if (hasFlag(argv, '--json')) {
    console.log(
      JSON.stringify(
        { ok: true, written: result.written, path: result.path, config: result.config, warnings: result.warnings },
        null,
        2,
      ),
    );
  } else {
    renderPreview(result);
  }
  return EXIT_OK;
}

export async function runTask(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === 'setup') return executeTaskSetup(argv.slice(1));
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} unknown task subcommand ${sub ? chalk.yellow(`'${sub}'`) : '(none)'}`,
    body: '  Available: setup',
    remedy: `  Run ${chalk.bold('roster task setup --data-source <id>')} to configure roster/tracker.yaml.`,
    exitCode: EXIT_ERROR,
  });
}
