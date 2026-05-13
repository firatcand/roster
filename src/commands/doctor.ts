import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditTool, type ItemStatus, type ToolAuditResult } from '../lib/audit.ts';
import { detectTools } from '../lib/tools.ts';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';

export type DoctorOptions = {
  json: boolean;
  silent: boolean;
};

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_TOOLS = 3;

type Summary = { ok: number; missing: number; stale: number };

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function icon(status: ItemStatus): string {
  if (status === 'ok') return chalk.green('✓');
  if (status === 'missing') return chalk.red('✗');
  return chalk.yellow('!');
}

function label(status: ItemStatus): string {
  if (status === 'ok') return chalk.dim('OK');
  if (status === 'missing') return chalk.red('MISSING');
  return chalk.yellow('STALE');
}

function computeSummary(results: ToolAuditResult[]): Summary {
  const s: Summary = { ok: 0, missing: 0, stale: 0 };
  for (const r of results) for (const item of r.items) s[item.status]++;
  return s;
}

function renderText(results: ToolAuditResult[], summary: Summary): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster doctor'));
  for (const r of results) {
    lines.push('');
    lines.push(`${chalk.bold(r.toolName)} ${chalk.dim(tildify(r.configRoot))}`);
    for (const item of r.items) {
      const kindCol = chalk.dim(item.kind.padEnd(5));
      const nameCol = item.name.padEnd(22);
      const detail = item.status !== 'ok' && item.reason ? chalk.dim(` (${item.reason})`) : '';
      lines.push(`  ${icon(item.status)} ${kindCol} ${nameCol} ${label(item.status)}${detail}`.trimEnd());
    }
  }
  lines.push('');
  if (summary.missing === 0 && summary.stale === 0) {
    lines.push(chalk.green('All installed skills and agents are up to date.'));
  } else {
    const bits: string[] = [];
    if (summary.missing > 0) bits.push(`${summary.missing} missing`);
    if (summary.stale > 0) bits.push(`${summary.stale} stale`);
    const toolWord = results.length === 1 ? 'tool' : 'tools';
    lines.push(chalk.yellow(`Summary: ${bits.join(', ')} across ${results.length} ${toolWord}.`));
    lines.push(`${chalk.dim('Run ')}${chalk.bold('roster install')}${chalk.dim(' to repair.')}`);
  }
  return lines;
}

export function executeDoctor(opts: DoctorOptions): number {
  const detected = detectTools();
  const sources = {
    skills: join(ROSTER_ROOT, 'skills'),
    agents: join(ROSTER_ROOT, 'agents'),
  };

  if (detected.length === 0) {
    if (opts.json) {
      const payload = {
        ok: true,
        rosterVersion: getPackageVersion(),
        tools: [],
        summary: { ok: 0, missing: 0, stale: 0 },
        note: 'no tools detected',
      };
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(`${chalk.red.bold('roster:')} no AI tools detected on this machine.`);
      console.error('');
      console.error('Install Claude Code, Codex CLI, or Gemini CLI, then re-run.');
    }
    return EXIT_NO_TOOLS;
  }

  const results = detected.map((t) => auditTool(t, sources));
  const summary = computeSummary(results);
  const allOk = results.every((r) => r.ok);

  if (opts.json) {
    const payload = {
      ok: allOk,
      rosterVersion: getPackageVersion(),
      tools: results,
      summary,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(results, summary)) console.log(line);
  }

  return allOk ? EXIT_OK : EXIT_ERROR;
}
