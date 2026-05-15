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
