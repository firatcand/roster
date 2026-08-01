import chalk from 'chalk';
import { getPackageVersion } from '../lib/paths.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  legacyWorkspaceError,
  mixedWorkspaceError,
  unsafeWorkspaceMarkerError,
  workspaceRequiredError,
} from '../lib/errors.ts';
import { probeWorkspace } from '../lib/workspace-probe.ts';
import { updateV2ProjectActivations, type ProjectActivationUpdateResult } from '../lib/generated-artifacts.ts';
import { detectProjectHostVersions } from '../lib/install.ts';

export type UpdateCommandOptions = {
  cwd: string;
  json: boolean;
};

function renderV2Update(result: ProjectActivationUpdateResult): string[] {
  const lines = ['', chalk.bold('roster update') + chalk.dim('  (v2 generated activation)')];
  for (const host of result.results) {
    const mark = host.assurance === 'missing' ? chalk.red('✗') : chalk.green('✓');
    lines.push(`  ${mark} ${host.host}: ${host.assurance}`);
    for (const file of host.files) {
      const fileMark = file.status === 'conflict' || file.status === 'missing' ? chalk.yellow('!') : chalk.dim('·');
      lines.push(`    ${fileMark} ${file.status.padEnd(18)} ${file.path}`);
    }
  }
  if (result.results.length === 0) {
    lines.push(`  ${chalk.dim('·')} no enabled hosts; synchronized ROSTER.md and generated manifest only`);
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`  ${chalk.red('!')} ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.remedy !== undefined) lines.push(`    ${chalk.dim(diagnostic.remedy)}`);
  }
  lines.push('');
  return lines;
}

export async function executeUpdate(opts: UpdateCommandOptions): Promise<number> {
  const { cwd } = opts;
  const probe = probeWorkspace(cwd);
  if (probe.kind === 'v2') {
    const result = updateV2ProjectActivations({
      root: cwd,
      hostVersions: detectProjectHostVersions(),
    });
    if (opts.json) {
      console.log(JSON.stringify({ version: getPackageVersion(), ...result }, null, 2));
    } else {
      console.log(renderV2Update(result).join('\n'));
    }
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }
  if (probe.kind === 'legacy') throw legacyWorkspaceError(probe.legacySignals);
  if (probe.kind === 'mixed') throw mixedWorkspaceError(probe.v2Signals, probe.legacySignals);
  if (probe.kind === 'unsafe') throw unsafeWorkspaceMarkerError(probe.unsafeSignals);
  throw workspaceRequiredError(cwd);
}
