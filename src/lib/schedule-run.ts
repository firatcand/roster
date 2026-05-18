import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { resolveScheduleByName } from './schedule-resolve.ts';
import { buildOrchestratorPrompt } from './schedule-install.ts';
import { resolveCodexBinaryPath } from './codex-cron.ts';
import { runCodexPreflight } from './codex-preflight.ts';
import { codexPreflightError } from './errors.ts';

export type SpawnFn = (cmd: string, args: ReadonlyArray<string>, options?: SpawnOptions) => ChildProcess;

export type ScheduleRunOpts = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  silent: boolean;
  dryRun: boolean;
  // Test seam: spawn factory and env override.
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  codexBinaryPathOverride?: string;
};

export type ScheduleRunResult = {
  tool: 'claude' | 'codex';
  functionName: string;
  name: string;
  // Claude prints; no child. Codex spawns and returns the child's exit code.
  exitCode: number;
  // For Claude — the prompt that would be pasted. For Codex — the orchestrator
  // prompt that was passed to `codex exec`. Either way, useful for tests + the
  // wrapper banner.
  prompt: string;
};

function renderClaudeHandoff(workspacePath: string, prompt: string, name: string, silent: boolean, dryRun: boolean): string[] {
  if (silent) return [];
  const lines = [
    '',
    `${chalk.green('✓')} Manual fire for ${chalk.bold(name)} ${chalk.dim('(tool: claude — print-only)')}`,
    '',
    `Open Claude Code in ${chalk.bold(workspacePath)} and paste this prompt:`,
    '',
    `  ${chalk.cyan(prompt)}`,
    '',
    chalk.dim('This is the same prompt the scheduled task fires. Output stays in your chat.'),
    chalk.dim('roster never invokes `claude -p` itself — that would route through the Agent SDK billing pool.'),
  ];
  if (dryRun) lines.push(chalk.dim('--dry-run: identical to a real fire — `schedule run` for claude is already print-only.'));
  lines.push('');
  return lines;
}

function renderCodexBanner(workspacePath: string, prompt: string, name: string, installMode: string, silent: boolean): string[] {
  if (silent) return [];
  return [
    '',
    `${chalk.green('✓')} Manual fire for ${chalk.bold(name)} ${chalk.dim(`(tool: codex ${installMode})`)}`,
    `  Workspace: ${chalk.dim(workspacePath)}`,
    `  Env: ${chalk.dim('interactive shell (not env -i; cron-env divergence is doctor\'s job)')}`,
    '',
  ];
}

export async function executeRun(opts: ScheduleRunOpts): Promise<ScheduleRunResult> {
  const resolved = resolveScheduleByName({
    cwd: opts.cwd,
    name: opts.name,
    functionName: opts.functionName,
  });

  const prompt = buildOrchestratorPrompt(
    resolved.entry.agent,
    resolved.entry.plan,
    resolved.entry.project,
  );

  if (resolved.entry.tool === 'claude') {
    for (const line of renderClaudeHandoff(resolved.workspacePath, prompt, resolved.entry.name, opts.silent, opts.dryRun)) {
      console.log(line);
    }
    return {
      tool: 'claude',
      functionName: resolved.functionName,
      name: resolved.entry.name,
      exitCode: 0,
      prompt,
    };
  }

  // Codex path: spawn `codex exec -C <workspace> <prompt>`.
  // Subscription-safety preflight (codex review finding #4, ROS-36):
  // `run` inherits the user's interactive env, which can contain
  // OPENAI_API_KEY / CODEX_API_KEY / ANTHROPIC_API_KEY / non-default CODEX_HOME.
  // Any of those would silently route this fire through API billing instead of
  // the subscription. Mirror the install-time preflight: refuse if any check
  // fails. doctor (ROS-38) will surface the same gates outside of run/install.
  //
  // Under --dry-run, preflight failures must still surface (a user using
  // --dry-run to verify their setup needs to see broken auth), so we exit 1
  // with the rendered failure list rather than throwing.
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const preflight = runCodexPreflight({ homeDir, env });
  if (!preflight.ok) {
    if (opts.dryRun) {
      const err = codexPreflightError(preflight.failures);
      if (!opts.silent) {
        console.error(err.header);
        if (err.body) console.error(err.body);
        if (err.remedy) console.error(err.remedy);
      }
      return {
        tool: 'codex',
        functionName: resolved.functionName,
        name: resolved.entry.name,
        exitCode: 1,
        prompt,
      };
    }
    throw codexPreflightError(preflight.failures);
  }

  const codexPath = resolveCodexBinaryPath(env, opts.codexBinaryPathOverride);
  for (const line of renderCodexBanner(resolved.workspacePath, prompt, resolved.entry.name, resolved.entry.install_mode, opts.silent)) {
    console.log(line);
  }

  if (opts.dryRun) {
    if (!opts.silent) {
      console.log(chalk.dim(`--dry-run: spawn skipped. Would run: ${codexPath} exec -C ${resolved.workspacePath} <prompt>`));
      console.log('');
    }
    return {
      tool: 'codex',
      functionName: resolved.functionName,
      name: resolved.entry.name,
      exitCode: 0,
      prompt,
    };
  }

  const spawnFn: SpawnFn = opts.spawn ?? (spawn as SpawnFn);
  const child = spawnFn(codexPath, ['exec', '-C', resolved.workspacePath, prompt], {
    stdio: 'inherit',
    env,
    cwd: resolved.workspacePath,
  });

  const exitCode: number = await new Promise((resolveP) => {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null) resolveP(code);
      else if (signal !== null) resolveP(128 + 1); // approximate POSIX signal exit
      else resolveP(1);
    });
    child.on('error', () => resolveP(1));
  });

  return {
    tool: 'codex',
    functionName: resolved.functionName,
    name: resolved.entry.name,
    exitCode,
    prompt,
  };
}
