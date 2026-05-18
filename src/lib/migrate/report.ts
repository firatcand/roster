import { relative } from 'node:path';
import chalk from 'chalk';
import type { MigrationPlan } from './plan.ts';
import type { ExecuteReport, FileOpResult } from './execute.ts';

export type RenderOpts = {
  dryRun: boolean;
  /** When true, suppress absolute paths that include a timestamp (snapshot mode). */
  stableForSnapshot?: boolean;
};

function modeOctal(mode: number): string {
  return '0' + (mode & 0o777).toString(8).padStart(3, '0');
}

function renderEnvCopy(plan: MigrationPlan): string {
  if (plan.envCopy === null) return '';
  return `${chalk.green('✓')} .env → ${plan.envCopy.dest} (mode ${modeOctal(plan.envCopy.targetMode)})`;
}

function renderBlockers(plan: MigrationPlan): string[] {
  if (plan.blockers.length === 0) return [];
  const out: string[] = ['', chalk.red.bold('Blockers (must resolve before migration runs):')];
  for (const b of plan.blockers) {
    if (b.kind === 'env-too-open') {
      out.push(`  ${chalk.red('✗')} .env at ${b.envPath} has mode ${modeOctal(b.mode)} (must be 0600).`);
      out.push(`     Run: ${chalk.bold(`chmod 600 ${b.envPath}`)}`);
    } else if (b.kind === 'dest-not-initialized') {
      out.push(`  ${chalk.red('✗')} destination ${b.destDir} is not an initialized roster workspace.`);
      out.push(`     Run: ${chalk.bold('roster init')} in the destination, then re-run migrate.`);
    } else if (b.kind === 'source-is-roster') {
      out.push(`  ${chalk.red('✗')} source ${b.sourceDir} looks like a roster workspace (not agent-team).`);
    }
  }
  return out;
}

function renderSchedules(plan: MigrationPlan): string[] {
  const out: string[] = [];
  out.push('');
  out.push(chalk.bold(`Schedules discovered (${plan.scheduleInstalls.length}):`));
  for (const s of plan.scheduleInstalls) {
    out.push(`  ${chalk.green('✓')} ${s.function}/${s.agent}/${s.plan} @ "${s.cron}"  → --tool ${s.tool}`);
  }
  if (plan.unmappedWrappers.length > 0) {
    out.push('');
    out.push(chalk.yellow(`Unmapped wrappers (${plan.unmappedWrappers.length}):`));
    for (const u of plan.unmappedWrappers) {
      out.push(`  ${chalk.yellow('?')} ${u.basename}  (cron: ${u.cron})`);
    }
  }
  return out;
}

function renderPending(plan: MigrationPlan): string[] {
  if (plan.pendingMoves.length === 0) return [];
  const out: string[] = ['', chalk.bold(`Pending HITL (${plan.pendingMoves.length}):`)];
  for (const m of plan.pendingMoves) {
    out.push(`  → roster/${m.destFunction}/pending/${m.destPath.split('/').pop()}`);
  }
  return out;
}

function renderLogs(plan: MigrationPlan): string[] {
  const totalFiles = plan.logCopies.reduce((acc, lc) => acc + lc.files.length, 0);
  if (totalFiles === 0) return ['', chalk.dim('Run logs: 0 files in 0 month-dirs.')];
  return ['', chalk.bold(`Run logs: ${totalFiles} files in ${plan.logCopies.length} month-dirs.`)];
}

function renderSubscriptionWarnings(plan: MigrationPlan): string[] {
  if (plan.subscriptionWarnings.length === 0) return [];
  const out: string[] = ['', chalk.red.bold(`⚠ Subscription-safety violations in source wrappers (${plan.subscriptionWarnings.length}):`)];
  out.push(chalk.dim('   ADR-0001 bans `claude -p` in cron — drains Agent SDK credit, not the interactive subscription.'));
  for (const w of plan.subscriptionWarnings) {
    out.push(`   ${chalk.red('-')} ${w.wrapperPath} contains '${w.pattern}'`);
  }
  out.push(chalk.dim('   Migrated schedules use native desktop scheduling (Claude Scheduled Tasks / Codex Automations);'));
  out.push(chalk.dim('   the migration itself replaces the banned invocation. Source wrappers are not copied.'));
  return out;
}

function renderAgentMdNotes(plan: MigrationPlan): string[] {
  if (plan.agentMdNotes.length === 0) return [];
  const out: string[] = ['', chalk.bold(`agent.md files in source (${plan.agentMdNotes.length}, not copied):`)];
  for (const n of plan.agentMdNotes) {
    out.push(`  ${chalk.dim('-')} ${n.agentDirRel}/agent.md`);
  }
  out.push(chalk.dim('   Roster gets agents from installed skills. Customizations won\'t migrate — re-create as project-local overlays.'));
  return out;
}

function renderManualSteps(plan: MigrationPlan): string[] {
  if (plan.manualSteps.length === 0) return [];
  const out: string[] = ['', chalk.bold('Manual steps remaining:')];
  for (let i = 0; i < plan.manualSteps.length; i++) {
    const s = plan.manualSteps[i]!;
    out.push(`  ${i + 1}. ${s.description}`);
    if (s.commandHint) out.push(`       ${chalk.dim(s.commandHint)}`);
  }
  return out;
}

function renderFileResults(report: ExecuteReport, plan: MigrationPlan, opts: RenderOpts): string[] {
  if (report.fileResults.length === 0) return [];
  const out: string[] = [];
  const written = report.fileResults.filter((r) => r.kind === 'written').length;
  const noop = report.fileResults.filter((r) => r.kind === 'noop').length;
  const skipped = report.fileResults.filter((r) => r.kind === 'skipped').length;
  const collided = report.fileResults.filter((r) => r.kind === 'collided-renamed').length;
  out.push('');
  out.push(chalk.bold('File operations:'));
  out.push(`  written: ${written}  noop: ${noop}  skipped: ${skipped}  collisions: ${collided}`);
  // Surface skipped and collided with reasons (the interesting ones for the user)
  for (const r of report.fileResults) {
    if (r.kind === 'skipped') {
      const rel = opts.stableForSnapshot ? relative(plan.destWorkspace, r.dest) : r.dest;
      out.push(`  ${chalk.yellow('⏭')} ${rel} — ${r.reason}`);
    } else if (r.kind === 'collided-renamed') {
      const collidedResult = r as Extract<FileOpResult, { kind: 'collided-renamed' }>;
      const relFinal = opts.stableForSnapshot ? relative(plan.destWorkspace, collidedResult.finalDest) : collidedResult.finalDest;
      out.push(`  ${chalk.yellow('↻')} collision → ${relFinal}`);
    }
  }
  return out;
}

function stripTimestampedPaths(text: string): string {
  return text
    .replace(/\.roster\/migration-scripts\/install-schedules-[0-9-]+\.sh/g, '.roster/migration-scripts/install-schedules-<ts>.sh')
    .replace(/\.roster\/migration-reports\/agent-team-[0-9-]+\.md/g, '.roster/migration-reports/agent-team-<ts>.md');
}

export function renderTextReport(plan: MigrationPlan, exec: ExecuteReport | null, opts: RenderOpts): string {
  const lines: string[] = [];
  const header = opts.dryRun
    ? `${chalk.cyan.bold('roster migrate from-agent-team')} ${chalk.dim('(dry-run)')}`
    : `${chalk.cyan.bold('roster migrate from-agent-team')}`;
  lines.push('');
  lines.push(header);
  lines.push(`  Source: ${plan.sourceDir}`);
  lines.push(`  Destination: ${plan.destWorkspace}`);

  lines.push(...renderBlockers(plan));
  if (plan.blockers.length > 0) {
    // Stop short — the rest of the plan won't execute.
    lines.push('');
    return finalize(lines.join('\n'), opts);
  }

  lines.push(...renderSchedules(plan));
  lines.push(...renderPending(plan));
  lines.push(...renderLogs(plan));

  const envLine = renderEnvCopy(plan);
  if (envLine) {
    lines.push('');
    lines.push(envLine);
  }

  lines.push(...renderSubscriptionWarnings(plan));
  lines.push(...renderAgentMdNotes(plan));

  if (exec !== null && !opts.dryRun) {
    lines.push(...renderFileResults(exec, plan, opts));
    if (exec.installScriptPath !== null) {
      lines.push('');
      lines.push(chalk.bold('Generated install script:'));
      lines.push(`  ${exec.installScriptPath}`);
      lines.push(chalk.dim(`  Review, then run: bash ${exec.installScriptPath}`));
    }
    if (exec.manifestPath !== null) {
      lines.push('');
      lines.push(chalk.dim(`Manifest: ${exec.manifestPath}`));
    }
  }

  lines.push(...renderManualSteps(plan));
  lines.push('');
  return finalize(lines.join('\n'), opts);
}

function finalize(text: string, opts: RenderOpts): string {
  return opts.stableForSnapshot ? stripTimestampedPaths(text) : text;
}

export function renderMarkdownReport(plan: MigrationPlan, exec: ExecuteReport | null, opts: RenderOpts): string {
  // Strip chalk so the markdown is readable when written to disk.
  const ansiRe = /\x1b\[[0-9;]*m/g;
  return renderTextReport(plan, exec, opts).replace(ansiRe, '');
}
