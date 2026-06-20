import { join } from 'node:path';
import chalk from 'chalk';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';
import { detectTools } from '../lib/tools.ts';
import { detectWorkspace } from '../lib/install-scope.ts';
import { toolForScope } from '../lib/install-scope.ts';
import { installToTool } from '../lib/install.ts';
import { syncFounderSkills, type SyncResult } from '../lib/founder-skills/sync.ts';
import { realInstaller } from '../lib/founder-skills/installer.ts';
import { executeHooksInstall } from './hooks.ts';
import { executeUpgrade } from '../lib/upgrade.ts';
import { renderUpgradeResult } from './upgrade.ts';
import { EXIT_OK, workspaceRequiredError } from '../lib/errors.ts';

export type UpdateCommandOptions = {
  cwd: string;
  json: boolean;
  excludes: readonly string[];
};

// `roster update` — one command to bring an existing workspace current with the
// installed roster: refresh roster's skills + agents (project-local), the
// founder-skills (if declared), the SessionStart banner hooks, and the scaffold
// files. Pure orchestration over the existing commands; changes none of their
// behavior. The CLI itself updates via npm (a running process can't replace its
// own global package) — surfaced as a closing reminder.
export async function executeUpdate(opts: UpdateCommandOptions): Promise<number> {
  const { cwd } = opts;
  if (!detectWorkspace(cwd)) throw workspaceRequiredError(cwd);

  const version = getPackageVersion();
  const skillsSrc = join(ROSTER_ROOT, 'skills');
  const agentsSrc = join(ROSTER_ROOT, 'agents');

  // 1 — roster's own skills + agents, project-local, non-interactive.
  const installed: Array<{ tool: string; skills: number; agents: number }> = [];
  for (const tool of detectTools()) {
    const scoped = toolForScope(tool, 'project', cwd);
    const r = await installToTool(scoped, {
      skills: skillsSrc,
      agents: agentsSrc,
      silent: true,
      scope: 'project',
      confirm: async () => false,
    });
    installed.push({ tool: tool.key, skills: r.skillsCount, agents: r.agentsCount });
  }

  // founder-skills: auto-sync iff a founder-skills.yaml is present (no-op otherwise).
  const sync: SyncResult = await syncFounderSkills({ cwd, installer: realInstaller });

  // 2 — SessionStart banner hooks.
  await executeHooksInstall({ target: 'all', silent: true });

  // 3 — scaffold files.
  const upgrade = executeUpgrade({ cwd, dryRun: false, excludes: opts.excludes });

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, version, install: installed, founderSkills: sync, hooks: 'all', upgrade }, null, 2));
    return EXIT_OK;
  }

  const out: string[] = ['', chalk.bold(`roster update`) + chalk.dim(`  (CLI v${version})`)];

  out.push('', chalk.bold('1. Skills + agents'));
  if (installed.length === 0) {
    out.push(`  ${chalk.yellow('!')} no AI tool detected — skipped (install Claude Code / Codex / Gemini, then re-run)`);
  }
  for (const i of installed) {
    out.push(`  ${chalk.green('✓')} ${i.tool}: ${i.skills} skills, ${i.agents} agents ${chalk.dim('→ project-local')}`);
  }

  out.push('', chalk.bold('2. Founder skills'));
  if (sync.status === 'no-manifest') {
    out.push(`  ${chalk.dim('·')} no founder-skills.yaml — none declared`);
  } else {
    const tools = sync.tools.length > 0 ? sync.tools.join(', ') : 'none';
    out.push(`  ${chalk.green('✓')} ${sync.installed.length} installed${sync.pruned.length > 0 ? `, ${sync.pruned.length} pruned` : ''} ${chalk.dim(`(${tools})`)}`);
  }

  out.push('', chalk.bold('3. Scaffold files'));
  // Splice the upgrade render body (drop its own leading '' + 'roster upgrade' header).
  out.push(...renderUpgradeResult(upgrade).slice(2));

  out.push(chalk.dim(`The roster CLI updates separately via npm — get the latest with: ${chalk.bold('npm i -g @firatcand/roster@latest')}`));
  console.log(out.join('\n'));
  return EXIT_OK;
}
