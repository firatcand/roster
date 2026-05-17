import chalk from 'chalk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { auditTool, type ItemStatus, type ToolAuditResult } from '../lib/audit.ts';
import { detectTools, type ToolKey } from '../lib/tools.ts';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';
import { EXIT_OK, EXIT_ERROR, EXIT_NO_TOOLS } from '../lib/errors.ts';
import { auditWorkspace, type WorkspaceAuditResult, type SymlinkStatus } from '../lib/project-context.ts';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import { isWindows } from '../lib/platform.ts';

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

function renderSchedulingSection(report: ValidationReport): string[] {
  if (report.files.length === 0) return [];
  const lines: string[] = [''];
  lines.push(`Scheduling  ${tildify(report.cwd)}`);
  for (const file of report.files) {
    if (file.status === 'pass') {
      const entryWord = file.entryCount === 1 ? 'entry' : 'entries';
      lines.push(`  ${chalk.green('✓')} ${file.relativePath}   ${chalk.dim('OK')} ${chalk.dim(`(${file.entryCount} ${entryWord})`)}`);
    } else {
      lines.push(`  ${chalk.red('✗')} ${file.relativePath}   ${chalk.red('FAIL')}`);
      for (const e of file.errors) {
        lines.push(`      ${chalk.red('-')} ${chalk.dim(e.path + ':')} ${e.message}`);
      }
    }
  }
  return lines;
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

// Platform-specific workaround notices surfaced in roster doctor.
//
// Currently:
//   - codex-windows-19399: Codex on Windows silently ignores subagent TOML
//     config. The roster-orchestrator skill (ROS-32) injects the agent persona
//     at runtime via `-c developer_instructions=…` reading <name>.persona.md
//     from ~/.codex/agents/. Remove this notice when openai/codex#19399 closes.
export type Workaround = {
  id: string;
  toolKey: ToolKey;
  status: 'active';
  summary: string;
  reference: string;
};

function computeWorkarounds(results: ToolAuditResult[]): Workaround[] {
  const workarounds: Workaround[] = [];
  if (isWindows() && results.some((r) => r.tool === 'codex')) {
    workarounds.push({
      id: 'codex-windows-19399',
      toolKey: 'codex',
      status: 'active',
      summary: 'Codex Windows TOML config ignored — runtime injection ACTIVE',
      reference: 'https://github.com/openai/codex/issues/19399',
    });
  }
  return workarounds;
}

function renderText(results: ToolAuditResult[], summary: Summary, workarounds: Workaround[]): string[] {
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
    for (const w of workarounds.filter((x) => x.toolKey === r.tool)) {
      lines.push(`  ${chalk.yellow('!')} ${chalk.dim('w/a  ')} ${w.id.padEnd(22)} ${chalk.yellow(w.summary)}`);
      lines.push(`        ${chalk.dim(w.reference)}`);
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
  const scheduling = validateSchedulesInCwd(opts.cwd);

  if (detected.length === 0) {
    if (opts.json) {
      const payload = {
        ok: scheduling.ok,
        rosterVersion: getPackageVersion(),
        tools: [],
        summary: { ok: 0, missing: 0, stale: 0 },
        workspace,
        scheduling,
        workarounds: [],
        note: 'no tools detected',
      };
      console.log(JSON.stringify(payload, null, 2));
    }
    // Non-JSON: runner (runDoctor in roster.ts) renders the structured error.
    return EXIT_NO_TOOLS;
  }

  const results = detected.map((t) => auditTool(t, sources));
  const summary = computeSummary(results);
  const workarounds = computeWorkarounds(results);
  const allOk = results.every((r) => r.ok) && workspace.ok && scheduling.ok;

  if (opts.json) {
    const payload = {
      ok: allOk,
      rosterVersion: getPackageVersion(),
      tools: results,
      summary,
      workspace,
      scheduling,
      workarounds,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(results, summary, workarounds)) console.log(line);
    for (const line of renderWorkspaceSection(workspace)) console.log(line);
    for (const line of renderSchedulingSection(scheduling)) console.log(line);
  }

  return allOk ? EXIT_OK : EXIT_ERROR;
}
