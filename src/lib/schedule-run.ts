import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';
import chalk from 'chalk';
import { resolveScheduleByName } from './schedule-resolve.ts';
import { buildOrchestratorPrompt } from './schedule-install.ts';
import { resolveCodexBinaryPath } from './codex-cron.ts';

export type SpawnFn = (cmd: string, args: ReadonlyArray<string>, options?: SpawnOptions) => ChildProcess;

export type ScheduleRunOpts = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  silent: boolean;
  // Test seam: spawn factory and env override.
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
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

function renderClaudeHandoff(workspacePath: string, prompt: string, name: string, silent: boolean): string[] {
  if (silent) return [];
  return [
    '',
    `${chalk.green('✓')} Manual fire for ${chalk.bold(name)} ${chalk.dim('(tool: claude — print-only)')}`,
    '',
    `Open Claude Code in ${chalk.bold(workspacePath)} and paste this prompt:`,
    '',
    `  ${chalk.cyan(prompt)}`,
    '',
    chalk.dim('This is the same prompt the scheduled task fires. Output stays in your chat.'),
    chalk.dim('roster never invokes `claude -p` itself — that would route through the Agent SDK billing pool.'),
    '',
  ];
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

  const prompt = buildOrchestratorPrompt(resolved.entry.agent, resolved.entry.plan);

  if (resolved.entry.tool === 'claude') {
    for (const line of renderClaudeHandoff(resolved.workspacePath, prompt, resolved.entry.name, opts.silent)) {
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
  const env = opts.env ?? process.env;
  const codexPath = resolveCodexBinaryPath(env, opts.codexBinaryPathOverride);
  for (const line of renderCodexBanner(resolved.workspacePath, prompt, resolved.entry.name, resolved.entry.install_mode, opts.silent)) {
    console.log(line);
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
