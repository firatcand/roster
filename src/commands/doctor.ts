import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditTool, type ItemStatus, type ToolAuditResult } from '../lib/audit.ts';
import { detectTools } from '../lib/tools.ts';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';
import { EXIT_OK, EXIT_ERROR, EXIT_NO_TOOLS } from '../lib/errors.ts';
import { auditWorkspace, type WorkspaceAuditResult, type SymlinkStatus } from '../lib/project-context.ts';

export type DoctorOptions = {
  json: boolean;
  silent: boolean;
  cwd: string;
};

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

function workspaceIcon(status: SymlinkStatus): string {
  if (status === 'ok') return chalk.green('✓');
  return chalk.red('✗');
}

function workspaceLabel(status: SymlinkStatus): string {
  switch (status) {
    case 'ok': return chalk.dim('OK');
    case 'missing': return chalk.red('MISSING');
    case 'wrong-target': return chalk.red('WRONG TARGET');
    case 'not-a-symlink': return chalk.yellow('NOT A SYMLINK');
    case 'content-diverged': return chalk.yellow('CONTENT DIVERGED');
    case 'is-directory': return chalk.red('IS DIRECTORY');
    case 'unreadable': return chalk.red('UNREADABLE');
  }
}

function renderWorkspaceSection(audit: WorkspaceAuditResult): string[] {
  if (!audit.contextMdExists && audit.items.length === 0) return [];

  const lines: string[] = [''];
  lines.push(`Workspace  ${tildify(audit.cwd)}`);

  if (audit.contextMdExists) {
    lines.push(`  ${chalk.green('✓')} CONTEXT.md   ${chalk.dim('present')}`);
  } else {
    lines.push(`  ${chalk.red('✗')} CONTEXT.md   ${chalk.red('MISSING')}`);
  }

  for (const item of audit.items) {
    const nameCol = item.name.padEnd(12);
    const detail = item.reason ? chalk.dim(` (${item.reason})`) : '';
    lines.push(`  ${workspaceIcon(item.status)} ${nameCol} ${workspaceLabel(item.status)}${detail}`.trimEnd());
  }

  for (const w of audit.warnings) {
    lines.push(`  ${chalk.yellow('!')} ${w}`);
  }

  return lines;
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

  const workspace = auditWorkspace(opts.cwd);

  if (detected.length === 0) {
    if (opts.json) {
      const payload = {
        ok: true,
        rosterVersion: getPackageVersion(),
        tools: [],
        summary: { ok: 0, missing: 0, stale: 0 },
        workspace,
        note: 'no tools detected',
      };
      console.log(JSON.stringify(payload, null, 2));
    }
    // Non-JSON: runner (runDoctor in roster.ts) renders the structured error.
    return EXIT_NO_TOOLS;
  }

  const results = detected.map((t) => auditTool(t, sources));
  const summary = computeSummary(results);
  const allOk = results.every((r) => r.ok) && workspace.ok;

  if (opts.json) {
    const payload = {
      ok: allOk,
      rosterVersion: getPackageVersion(),
      tools: results,
      summary,
      workspace,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(results, summary)) console.log(line);
    for (const line of renderWorkspaceSection(workspace)) console.log(line);
  }

  return allOk ? EXIT_OK : EXIT_ERROR;
}
