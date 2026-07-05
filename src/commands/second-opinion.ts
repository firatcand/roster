import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import chalk from 'chalk';
import type { ToolKey } from '../lib/tools.ts';
import { RosterError, EXIT_OK, EXIT_ERROR } from '../lib/errors.ts';
import {
  runSecondOpinion,
  type ArtifactInput,
  type RunSecondOpinionOpts,
  type RunSecondOpinionResult,
} from '../lib/second-opinion/run.ts';
import type { Severity } from '../lib/second-opinion/schema.ts';

type GitDiffResult = { ok: true; diff: string } | { ok: false; message: string };

export type ExecuteSecondOpinionOpts = {
  files: string[];
  host?: ToolKey;
  message?: string;
  stdin: boolean;
  diff?: string;
  timeoutSec: number;
  json: boolean;
  cwd?: string;
  // Test seams.
  runFn?: (opts: RunSecondOpinionOpts) => Promise<RunSecondOpinionResult>;
  readStdin?: () => Promise<string>;
  gitDiff?: (ref: string, cwd: string) => GitDiffResult;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  installedHosts?: ToolKey[];
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function defaultGitDiff(ref: string, cwd: string): GitDiffResult {
  const r = spawnSync('git', ['diff', ref], { encoding: 'utf8', cwd, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    const err = (r.stderr ?? '').trim();
    return { ok: false, message: err.length > 0 ? err : `git diff ${ref} failed` };
  }
  return { ok: true, diff: r.stdout ?? '' };
}

function inputError(message: string, remedy: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} ${message}`,
    body: '',
    remedy: `  ${remedy}`,
    exitCode: EXIT_ERROR,
  });
}

async function gatherInputs(opts: ExecuteSecondOpinionOpts, cwd: string): Promise<ArtifactInput[]> {
  const inputs: ArtifactInput[] = [];

  for (const file of opts.files) {
    const abs = resolve(cwd, file);
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      throw inputError(`cannot read ${file} (${e.code ?? 'unknown'})`, 'Check the path and permissions, then retry.');
    }
    inputs.push({ label: file, content });
  }

  if (opts.stdin) {
    const reader = opts.readStdin ?? readAllStdin;
    const content = await reader();
    if (content.trim().length === 0) {
      throw inputError('--stdin given but no data arrived on stdin', 'Pipe the artifact in: `cat draft.md | roster second-opinion --stdin`.');
    }
    inputs.push({ label: 'stdin', content });
  }

  if (opts.diff !== undefined) {
    const differ = opts.gitDiff ?? defaultGitDiff;
    const r = differ(opts.diff, cwd);
    if (!r.ok) {
      throw inputError(`--diff failed: ${r.message}`, 'Run from inside a git repository with a valid ref.');
    }
    if (r.diff.trim().length === 0) {
      throw inputError(`git diff ${opts.diff} produced no changes`, 'Nothing to review — commit or edit something first, or pass a different ref.');
    }
    inputs.push({ label: `git diff ${opts.diff}`, content: r.diff });
  }

  return inputs;
}

const SEVERITY_ORDER: readonly Severity[] = ['major', 'minor', 'nit', 'praise'];

const SEVERITY_STYLE: Record<Severity, (s: string) => string> = {
  major: (s) => chalk.red.bold(s),
  minor: (s) => chalk.yellow(s),
  nit: (s) => chalk.dim(s),
  praise: (s) => chalk.green(s),
};

function renderHuman(r: Extract<RunSecondOpinionResult, { ok: true }>): void {
  const { result } = r;
  console.log('');
  console.log(`${chalk.green('✓')} second opinion ${chalk.dim(`(host: ${result.host})`)}`);
  console.log('');

  if (!result.structured) {
    console.log(chalk.dim('The reviewer returned an unstructured response (no parseable verdict) — raw text below.'));
    console.log('');
    console.log(result.raw);
    console.log('');
    return;
  }

  if (result.summary.length > 0) {
    console.log(result.summary);
    console.log('');
  }

  for (const severity of SEVERITY_ORDER) {
    const group = result.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    console.log(SEVERITY_STYLE[severity](severity.toUpperCase()));
    for (const f of group) {
      const location = f.location !== undefined ? chalk.dim(` [${f.location}]`) : '';
      const confidence = f.confidence !== undefined ? chalk.dim(` (confidence ${f.confidence}/10)`) : '';
      console.log(`  • ${f.message}${location}${confidence}`);
    }
    console.log('');
  }

  if (result.findings.length === 0) {
    console.log(chalk.dim('No findings reported.'));
    console.log('');
  }
}

function renderFailureHuman(r: Extract<RunSecondOpinionResult, { ok: false }>): void {
  console.error('');
  console.error(`${chalk.red('✗')} second opinion failed ${chalk.dim(`(${r.code}${r.host !== undefined ? `, host: ${r.host}` : ''})`)}`);
  console.error(`  ${r.message}`);
  if (r.failures !== undefined && r.failures.length > 0) {
    console.error('');
    for (const f of r.failures) {
      console.error(`  ${chalk.red('✗')} ${f.check}: ${f.actual} ${chalk.dim(`(expected: ${f.expected})`)}`);
      console.error(`    ${chalk.dim(f.remedy)}`);
    }
  }
  console.error('');
}

export async function executeSecondOpinion(opts: ExecuteSecondOpinionOpts): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const inputs = await gatherInputs(opts, cwd);

  const runFn = opts.runFn ?? runSecondOpinion;
  const result = await runFn({
    inputs,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.message !== undefined ? { message: opts.message } : {}),
    timeoutSec: opts.timeoutSec,
    cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.installedHosts !== undefined ? { installedHosts: opts.installedHosts } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(
        JSON.stringify({
          ok: true,
          host: result.result.host,
          structured: result.result.structured,
          summary: result.result.summary,
          findings: result.result.findings,
          raw: result.result.raw,
        }),
      );
      return EXIT_OK;
    }
    console.log(
      JSON.stringify({
        ok: false,
        code: result.code,
        ...(result.host !== undefined ? { host: result.host } : {}),
        message: result.message,
        ...(result.failures !== undefined ? { failures: result.failures } : {}),
      }),
    );
    return EXIT_ERROR;
  }

  if (result.ok) {
    renderHuman(result);
    return EXIT_OK;
  }
  renderFailureHuman(result);
  return EXIT_ERROR;
}
