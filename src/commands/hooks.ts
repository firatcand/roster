import { homedir } from 'node:os';
import chalk from 'chalk';
import type { HooksTarget } from '../lib/hooks-args.ts';
import { installHook, type HookHost, type HookInstallResult } from '../lib/hook-install.ts';
import { EXIT_OK } from '../lib/errors.ts';

export type HooksInstallOptions = {
  target: HooksTarget;
  silent: boolean;
};

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function summarize(result: HookInstallResult): string {
  const hostLabel = result.host === 'claude' ? 'Claude Code' : 'Codex CLI';
  const hookLabel = result.kind === 'tripwire' ? 'PostToolUse Tripwire scan' : 'SessionStart hook';
  if (result.status === 'installed') {
    return `${chalk.green('✓')} ${chalk.bold(hostLabel)} — ${hookLabel} → ${tildify(result.configFile)}`;
  }
  if (result.status === 'already-present') {
    return `${chalk.dim('·')} ${chalk.bold(hostLabel)} — ${hookLabel} already installed (${tildify(result.configFile)})`;
  }
  return `${chalk.yellow('⚠')} ${chalk.bold(hostLabel)} — ${hookLabel} skipped: ${result.reason ?? 'host not detected'}`;
}

function hostsForTarget(target: HooksTarget): HookHost[] {
  if (target === 'claude') return ['claude'];
  if (target === 'codex') return ['codex'];
  return ['claude', 'codex'];
}

export async function executeHooksInstall(opts: HooksInstallOptions): Promise<number> {
  if (process.platform === 'win32') {
    if (!opts.silent) {
      console.log(
        `${chalk.yellow('⚠')} ${chalk.bold('roster hooks install')} skipped on Windows.`,
      );
      console.log(
        chalk.dim('  banner.sh is POSIX shell; the in-LLM orchestrator skill still surfaces HITL banners.'),
      );
    }
    return EXIT_OK;
  }

  const hosts = hostsForTarget(opts.target);
  const results: HookInstallResult[] = [];
  for (const host of hosts) {
    results.push(...installHook(host));
  }

  if (!opts.silent) {
    console.log();
    console.log(chalk.bold('roster hooks install'));
    for (const r of results) console.log('  ' + summarize(r));
    console.log();
  }

  return EXIT_OK;
}
