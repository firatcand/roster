import chalk from 'chalk';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CANCELLED = 2;
export const EXIT_NO_TOOLS = 3;

export type RosterErrorInit = {
  header: string;
  body: string;
  remedy: string;
  exitCode: number;
};

export class RosterError extends Error {
  readonly header: string;
  readonly body: string;
  readonly remedy: string;
  readonly exitCode: number;

  constructor(opts: RosterErrorInit) {
    super(`${opts.header}\n${opts.body}\n${opts.remedy}`);
    this.name = 'RosterError';
    this.header = opts.header;
    this.body = opts.body;
    this.remedy = opts.remedy;
    this.exitCode = opts.exitCode;
  }
}

function isRosterError(err: unknown): err is RosterError {
  return err instanceof RosterError;
}

export function permissionError(targetPath: string, cause: NodeJS.ErrnoException): RosterError {
  const syscall = cause.syscall ? ` (${cause.syscall})` : '';
  return new RosterError({
    header: `${chalk.red.bold('roster:')} permission denied`,
    body: `  ${cause.code ?? 'EACCES'}${syscall} writing ${targetPath}`,
    remedy: `  Re-run with sudo, or run: sudo chown -R "$USER" ${targetPath}`,
    exitCode: EXIT_ERROR,
  });
}

export type ToolHint = { readonly name: string; readonly installLink: string };

export function noToolsError(tools: ReadonlyArray<ToolHint>): RosterError {
  const links = tools.map((t) => `  ${t.name.padEnd(12)} ${t.installLink}`).join('\n');
  return new RosterError({
    header: `${chalk.red.bold('roster:')} no AI tools detected on this machine`,
    body: 'Install at least one of:\n' + links,
    remedy: `Re-run ${chalk.bold('roster install')} after installing one.`,
    exitCode: EXIT_NO_TOOLS,
  });
}

export function invalidFunctionError(fn: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} unknown function ${chalk.yellow(`'${fn}'`)}`,
    body: `  No roster/${fn}/ directory exists in this workspace.`,
    remedy: `  Run ${chalk.bold('roster review')} with no argument to walk all functions.`,
    exitCode: EXIT_ERROR,
  });
}

export function notTtyForReviewError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} review requires an interactive terminal`,
    body: '  Stdout is not a TTY (running under a pipe, CI, or non-interactive shell).',
    remedy: `  Pass ${chalk.bold('--json')} to list pending items without prompting.`,
    exitCode: EXIT_ERROR,
  });
}

export function missingScaffoldError(scaffoldPath: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} scaffold templates missing`,
    body: `  Expected at ${scaffoldPath}`,
    remedy: '  This roster install is broken — reinstall with: npm install -g @firatcand/roster',
    exitCode: EXIT_ERROR,
  });
}

export function userCancelledInit(): RosterError {
  return new RosterError({
    header: `${chalk.dim('roster:')} cancelled`,
    body: '  Nothing written.',
    remedy: '  Re-run with --force to overwrite an existing CLAUDE.md.',
    exitCode: EXIT_CANCELLED,
  });
}

export function userCancelledInstall(): RosterError {
  return new RosterError({
    header: `${chalk.dim('roster:')} cancelled`,
    body: '  Nothing written.',
    remedy: `  Re-run ${chalk.bold('roster install')} when ready.`,
    exitCode: EXIT_CANCELLED,
  });
}

export function linuxClaudeUnsupportedError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} Claude Desktop scheduling is not available on Linux`,
    body: [
      '  ADR-0001: Linux Claude has no Desktop Scheduled Tasks surface',
      '  (the Schedule sidebar is macOS/Windows-only).',
    ].join('\n'),
    remedy: [
      `  Either:`,
      `    - Use ${chalk.bold('--tool codex')} (Codex supports Linux via codex exec cron), or`,
      `    - Pass ${chalk.bold('--cloud-routine')} to use Anthropic Cloud Routines (requires GitHub-connected workspace).`,
    ].join('\n'),
    exitCode: EXIT_ERROR,
  });
}

export function cloudRoutineNotImplementedError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} --cloud-routine is not yet implemented`,
    body: [
      '  The Cloud Routine install path (Anthropic-hosted, GitHub-connected) is',
      '  reserved for a follow-up ADR. ROS-34 ships local Desktop hand-off only.',
    ].join('\n'),
    remedy: `  Use ${chalk.bold('--tool codex')} on Linux, or run roster on macOS/Windows.`,
    exitCode: EXIT_ERROR,
  });
}

export type ToolForViaError = { tool: string; via: string };

export function unsupportedViaModeError(args: ToolForViaError): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} --via ${args.via} is not supported with --tool ${args.tool}`,
    body: `  Only ${chalk.bold('--tool codex')} supports ${chalk.bold(`--via ${args.via}`)} mode.`,
    remedy: `  Drop the ${chalk.bold(`--via ${args.via}`)} flag (Claude uses UI hand-off via ${chalk.bold('--tool claude')}).`,
    exitCode: EXIT_ERROR,
  });
}

export function windowsCronNotSupportedError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} --via cron is not supported on Windows`,
    body: '  Windows has no POSIX cron daemon to install the scheduled line into.',
    remedy: `  Use the default mode (drop ${chalk.bold('--via cron')}) and create the Automation via the Codex desktop app instead.`,
    exitCode: EXIT_ERROR,
  });
}

export function linuxCodexHandoffUnsupportedError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} Codex desktop app is not available on Linux`,
    body: [
      '  The default install mode hands off a prompt to the Codex desktop app,',
      '  which only ships on macOS and Windows.',
    ].join('\n'),
    remedy: `  Add ${chalk.bold('--via cron')} to install the schedule via crontab instead.`,
    exitCode: EXIT_ERROR,
  });
}

// Forward declare for the codex-preflight import — defined inline below to
// avoid a circular import (codex-install imports errors; errors knows the
// preflight failure shape but does not import codex-preflight).
export type CodexPreflightFailureSummary = {
  check: string;
  actual: string;
  expected: string;
  remedy: string;
};

export function codexPreflightError(failures: CodexPreflightFailureSummary[]): RosterError {
  const bodyLines: string[] = ['  Subscription-safety preflight failed. Codex schedule install would otherwise risk per-token API billing.', ''];
  for (const f of failures) {
    bodyLines.push(`  - [${f.check}] expected ${f.expected}, got ${f.actual}`);
    bodyLines.push(`      → ${f.remedy}`);
  }
  return new RosterError({
    header: `${chalk.red.bold('roster:')} codex subscription-safety preflight failed (${failures.length} check${failures.length === 1 ? '' : 's'})`,
    body: bodyLines.join('\n'),
    remedy: '  Address each failure above and re-run. See docs/adr/0001-scheduling-architecture.md for context.',
    exitCode: EXIT_ERROR,
  });
}

export function migrateSourceNotFoundError(sourceDir: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} source directory not found`,
    body: `  ${sourceDir}`,
    remedy: `  Pass the path to your legacy agent-team workspace, e.g. ${chalk.bold('~/repos/agent-team')}.`,
    exitCode: EXIT_ERROR,
  });
}

export function migrateDestNotInitializedError(destDir: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} destination is not an initialized roster workspace`,
    body: [
      `  ${destDir}`,
      '  No CONTEXT.md or roster/ directory found.',
    ].join('\n'),
    remedy: [
      `  Run ${chalk.bold('roster init')} in the destination first, then re-run migrate.`,
      `  Or pass ${chalk.bold('--dest <other-dir>')} to point at an initialized workspace.`,
    ].join('\n'),
    exitCode: EXIT_ERROR,
  });
}

export function envPermissionTooOpenError(envPath: string, mode: number): RosterError {
  const octal = (mode & 0o777).toString(8).padStart(3, '0');
  return new RosterError({
    header: `${chalk.red.bold('roster:')} source .env permissions are too open`,
    body: [
      `  ${envPath} is mode 0${octal}; roster requires 0600 before copying secrets.`,
      '  ADR-0001 § Secrets handling — do not silently downgrade or upgrade.',
    ].join('\n'),
    remedy: [
      `  Run:  ${chalk.bold(`chmod 600 ${envPath}`)}`,
      `  Then re-run the migrate command.`,
    ].join('\n'),
    exitCode: EXIT_ERROR,
  });
}

export function migrateSourceAlreadyRosterError(sourceDir: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} source directory looks like a roster workspace`,
    body: [
      `  ${sourceDir} contains CONTEXT.md or roster/.`,
      '  This command migrates a legacy agent-team workspace, not a roster one.',
    ].join('\n'),
    remedy: '  Point --dest at the source dir if you meant to operate in-place; otherwise re-check the path.',
    exitCode: EXIT_ERROR,
  });
}

export function scheduleNotFoundError(name: string, knownNames: ReadonlyArray<string>): RosterError {
  const body =
    knownNames.length === 0
      ? '  No schedules are registered in this workspace.'
      : '  Known schedules:\n' + knownNames.map((n) => `    - ${n}`).join('\n');
  return new RosterError({
    header: `${chalk.red.bold('roster:')} schedule ${chalk.yellow(`'${name}'`)} not found`,
    body,
    remedy: `  Run ${chalk.bold('roster schedule list')} to see all registered schedules.`,
    exitCode: EXIT_ERROR,
  });
}

export function scheduleNotInFunctionError(
  name: string,
  filterFn: string,
  foundInFns: ReadonlyArray<string>,
): RosterError {
  const fnList = foundInFns.map((f) => chalk.bold(f)).join(', ');
  return new RosterError({
    header: `${chalk.red.bold('roster:')} schedule ${chalk.yellow(`'${name}'`)} not found in function '${filterFn}'`,
    body: `  But it does exist in: ${fnList}`,
    remedy:
      foundInFns.length === 1
        ? `  Drop ${chalk.bold(`--function ${filterFn}`)}, or use ${chalk.bold(`--function ${foundInFns[0]}`)}.`
        : `  Drop ${chalk.bold(`--function ${filterFn}`)}, or pick one of: --function ${foundInFns.join(' | --function ')}.`,
    exitCode: EXIT_ERROR,
  });
}

export function scheduleAmbiguousError(name: string, functions: ReadonlyArray<string>): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} schedule name ${chalk.yellow(`'${name}'`)} is ambiguous`,
    body:
      '  Matches an entry in multiple functions:\n' +
      functions.map((f) => `    - roster/${f}/schedules.yaml`).join('\n'),
    remedy: `  Pass ${chalk.bold('--function <name>')} to disambiguate.`,
    exitCode: EXIT_ERROR,
  });
}

export function userCancelledRemove(): RosterError {
  return new RosterError({
    header: `${chalk.dim('roster:')} cancelled`,
    body: '  Nothing removed.',
    remedy: `  Re-run with ${chalk.bold('--yes')} to skip the confirmation prompt.`,
    exitCode: EXIT_CANCELLED,
  });
}

export function unexpectedError(err: unknown): RosterError {
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new RosterError({
    header: `${chalk.red.bold('roster:')} unexpected error`,
    body: `  ${message}`,
    remedy: '  Re-run with --debug for a full stack trace.',
    exitCode: EXIT_ERROR,
  });
  if (err instanceof Error && err.stack) {
    // Splice the original error's frames under the wrapper's own header line so
    // --debug doesn't print "Error: <message>" twice (once from body, once from
    // the original stack's preamble).
    const wrapperHeader = wrapped.stack?.split('\n', 1)[0] ?? `RosterError: ${message}`;
    const originalFrames = err.stack.replace(/^[^\n]*\n?/, '');
    wrapped.stack = originalFrames ? `${wrapperHeader}\n${originalFrames}` : wrapperHeader;
  }
  return wrapped;
}

export type RenderOptions = {
  debug: boolean;
  stream?: NodeJS.WritableStream;
};

export function renderError(err: RosterError, opts: RenderOptions): void {
  const out = opts.stream ?? process.stderr;
  out.write(err.header + '\n');
  if (err.body) out.write(err.body + '\n');
  out.write(err.remedy + '\n');
  if (opts.debug && err.stack) {
    out.write(err.stack + '\n');
  }
}

export { isRosterError };
