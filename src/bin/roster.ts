#!/usr/bin/env node
import chalk from 'chalk';
import { getPackageVersion } from '../lib/paths.ts';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_CANCELLED = 2;
const EXIT_NO_TOOLS = 3;

type Subcommand = 'install' | 'init' | 'doctor';
const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>(['install', 'init', 'doctor']);

function printBanner(version: string): void {
  console.log();
  console.log(`${chalk.bold.cyan('roster')}${chalk.dim(` v${version}`)}`);
  console.log(chalk.dim('Multi-agent workspace scaffolder for Claude Code, Codex CLI, Cursor, Gemini.'));
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

// Subcommand handlers are stubs in P1-T03. They print a placeholder and exit OK
// so smoke-tests can confirm routing while the real flows land in later tasks.

function runInstall(_args: readonly string[]): number {
  console.log(chalk.dim('install: not implemented yet (lands in ROS-6 / P1-T07)'));
  return EXIT_OK;
}

function runInit(_args: readonly string[]): number {
  console.log(chalk.dim('init: not implemented yet (lands in ROS-7 / P1-T09)'));
  return EXIT_OK;
}

function runDoctor(_args: readonly string[]): number {
  console.log(chalk.dim('doctor: not implemented yet (lands in ROS-19 / P2-T09)'));
  return EXIT_OK;
}

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMANDS.has(value);
}

const args = process.argv.slice(2);
const version = getPackageVersion();

if (args.includes('--help') || args.includes('-h')) {
  printHelp(version);
  process.exit(EXIT_OK);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log(version);
  process.exit(EXIT_OK);
}

const [first, ...rest] = args;

if (first === undefined) {
  process.exit(runInstall(rest));
}

if (isSubcommand(first)) {
  if (first === 'install') process.exit(runInstall(rest));
  if (first === 'init') process.exit(runInit(rest));
  if (first === 'doctor') process.exit(runDoctor(rest));
}

exitUnknown(first);
