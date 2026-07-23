import chalk from 'chalk';
import { runSetup, type SetupOptions, type SetupResult } from '../lib/persistence/setup.ts';
import { EXIT_OK } from '../lib/errors.ts';

export type OpsSetupCommandOptions = Omit<SetupOptions, 'env' | 'now' | 'mintId' | 'adminFiles' | 'files' | 'validateBucket' | 'onPhase'> & {
  json: boolean;
};

const STATUS_LINE: Record<SetupResult['status'], string> = {
  created: 'workspace persistence configured',
  resumed: 'setup resumed and completed (rolled forward)',
  validated: 'existing configuration validated',
  forked: 'new identity forked',
};

function renderHuman(result: SetupResult): string {
  const out: string[] = ['', chalk.bold('roster ops setup') + '  ' + chalk.dim(STATUS_LINE[result.status])];
  out.push(`  ${chalk.green('✓')} workspace ${chalk.bold(result.workspace.name)} ${chalk.dim(`(${result.workspace.id})`)}`);
  out.push(`  ${chalk.green('✓')} backend ${chalk.bold(result.backend)} ${chalk.dim(`→ ${result.configPath}`)}`);
  out.push(
    result.gitignore === 'appended'
      ? `  ${chalk.green('✓')} .gitignore: added ${chalk.bold('/.roster/ops/')}`
      : `  ${chalk.dim('·')} .gitignore already ignores /.roster/ops/`,
  );
  if (result.backendInfo !== null) {
    const comps = Object.entries(result.backendInfo.components)
      .map(([name, c]) => `${name}@v${c.version}`)
      .join(', ');
    out.push(`  ${chalk.dim('·')} components: ${comps}`);
  }
  if (result.roleInvariants !== null) {
    if (result.roleInvariants.ok) {
      out.push(`  ${chalk.green('✓')} runtime role passes the least-privilege gate`);
    } else {
      out.push(`  ${chalk.yellow('!')} runtime role invariant violations:`);
      for (const v of result.roleInvariants.violations) {
        out.push(`      [${v.kind}] ${v.detail}`);
        out.push(chalk.dim(`        fix: ${v.remedy}`));
      }
    }
  }
  if (result.orphaned !== null) {
    out.push(`  ${chalk.yellow('!')} previous identity ${result.orphaned.workspaceName} ${chalk.dim(`(${result.orphaned.workspaceId})`)} orphaned:`);
    out.push(chalk.dim(`      local tree preserved at ${result.orphaned.tree}`));
    if (result.orphaned.database) out.push(chalk.dim('      its database stamp and bucket marker stay claimed (roster never unclaims)'));
  }
  out.push('');
  return out.join('\n');
}

export async function executeOpsSetup(opts: OpsSetupCommandOptions): Promise<number> {
  const result = await runSetup(opts);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: result.status,
          state: result.state,
          workspace: result.workspace,
          backend: result.backend,
          configPath: result.configPath,
          gitignore: result.gitignore,
          backendInfo: result.backendInfo,
          roleInvariants: result.roleInvariants,
          orphaned: result.orphaned,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }
  console.log(renderHuman(result));
  return EXIT_OK;
}
