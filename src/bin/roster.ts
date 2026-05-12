#!/usr/bin/env node
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPackageVersion, ROSTER_ROOT } from '../lib/paths.ts';
import { detectTools, type Tool, type ToolKey } from '../lib/tools.ts';
import { installToTool, RosterPermissionError, type InstallResult } from '../lib/install.ts';
import { executeInit } from '../commands/init.ts';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_CANCELLED = 2;
const EXIT_NO_TOOLS = 3;

type Subcommand = 'install' | 'init' | 'doctor';
const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>(['install', 'init', 'doctor']);

const TOOL_INSTALL_LINKS: ReadonlyArray<string> = [
  'Claude Code:  https://claude.ai/code',
  'Codex CLI:    https://github.com/openai/codex',
  'Gemini CLI:   https://github.com/google-gemini/gemini-cli',
];

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

function exitUnknown(command: string): never {
  console.error(`${chalk.red.bold('roster:')} unknown command ${chalk.yellow(`'${command}'`)}`);
  console.error(`Run ${chalk.bold('roster --help')} to see available commands.`);
  process.exit(EXIT_ERROR);
}

function printNoToolsHint(): void {
  console.error(`${chalk.red.bold('roster:')} no AI tools detected on this machine.`);
  console.error('');
  console.error('Install at least one of:');
  for (const link of TOOL_INSTALL_LINKS) {
    console.error(`  ${link}`);
  }
  console.error('');
  console.error(`Re-run ${chalk.bold('roster install')} after installing one.`);
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
  const silent = args.includes('--silent');
  const verbose = args.includes('--verbose');
  const version = getPackageVersion();

  if (!silent) printBanner(version);

  const detected = detectTools();
  if (detected.length === 0) {
    printNoToolsHint();
    return EXIT_NO_TOOLS;
  }

  const targetTools = await promptForTools(detected);
  if (targetTools === null) {
    if (!silent) console.log(chalk.dim('Cancelled. Nothing written.'));
    return EXIT_CANCELLED;
  }

  const skillsSrc = join(ROSTER_ROOT, 'skills');
  const agentsSrc = join(ROSTER_ROOT, 'agents');

  for (const tool of targetTools) {
    try {
      const result = await installToTool(tool, {
        skills: skillsSrc,
        agents: agentsSrc,
        silent: !verbose,
      });
      if (!silent) console.log(summarizeInstall(tool, result));
    } catch (err: unknown) {
      const message = err instanceof RosterPermissionError ? err.message : (err as Error).message ?? String(err);
      console.error(`${chalk.red.bold('roster:')} ${message}`);
      return EXIT_ERROR;
    }
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
  // First non-flag positional arg is the project name.
  const name = args.find((a) => !a.startsWith('-'));

  if (!silent) printBanner(getPackageVersion());

  try {
    const result = await executeInit({
      cwd: process.cwd(),
      name,
      silent,
      force,
      noGit,
    });
    return result.status === 'cancelled' ? EXIT_CANCELLED : EXIT_OK;
  } catch (err: unknown) {
    console.error(`${chalk.red.bold('roster:')} ${(err as Error).message ?? String(err)}`);
    return EXIT_ERROR;
  }
}

function runDoctor(_args: readonly string[]): number {
  console.log(chalk.dim('doctor: not implemented yet (lands in ROS-19 / P2-T09)'));
  return EXIT_OK;
}

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMANDS.has(value);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const version = getPackageVersion();

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

  exitUnknown(first);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`${chalk.red.bold('roster:')} unhandled error`);
    console.error(err);
    process.exit(EXIT_ERROR);
  });
