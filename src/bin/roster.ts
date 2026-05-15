#!/usr/bin/env node
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPackageVersion, ROSTER_ROOT } from '../lib/paths.ts';
import { allTools, detectTools, type Tool, type ToolKey } from '../lib/tools.ts';
import { installToTool, type InstallResult } from '../lib/install.ts';
import { parseInstallArgs } from '../lib/install-args.ts';
import { parseDoctorArgs } from '../lib/doctor-args.ts';
import { executeInit } from '../commands/init.ts';
import { executeDoctor } from '../commands/doctor.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  EXIT_NO_TOOLS,
  RosterError,
  isRosterError,
  noToolsError,
  renderError,
  unexpectedError,
  userCancelledInit,
  userCancelledInstall,
} from '../lib/errors.ts';

type Subcommand = 'install' | 'init' | 'doctor';
const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>(['install', 'init', 'doctor']);

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function printBanner(version: string): void {
  console.log();
  console.log(`${chalk.bold.cyan('roster')}${chalk.dim(` v${version}`)}`);
  console.log(chalk.dim('Multi-agent workspace scaffolder for Claude Code, Codex CLI, and Gemini.'));
  console.log();
}

function printHelp(version: string): void {
  printBanner(version);
  const lines = [
    chalk.bold('Usage:'),
    `  roster                       ${chalk.dim('Interactive install (alias of `roster install`)')}`,
    `  roster install               ${chalk.dim('Copy skills + agents into detected AI tool config dirs')}`,
    `  roster init [name]           ${chalk.dim('Scaffold a multi-agent workspace in the current dir')}`,
    `  roster doctor                ${chalk.dim('Audit installed skills + agents per AI tool')}`,
    '',
    chalk.bold('Flags:'),
    `  -h, --help                   ${chalk.dim('Show this help')}`,
    `  -v, --version                ${chalk.dim('Print version and exit')}`,
    `  --silent                     ${chalk.dim('Suppress non-error output (install)')}`,
    `  --verbose                    ${chalk.dim('Log each file path written (install)')}`,
    `  --all                        ${chalk.dim('Install to every detected tool (install)')}`,
    `  --tool <name>                ${chalk.dim('Install to a single tool: claude | codex | gemini')}`,
    `  --json                       ${chalk.dim('Emit machine-readable JSON (doctor)')}`,
    `  --debug                      ${chalk.dim('Print full stack trace on error (global)')}`,
    '',
    chalk.bold('Exit codes:'),
    `  ${EXIT_OK}  ${chalk.dim('success')}`,
    `  ${EXIT_ERROR}  ${chalk.dim('generic error')}`,
    `  ${EXIT_CANCELLED}  ${chalk.dim('user cancelled')}`,
    `  ${EXIT_NO_TOOLS}  ${chalk.dim('no AI tool detected')}`,
    '',
    chalk.dim('Docs: https://github.com/firatcand/roster'),
  ];
  console.log(lines.join('\n'));
  console.log();
}

function unknownCommandError(command: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} unknown command ${chalk.yellow(`'${command}'`)}`,
    body: '',
    remedy: `  Run ${chalk.bold('roster --help')} to see available commands.`,
    exitCode: EXIT_ERROR,
  });
}

function toolHints(tools: ReadonlyArray<Tool>): ReadonlyArray<{ name: string; installLink: string }> {
  return tools.map((t) => ({ name: t.name, installLink: t.installLink }));
}

function summarizeInstall(tool: Tool, result: InstallResult): string {
  const skillsLine = `${result.skillsCount} skills → ${tildify(result.skillsTarget)}`;
  const agentsLine = result.agentsTarget
    ? `${result.agentsCount} agents → ${tildify(result.agentsTarget)}`
    : `${result.agentsCount} agents → (n/a)`;
  return `${chalk.green('✓')} ${chalk.bold(tool.name)} — ${skillsLine}, ${agentsLine}`;
}

async function promptForTools(detected: Tool[]): Promise<Tool[] | null> {
  if (detected.length === 1) return detected;

  const { checkbox, confirm } = await import('@inquirer/prompts');
  let selectedKeys: ToolKey[];
  try {
    selectedKeys = await checkbox<ToolKey>({
      message: 'Install roster into which AI tools?',
      choices: detected.map((t) => ({ name: t.name, value: t.key, checked: true })),
    });
  } catch {
    return null; // ESC / Ctrl-C
  }

  if (selectedKeys.length === 0) {
    let exitAnyway: boolean;
    try {
      exitAnyway = await confirm({
        message: 'No tools selected. Exit without installing?',
        default: true,
      });
    } catch {
      return null;
    }
    if (exitAnyway) return null;
    return promptForTools(detected);
  }

  return detected.filter((t) => selectedKeys.includes(t.key));
}

async function runInstall(args: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  const { silent, verbose, target } = parsed;
  const version = getPackageVersion();

  if (!silent) printBanner(version);

  const detected = detectTools();
  if (detected.length === 0) {
    throw noToolsError(toolHints(allTools()));
  }

  let targetTools: Tool[] | null;
  if (target.mode === 'all') {
    targetTools = detected;
  } else if (target.mode === 'tool') {
    const match = detected.find((t) => t.key === target.key);
    if (!match) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} ${target.key} not detected on this machine`,
        body: `  --tool ${target.key} was requested, but no ${target.key} install was found.`,
        remedy: `  Install it first, or omit ${chalk.bold('--tool')} to install to all detected tools.`,
        exitCode: EXIT_NO_TOOLS,
      });
    }
    targetTools = [match];
  } else {
    targetTools = await promptForTools(detected);
  }

  if (targetTools === null) {
    throw userCancelledInstall();
  }

  const skillsSrc = join(ROSTER_ROOT, 'skills');
  const agentsSrc = join(ROSTER_ROOT, 'agents');

  // --all and --tool are non-interactive (CI / scripted use): decline the
  // symlink-replacement prompt deterministically so install doesn't hang
  // waiting on TTY-less stdin (ROS-16).
  const nonInteractive = target.mode !== 'interactive';
  const confirmFn = nonInteractive ? async (): Promise<boolean> => false : undefined;

  for (const tool of targetTools) {
    const result = await installToTool(tool, {
      skills: skillsSrc,
      agents: agentsSrc,
      silent: !verbose,
      ...(confirmFn ? { confirm: confirmFn } : {}),
    });
    if (!silent) console.log(summarizeInstall(tool, result));
  }

  if (!silent) {
    console.log();
    console.log(`${chalk.dim('Next: ')}${chalk.bold('roster init')}${chalk.dim(' to scaffold a workspace.')}`);
  }
  return EXIT_OK;
}

async function runInit(args: readonly string[]): Promise<number> {
  const silent = args.includes('--silent');
  const force = args.includes('--force');
  const noGit = args.includes('--no-git') || args.includes('--skip-git');
  const name = args.find((a) => !a.startsWith('-'));

  if (!silent) printBanner(getPackageVersion());

  const result = await executeInit({
    cwd: process.cwd(),
    name,
    silent,
    force,
    noGit,
  });
  if (result.status === 'cancelled') throw userCancelledInit();
  return EXIT_OK;
}

function runDoctor(args: readonly string[]): number {
  const parsed = parseDoctorArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  const code = executeDoctor({ json: parsed.json, silent: parsed.silent });
  if (code === EXIT_NO_TOOLS && !parsed.json) {
    throw noToolsError(toolHints(allTools()));
  }
  return code;
}

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMANDS.has(value);
}

const rawArgs = process.argv.slice(2);
const debugMode = rawArgs.includes('--debug');

async function main(): Promise<number> {
  const version = getPackageVersion();
  const args = debugMode ? rawArgs.filter((a) => a !== '--debug') : rawArgs;

  if (args.includes('--help') || args.includes('-h')) {
    printHelp(version);
    return EXIT_OK;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(version);
    return EXIT_OK;
  }

  const [first, ...rest] = args;

  if (first === undefined) {
    return runInstall(rest);
  }

  if (isSubcommand(first)) {
    if (first === 'install') return runInstall(rest);
    if (first === 'init') return await runInit(rest);
    if (first === 'doctor') return runDoctor(rest);
  }

  throw unknownCommandError(first);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const rosterErr = isRosterError(err) ? err : unexpectedError(err);
    renderError(rosterErr, { debug: debugMode });
    process.exit(rosterErr.exitCode);
  });
