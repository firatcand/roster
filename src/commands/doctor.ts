import chalk from 'chalk';
import { chmodSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { auditTool, type ItemStatus, type ToolAuditResult } from '../lib/audit.ts';
import { detectTools, type ToolKey } from '../lib/tools.ts';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';
import { EXIT_OK, EXIT_ERROR, EXIT_NO_TOOLS } from '../lib/errors.ts';
import { auditWorkspace, type WorkspaceAuditResult, type SymlinkStatus } from '../lib/project-context.ts';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import {
  auditEnvPermissions,
  runSecretsAudit,
  type EnvPermissionsResult,
  type SecretsAuditResult,
} from '../lib/doctor-secrets-audit.ts';
import { runSafetyAudit, type SafetyAuditResult } from '../lib/doctor-safety-audit.ts';
import {
  runSchedulingDriftAudit,
  type SchedulingDriftAuditResult,
} from '../lib/doctor-scheduling-drift.ts';
import { scheduleFileSchema } from '../lib/schedule-schema.ts';
import { isWindows } from '../lib/platform.ts';

export type DoctorOptions = {
  json: boolean;
  silent: boolean;
  fix: boolean;
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

// =====================================================================
// --fix execution (Step 5)
// =====================================================================
//
// Fixes are limited to two reversible, non-security-sensitive operations:
//   1. Relink broken/missing/wrong-target CLAUDE.md / AGENTS.md symlinks (POSIX)
//   2. chmod 0600 on .env (POSIX)
//
// Subscription-safety + secrets-leak findings are NEVER auto-fixed. A future
// "helpful" change that adds env-var unset to --fix would let a tampering
// user silently dodge billing-safety checks; a regression test in
// cli-doctor.test.ts guards this contract.

export type FixOutcome = {
  applied: boolean; // false when --fix was not requested; true when runFixes() ran
  fixed: string[];
  failed: Array<{ what: string; error: string }>;
};

export const NO_FIX_REQUESTED: FixOutcome = Object.freeze({
  applied: false,
  fixed: [],
  failed: [],
}) as FixOutcome;

export function runFixes(
  cwd: string,
  workspace: WorkspaceAuditResult,
  envPerms: EnvPermissionsResult,
): FixOutcome {
  const fixed: string[] = [];
  const failed: Array<{ what: string; error: string }> = [];
  const applied = true;

  // Symlink fixes — POSIX only. On Windows, CLAUDE.md/AGENTS.md are dual-write
  // regular files; auto-resyncing those is out of scope for ROS-38 and would
  // overwrite user edits silently.
  if (!isWindows()) {
    for (const item of workspace.items) {
      if (item.status === 'ok') continue;
      // Statuses we can safely repair via relink.
      const repairable: SymlinkStatus[] = ['missing', 'wrong-target', 'not-a-symlink'];
      if (!repairable.includes(item.status)) continue;

      const linkPath = join(cwd, item.name);
      try {
        if (item.status !== 'missing') {
          unlinkSync(linkPath);
        }
        symlinkSync('CONTEXT.md', linkPath);
        fixed.push(`${item.name}: relinked → CONTEXT.md`);
      } catch (err) {
        failed.push({ what: item.name, error: (err as Error).message });
      }
    }
  }

  // .env permissions fix
  if (envPerms.status === 'fail' && envPerms.autoFixable) {
    try {
      chmodSync(envPerms.path, 0o600);
      fixed.push('.env: chmod 0600');
    } catch (err) {
      failed.push({ what: '.env', error: (err as Error).message });
    }
  }

  return { applied, fixed, failed };
}

function renderFixSection(outcome: FixOutcome): string[] {
  if (!outcome.applied) return [];
  if (outcome.fixed.length === 0 && outcome.failed.length === 0) return [];
  const lines: string[] = [''];
  lines.push(chalk.bold('--fix applied'));
  for (const f of outcome.fixed) {
    lines.push(`  ${chalk.green('✓')} ${f}`);
  }
  for (const f of outcome.failed) {
    lines.push(`  ${chalk.red('✗')} ${f.what}: ${f.error}`);
  }
  return lines;
}

// Lightweight loader for prompt-leak audit. Yields {name, tool} pairs from
// every valid schedules.yaml in the workspace, ignoring malformed files
// (already surfaced by validateSchedulesInCwd in the Scheduling section).
function listAllScheduleEntries(cwd: string): Array<{ name: string; tool: 'claude' | 'codex' }> {
  const root = join(cwd, 'roster');
  let fns: string[];
  try {
    fns = readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ name: string; tool: 'claude' | 'codex' }> = [];
  for (const fn of fns) {
    const fnDir = join(root, fn);
    let st: Stats;
    try {
      st = statSync(fnDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const schedulesPath = join(fnDir, 'schedules.yaml');
    let raw: string;
    try {
      raw = readFileSync(schedulesPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }
    const valid = scheduleFileSchema.safeParse(parsed);
    if (!valid.success) continue;
    for (const entry of valid.data.schedules) {
      out.push({ name: entry.name, tool: entry.tool });
    }
  }
  return out;
}

function renderSafetySection(audit: SafetyAuditResult): string[] {
  const banned = audit.bannedPatterns;
  const codex = audit.codexPreflight;
  if (banned.status === 'ok' && (codex.status === 'ok' || codex.status === 'skipped')) {
    return [];
  }

  const lines: string[] = [''];
  lines.push(chalk.bold('Subscription safety'));

  if (banned.status === 'fail') {
    lines.push(`  ${chalk.red('✗')} banned-patterns   ${chalk.red('BANNED')} ${chalk.dim(`(${banned.violations.length} hit${banned.violations.length === 1 ? '' : 's'})`)}`);
    for (const v of banned.violations.slice(0, 10)) {
      lines.push(`      ${chalk.red('-')} ${chalk.dim(v.file + ':' + v.line)} [${v.ruleId}] ${v.preview}`);
    }
    if (banned.violations.length > 10) {
      lines.push(`      ${chalk.dim(`… (${banned.violations.length - 10} more)`)}`);
    }
  } else {
    lines.push(`  ${chalk.green('✓')} banned-patterns   ${chalk.dim('OK')}`);
  }

  if (codex.status === 'fail') {
    lines.push(`  ${chalk.red('✗')} codex-preflight   ${chalk.red('FAIL')} ${chalk.dim(`(${codex.failures.length} check${codex.failures.length === 1 ? '' : 's'})`)}`);
    for (const f of codex.failures) {
      lines.push(`      ${chalk.red('-')} [${f.check}] expected ${f.expected}, got ${f.actual}`);
      lines.push(`        ${chalk.dim('→ ')}${f.remedy}`);
    }
  } else if (codex.status === 'ok') {
    lines.push(`  ${chalk.green('✓')} codex-preflight   ${chalk.dim('OK')}`);
  }

  return lines;
}

function renderSecretsSection(audit: SecretsAuditResult): string[] {
  const env = audit.envPermissions;
  const refs = audit.envKeyReferences;
  const templates = audit.templateSecretLiterals;
  const leak = audit.promptLeak;

  // Skip rendering when there's nothing to show.
  const noEnv = env.status === 'absent' || env.status === 'skip-platform';
  const allClean = noEnv && refs.status === 'ok' && templates.status === 'ok' && leak.status === 'ok';
  if (allClean) return [];

  const lines: string[] = [''];
  lines.push(chalk.bold('Secrets'));

  if (env.status === 'ok') {
    lines.push(`  ${chalk.green('✓')} .env permissions  ${chalk.dim('OK')} ${chalk.dim(`(${env.mode})`)}`);
  } else if (env.status === 'fail') {
    lines.push(`  ${chalk.red('✗')} .env permissions  ${chalk.red('FAIL')} ${chalk.dim(`(got ${env.mode}, expected ${env.expected})`)}`);
    lines.push(`      ${chalk.dim('→ Run `roster doctor --fix` to chmod 0600.')}`);
  } else if (env.status === 'skip-platform') {
    lines.push(`  ${chalk.dim('-')} .env permissions  ${chalk.dim('SKIPPED')} ${chalk.dim('(windows mode bits not portable)')}`);
  }

  if (refs.status === 'fail') {
    lines.push(`  ${chalk.red('✗')} env-key refs       ${chalk.red('FAIL')} ${chalk.dim(`(${refs.missing.length} unreferenced)`)}`);
    for (const m of refs.missing.slice(0, 10)) {
      const ref = m.references[0]!;
      lines.push(`      ${chalk.red('-')} ${m.key} ${chalk.dim(`(referenced in ${ref.file}:${ref.line})`)}`);
    }
  }

  if (templates.status === 'fail') {
    lines.push(`  ${chalk.red('✗')} template literals  ${chalk.red('FAIL')} ${chalk.dim(`(${templates.hits.length} hit${templates.hits.length === 1 ? '' : 's'})`)}`);
    for (const h of templates.hits.slice(0, 10)) {
      lines.push(`      ${chalk.red('-')} ${chalk.dim(h.file + ':' + h.line)} [${h.patternId}] ${h.snippet}`);
    }
  }

  if (leak.status === 'warn') {
    lines.push(`  ${chalk.yellow('!')} prompt-leak       ${chalk.yellow('WARN')} ${chalk.dim(`(${leak.items.length} reference${leak.items.length === 1 ? '' : 's'})`)}`);
    for (const item of leak.items.slice(0, 5)) {
      lines.push(`      ${chalk.yellow('-')} ${item.schedule}: ${item.reference} ${chalk.dim('in ' + item.file + ':' + item.line)}`);
    }
  }

  return lines;
}

function renderSchedulingDriftSection(audit: SchedulingDriftAuditResult): string[] {
  const drift = audit.cronDrift;
  const alt = audit.altSkillPath;
  const anyDrift = drift.items.length > 0 || drift.status === 'unreadable-crontab';
  const anyAltWarn = alt.status === 'warn';
  if (!anyDrift && !anyAltWarn) return [];

  const lines: string[] = [''];
  lines.push(chalk.bold('Scheduling drift'));

  if (drift.status === 'unreadable-crontab') {
    lines.push(`  ${chalk.red('✗')} crontab            ${chalk.red('UNREADABLE')} ${chalk.dim(`(${drift.crontabReason ?? ''})`)}`);
  }

  for (const item of drift.items) {
    if (item.status === 'ok') {
      lines.push(`  ${chalk.green('✓')} ${item.name.padEnd(20)} ${chalk.dim('OK')}`);
      continue;
    }
    if (item.reason === 'registered-but-no-marker') {
      lines.push(`  ${chalk.red('✗')} ${item.name.padEnd(20)} ${chalk.red('DRIFT')} ${chalk.dim('(registered but no crontab marker)')}`);
    } else if (item.reason === 'cron-line-mismatch') {
      lines.push(`  ${chalk.red('✗')} ${item.name.padEnd(20)} ${chalk.red('DRIFT')} ${chalk.dim('(crontab line differs from expected)')}`);
    } else if (item.reason === 'orphan-marker-block') {
      lines.push(`  ${chalk.red('✗')} ${item.name.padEnd(20)} ${chalk.red('DRIFT')} ${chalk.dim('(orphan marker block, no registered entry)')}`);
    }
  }

  if (anyAltWarn) {
    for (const a of alt.items) {
      if (a.presence === 'only-alt-present') {
        lines.push(`  ${chalk.yellow('!')} alt-skill-path     ${chalk.yellow('WARN')} ${chalk.dim('(only ' + a.path + ' present; canonical missing)')}`);
      } else if (a.presence === 'content-diverged') {
        lines.push(`  ${chalk.yellow('!')} alt-skill-path     ${chalk.yellow('WARN')} ${chalk.dim('(' + a.path + ' diverges: ' + a.reason + ')')}`);
      }
    }
  }

  return lines;
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
  const home = homedir();

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

  // First-pass audits. If --fix is requested, run the (limited) auto-fix step,
  // then re-run the audits whose state may have changed so the final
  // workspace + secrets sections reflect post-fix reality.
  let workspaceFinal = workspace;
  const initialEnvPerms = auditEnvPermissions(opts.cwd);
  let fixOutcome: FixOutcome = NO_FIX_REQUESTED;

  if (opts.fix) {
    fixOutcome = runFixes(opts.cwd, workspace, initialEnvPerms);
    if (fixOutcome.fixed.length > 0) {
      workspaceFinal = auditWorkspace(opts.cwd);
    }
  }

  const schedulesForLeak = listAllScheduleEntries(opts.cwd);
  const safety = runSafetyAudit({
    rosterRoot: ROSTER_ROOT,
    toolAudits: results,
    detectedTools: detected,
    homeDir: home,
    env: process.env,
  });
  const secrets = runSecretsAudit({
    cwd: opts.cwd,
    rosterRoot: ROSTER_ROOT,
    schedules: schedulesForLeak,
  });
  const schedulingDrift = runSchedulingDriftAudit({
    cwd: opts.cwd,
    homeDir: home,
  });

  const allOk =
    results.every((r) => r.ok) &&
    workspaceFinal.ok &&
    scheduling.ok &&
    safety.ok &&
    secrets.ok &&
    schedulingDrift.ok;

  if (opts.json) {
    const payload = {
      ok: allOk,
      rosterVersion: getPackageVersion(),
      tools: results,
      summary,
      workspace: workspaceFinal,
      scheduling,
      workarounds,
      safety,
      secrets,
      scheduling_drift: schedulingDrift,
      fix: fixOutcome,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(results, summary, workarounds)) console.log(line);
    for (const line of renderWorkspaceSection(workspaceFinal)) console.log(line);
    for (const line of renderSchedulingSection(scheduling)) console.log(line);
    for (const line of renderSchedulingDriftSection(schedulingDrift)) console.log(line);
    for (const line of renderSafetySection(safety)) console.log(line);
    for (const line of renderSecretsSection(secrets)) console.log(line);
    for (const line of renderFixSection(fixOutcome)) console.log(line);
  }

  return allOk ? EXIT_OK : EXIT_ERROR;
}
