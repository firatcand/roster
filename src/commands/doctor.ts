import chalk from 'chalk';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { auditTool, type ItemStatus, type ToolAuditResult } from '../lib/audit.ts';
import { allTools, detectTools, type ToolKey } from '../lib/tools.ts';
import {
  detectWorkspace,
  defaultScopeForContext,
  toolForScope,
  type Scope,
} from '../lib/install-scope.ts';
import { ROSTER_ROOT, getPackageVersion } from '../lib/paths.ts';
import { EXIT_OK, EXIT_ERROR, EXIT_NO_TOOLS } from '../lib/errors.ts';
import { auditWorkspace, type WorkspaceAuditResult, type SymlinkStatus } from '../lib/project-context.ts';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import {
  auditAgentEnvPermissions,
  auditEnvPermissions,
  runSecretsAudit,
  type AgentEnvPermResult,
  type AgentEnvRefMiss,
  type AgentEnvRefsResult,
  type EnvPermissionsResult,
  type SecretsAuditResult,
} from '../lib/doctor-secrets-audit.ts';
import { parseEnvKeys } from '../lib/dotenv-parse.ts';
import {
  confirmAndDeleteRedundantLines,
  type FixPromptOutcome,
} from '../lib/agent-env-fix-prompt.ts';
import { runSafetyAudit, type SafetyAuditResult } from '../lib/doctor-safety-audit.ts';
import {
  runSchedulingDriftAudit,
  type SchedulingDriftAuditResult,
  type StaleFireAudit,
} from '../lib/doctor-scheduling-drift.ts';
import { scheduleFileSchema } from '../lib/schedule-schema.ts';
import { isWindows } from '../lib/platform.ts';

export type DoctorOptions = {
  json: boolean;
  silent: boolean;
  fix: boolean;
  cwd: string;
  dryRun: boolean;
  // ROS-109: scope to audit. Null = autodetect (workspace → project, else user).
  scope?: Scope | null;
};

// ROS-109: shadow warning — same skill installed at both user and project
// scope causes Claude Code to resolve to the user-scope copy, silently
// shadowing the workspace skill. Detect by listing the user-skill dir and
// the workspace-skill dir; intersect names per tool.
export type ShadowCollision = {
  tool: ToolKey;
  skillName: string;
  userPath: string;
  projectPath: string;
};

function listSkillDirNames(target: string): string[] {
  try {
    return readdirSync(target, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function detectShadowCollisions(workspaceRoot: string): ShadowCollision[] {
  const collisions: ShadowCollision[] = [];
  for (const userTool of allTools()) {
    const projectTool = toolForScope(userTool, 'project', workspaceRoot);
    const userNames = new Set(listSkillDirNames(userTool.skillsTarget));
    const projectNames = listSkillDirNames(projectTool.skillsTarget);
    for (const name of projectNames) {
      if (userNames.has(name)) {
        collisions.push({
          tool: userTool.key,
          skillName: name,
          userPath: join(userTool.skillsTarget, name),
          projectPath: join(projectTool.skillsTarget, name),
        });
      }
    }
  }
  return collisions;
}

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
  agentEnvPerms: AgentEnvPermResult,
  dryRun = false,
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
      if (dryRun) {
        fixed.push(`${item.name}: would relink → CONTEXT.md`);
        continue;
      }
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
    if (dryRun) {
      fixed.push('.env: would chmod 0600');
    } else {
      try {
        chmodSync(envPerms.path, 0o600);
        fixed.push('.env: chmod 0600');
      } catch (err) {
        failed.push({ what: '.env', error: (err as Error).message });
      }
    }
  }

  // Agent .env permissions fix — chmod 0600 every warn/fail with autoFixable.
  if (agentEnvPerms.status === 'warn' || agentEnvPerms.status === 'fail') {
    for (const item of agentEnvPerms.items) {
      if (item.status === 'ok') continue;
      const label = `${item.agentPath}/.env`;
      if (dryRun) {
        fixed.push(`${label}: would chmod 0600`);
        continue;
      }
      try {
        chmodSync(item.envPath, 0o600);
        fixed.push(`${label}: chmod 0600`);
      } catch (err) {
        failed.push({ what: label, error: (err as Error).message });
      }
    }
  }

  return { applied, fixed, failed };
}

// =====================================================================
// Agent env-ref --fix (check 15)
// =====================================================================
//
// Interactive: shows a checkbox of unique missing env-var keys (deduped across
// agents) and appends `KEY=` lines for each user-selected key to the workspace
// /.env. Idempotent: keys already present in /.env are silently skipped.
// Workspace /.env is the single declared-keys surface — agent .env is for
// overrides only, never the place to add new declared keys.

export type AgentEnvFixPrompt = (
  uniqueKeys: ReadonlyArray<{ key: string; refs: AgentEnvRefMiss[] }>,
) => Promise<string[]>;

function uniqueKeysFromRefs(refs: AgentEnvRefsResult): Array<{ key: string; refs: AgentEnvRefMiss[] }> {
  const byKey = new Map<string, AgentEnvRefMiss[]>();
  // Errors first, then warns — preserves "required-first" ordering in the UI.
  for (const m of [...refs.errors, ...refs.warns]) {
    const list = byKey.get(m.key);
    if (list) list.push(m);
    else byKey.set(m.key, [m]);
  }
  return Array.from(byKey.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, refs]) => ({ key, refs }));
}

function appendKeysToEnvFile(cwd: string, keys: string[]): { added: string[]; skipped: string[] } {
  const envPath = join(cwd, '.env');
  const added: string[] = [];
  const skipped: string[] = [];

  let existing = '';
  let hadFile = false;
  try {
    existing = readFileSync(envPath, 'utf8');
    hadFile = true;
  } catch {
    // file absent — we'll create it
  }
  let existingKeys = new Set<string>();
  try {
    existingKeys = new Set(parseEnvKeys(existing));
  } catch {
    // malformed existing .env: still try to append, but warn the caller via
    // an empty existingKeys set so we don't silently skip.
  }

  const newLines: string[] = [];
  for (const key of keys) {
    if (existingKeys.has(key)) {
      skipped.push(key);
      continue;
    }
    newLines.push(`${key}=`);
    added.push(key);
  }

  if (newLines.length === 0) {
    return { added, skipped };
  }

  let body = existing;
  if (body.length > 0 && !body.endsWith('\n')) body += '\n';
  body += newLines.join('\n') + '\n';

  writeFileSync(envPath, body, { encoding: 'utf8' });
  if (!hadFile && !isWindows()) {
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // chmod failure is non-fatal — file was created; check 11 will surface
      // the wrong-perm finding on the next pass.
    }
  }
  return { added, skipped };
}

async function defaultAgentEnvPrompt(
  uniqueKeys: ReadonlyArray<{ key: string; refs: AgentEnvRefMiss[] }>,
): Promise<string[]> {
  const { checkbox } = await import('@inquirer/prompts');
  return checkbox({
    message: 'Select env keys to append to /.env (empty value — fill in after):',
    choices: uniqueKeys.map(({ key, refs }) => {
      const required = refs.some((r) => r.required);
      const tag = required ? '(required)' : '(optional)';
      const agents = refs.map((r) => r.agent).join(', ');
      return { value: key, name: `${key}  ${tag}  ← ${agents}` };
    }),
  });
}

export async function applyAgentEnvFix(
  cwd: string,
  refs: AgentEnvRefsResult,
  opts: { dryRun: boolean; prompt?: AgentEnvFixPrompt },
): Promise<{ fixed: string[]; failed: Array<{ what: string; error: string }> }> {
  const fixed: string[] = [];
  const failed: Array<{ what: string; error: string }> = [];
  const uniqueKeys = uniqueKeysFromRefs(refs);
  if (uniqueKeys.length === 0) return { fixed, failed };

  if (opts.dryRun) {
    for (const { key, refs: agents } of uniqueKeys) {
      const agentList = agents.map((r) => r.agent).join(', ');
      fixed.push(`/.env: would append ${key}= ${chalk.dim(`(referenced by ${agentList})`)}`);
    }
    return { fixed, failed };
  }

  let selected: string[];
  try {
    selected = await (opts.prompt ?? defaultAgentEnvPrompt)(uniqueKeys);
  } catch (err) {
    failed.push({ what: '/.env (interactive prompt)', error: (err as Error).message });
    return { fixed, failed };
  }
  if (selected.length === 0) return { fixed, failed };

  try {
    const { added, skipped } = appendKeysToEnvFile(cwd, selected);
    for (const k of added) fixed.push(`/.env: appended ${k}=`);
    for (const k of skipped) fixed.push(`/.env: ${k} already present (skipped)`);
  } catch (err) {
    failed.push({ what: '/.env', error: (err as Error).message });
  }
  return { fixed, failed };
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
  const agentEnv = audit.agentEnvPermissions;
  const refs = audit.envKeyReferences;
  const templates = audit.templateSecretLiterals;
  const leak = audit.promptLeak;
  const agentRefs = audit.agentEnvRefs;
  const redundancy = audit.agentEnvRedundancy;

  // Skip rendering when there's nothing to show.
  const noEnv = env.status === 'absent' || env.status === 'skip-platform';
  const agentEnvClean =
    agentEnv.status === 'skip-platform' ||
    (agentEnv.status === 'ok' && agentEnv.items.length === 0);
  const allClean =
    noEnv &&
    agentEnvClean &&
    refs.status === 'ok' &&
    templates.status === 'ok' &&
    leak.status === 'ok' &&
    agentRefs.status === 'ok' &&
    redundancy.status === 'ok';
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

  if (agentEnv.status === 'ok' && agentEnv.items.length > 0) {
    lines.push(`  ${chalk.green('✓')} agent .env perms  ${chalk.dim('OK')} ${chalk.dim(`(${agentEnv.items.length} agent .env${agentEnv.items.length === 1 ? '' : 's'})`)}`);
  } else if (agentEnv.status === 'warn') {
    const warnCount = agentEnv.items.filter((i) => i.status === 'warn').length;
    lines.push(`  ${chalk.yellow('!')} agent .env perms  ${chalk.yellow('WARN')} ${chalk.dim(`(${warnCount} agent .env${warnCount === 1 ? '' : 's'} not 0600)`)}`);
    for (const item of agentEnv.items.slice(0, 10)) {
      if (item.status === 'ok') continue;
      lines.push(`      ${chalk.yellow('-')} ${item.agentPath}/.env ${chalk.dim(`(got ${item.mode}, expected 0600)`)}`);
    }
    lines.push(`      ${chalk.dim('→ Run `roster doctor --fix` to chmod 0600.')}`);
  } else if (agentEnv.status === 'fail') {
    const failCount = agentEnv.items.filter((i) => i.status === 'fail').length;
    const warnCount = agentEnv.items.filter((i) => i.status === 'warn').length;
    const detail = failCount === 1 ? '1 world-writable' : `${failCount} world-writable`;
    const extra = warnCount > 0 ? `, ${warnCount} other not 0600` : '';
    lines.push(`  ${chalk.red('✗')} agent .env perms  ${chalk.red('FAIL')} ${chalk.dim(`(${detail}${extra})`)}`);
    for (const item of agentEnv.items.slice(0, 10)) {
      if (item.status === 'ok') continue;
      const marker = item.status === 'fail' ? chalk.red('-') : chalk.yellow('-');
      lines.push(`      ${marker} ${item.agentPath}/.env ${chalk.dim(`(got ${item.mode}, expected 0600)`)}`);
    }
    lines.push(`      ${chalk.dim('→ Run `roster doctor --fix` to chmod 0600.')}`);
  } else if (agentEnv.status === 'skip-platform') {
    lines.push(`  ${chalk.dim('-')} agent .env perms  ${chalk.dim('SKIPPED')} ${chalk.dim('(windows mode bits not portable)')}`);
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

  if (agentRefs.status === 'fail' || agentRefs.status === 'warn') {
    const e = agentRefs.errors.length;
    const w = agentRefs.warns.length;
    const counts: string[] = [];
    if (e > 0) counts.push(`${e} error${e === 1 ? '' : 's'}`);
    if (w > 0) counts.push(`${w} warn${w === 1 ? '' : 's'}`);
    const tag = agentRefs.status === 'fail' ? chalk.red('FAIL') : chalk.yellow('WARN');
    const symbol = agentRefs.status === 'fail' ? chalk.red('✗') : chalk.yellow('!');
    lines.push(`  ${symbol} agent-env-refs    ${tag} ${chalk.dim(`(${counts.join(', ')})`)}`);
    for (const m of agentRefs.errors.slice(0, 10)) {
      lines.push(`      ${chalk.red('-')} ${m.agent}: ${m.key} ${chalk.dim(`(tools.${m.binding}, required)`)}`);
    }
    if (agentRefs.errors.length > 10) {
      lines.push(`      ${chalk.dim(`… (${agentRefs.errors.length - 10} more errors)`)}`);
    }
    for (const m of agentRefs.warns.slice(0, 5)) {
      lines.push(`      ${chalk.yellow('-')} ${m.agent}: ${m.key} ${chalk.dim(`(tools.${m.binding}, optional)`)}`);
    }
    if (agentRefs.warns.length > 5) {
      lines.push(`      ${chalk.dim(`… (${agentRefs.warns.length - 5} more warns)`)}`);
    }
    if (e > 0 || w > 0) {
      lines.push(`      ${chalk.dim('→ Run `roster doctor --fix` to append missing keys to /.env.')}`);
    }
  }

  if (redundancy.status === 'warn') {
    const n = redundancy.items.length;
    lines.push(`  ${chalk.yellow('!')} agent .env redundancy  ${chalk.yellow('WARN')} ${chalk.dim(`(${n} entr${n === 1 ? 'y' : 'ies'})`)}`);
    for (const item of redundancy.items.slice(0, 10)) {
      lines.push(`      ${chalk.yellow('-')} ${item.agentEnvPath}:${item.line}  ${item.key} ${chalk.dim('matches workspace .env')}`);
    }
    if (n > 10) {
      lines.push(`      ${chalk.dim(`… (${n - 10} more)`)}`);
    }
    lines.push(`      ${chalk.dim('→ Run `roster doctor --fix` to prompt removal of redundant lines.')}`);
  }

  return lines;
}

function renderStaleFiresSection(stale: StaleFireAudit): string[] {
  if (stale.items.length === 0) return [];
  // Only render if at least one item is non-ok — for an all-OK workspace,
  // a "Scheduling fires: OK" block is just noise (the rest of doctor is
  // already success-by-absence in design).
  const anyInteresting = stale.items.some((i) => i.status !== 'ok');
  if (!anyInteresting) return [];

  const lines: string[] = [''];
  lines.push(chalk.bold('Scheduling fires') + chalk.dim(`  (grace: ${stale.graceMinutes}m)`));
  for (const item of stale.items) {
    if (item.status === 'ok') continue;
    if (item.status === 'fail') {
      const exitWord = item.exitCode === null ? '?' : String(item.exitCode);
      lines.push(`  ${chalk.red('✗')} ${item.name.padEnd(20)} ${chalk.red('FAILED')} ${chalk.dim(`(exit ${exitWord} at ${item.firedAtUtc})`)}`);
      lines.push(`      ${chalk.dim('→ Run ')}${chalk.bold('roster pending sync')}${chalk.dim(' to surface a HITL item.')}`);
    } else if (item.status === 'warn') {
      lines.push(`  ${chalk.yellow('!')} ${item.name.padEnd(20)} ${chalk.yellow('STALE')} ${chalk.dim(`(expected fresh run before ${item.expectedBeforeUtc})`)}`);
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

function renderText(
  results: ToolAuditResult[],
  summary: Summary,
  workarounds: Workaround[],
  scope: Scope,
): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster doctor'));
  lines.push(chalk.dim(`Install scope: ${scope} (${scope === 'project' ? 'workspace-local' : 'home directory'})`));
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

// ROS-109: shadow collision section. Emitted only when at least one user-scope
// skill name overlaps a workspace-scope skill name — Claude Code resolves to
// the user-scope copy, silently shadowing the workspace one. The fix is for
// the user to delete one side.
function renderShadowSection(shadows: ShadowCollision[]): string[] {
  if (shadows.length === 0) return [];
  const lines: string[] = [''];
  lines.push(chalk.bold('Shadow collisions') + chalk.dim(` (${shadows.length})`));
  lines.push(chalk.dim('  Same skill installed at both scopes. The user-scope copy wins;'));
  lines.push(chalk.dim('  the workspace skill is silently ignored. Remove one.'));
  for (const s of shadows) {
    lines.push(
      `  ${chalk.yellow('!')} ${chalk.bold(s.skillName)} ${chalk.dim('(')}${s.tool}${chalk.dim(')')}`,
    );
    lines.push(`      user:    ${tildify(s.userPath)}`);
    lines.push(`      project: ${s.projectPath}`);
  }
  return lines;
}

function renderInteractiveFixSection(outcome: FixPromptOutcome): string[] {
  const anything =
    outcome.deleted.length > 0 ||
    outcome.failed.length > 0 ||
    outcome.skipped.length > 0 ||
    outcome.nonTtySkipped;
  if (!anything) return [];
  const lines: string[] = [''];
  lines.push(chalk.bold('agent .env redundancy --fix'));
  if (outcome.nonTtySkipped) {
    lines.push(`  ${chalk.dim('-')} skipped — re-run \`roster doctor --fix\` in an interactive terminal`);
    return lines;
  }
  for (const f of outcome.deleted) {
    lines.push(`  ${chalk.green('✓')} ${f}`);
  }
  for (const f of outcome.skipped) {
    lines.push(`  ${chalk.dim('-')} ${f}: kept`);
  }
  for (const f of outcome.failed) {
    lines.push(`  ${chalk.red('✗')} ${f.what}: ${f.error}`);
  }
  return lines;
}

export async function executeDoctor(opts: DoctorOptions): Promise<number> {
  // ROS-109: scope-aware audit. Determine effective scope first; downstream
  // tool detection runs against the matching path family.
  const workspaceExists = detectWorkspace(opts.cwd);
  const effectiveScope: Scope =
    opts.scope ?? defaultScopeForContext(workspaceExists);

  // For project scope, audit workspace-relative paths; for user scope, today's
  // home-dir paths. detectTools() filters by configRoot existence, so calling
  // it with project-scope tool defs returns only tools the workspace has been
  // installed into (`<ws>/.<tool>/`).
  const userScopeTools = detectTools();
  const detected =
    effectiveScope === 'project'
      ? allTools()
          .map((t) => toolForScope(t, 'project', opts.cwd))
          .filter((t) => existsSync(t.configRoot))
      : userScopeTools;

  // Shadow detection runs independent of which scope is primary — what
  // matters is whether the same skill name exists in BOTH scopes for a tool.
  // Only meaningful when a workspace exists; without one, there's no
  // workspace-scope skills dir to shadow against.
  const shadows = workspaceExists ? detectShadowCollisions(opts.cwd) : [];

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
  const initialAgentEnvPerms = auditAgentEnvPermissions(opts.cwd);
  let fixOutcome: FixOutcome = NO_FIX_REQUESTED;

  const schedulesForLeak = listAllScheduleEntries(opts.cwd);
  // ROSTER_CODEX_HOME mirrors the override used by src/lib/tools.ts (codexHome()).
  // Honor it here too so doctor's Codex preflight reads from the same synthetic
  // dir tests / advanced users may have wired up — otherwise preflight would
  // silently fall back to $HOME/.codex and report a misleading failure in CI.
  const codexHomeOverride = process.env['ROSTER_CODEX_HOME'];
  const safety = runSafetyAudit({
    rosterRoot: ROSTER_ROOT,
    toolAudits: results,
    detectedTools: detected,
    homeDir: home,
    env: process.env,
    ...(codexHomeOverride !== undefined && codexHomeOverride !== '' ? { codexHome: codexHomeOverride } : {}),
  });
  const initialSecrets = runSecretsAudit({
    cwd: opts.cwd,
    rosterRoot: ROSTER_ROOT,
    schedules: schedulesForLeak,
  });

  if (opts.fix) {
    fixOutcome = runFixes(opts.cwd, workspace, initialEnvPerms, initialAgentEnvPerms, opts.dryRun);

    // Interactive check-15 fix. Skipped under --json (no TTY contract) and when
    // stdin is not a TTY (CI / pipe). Under --dry-run we still preview.
    const refs = initialSecrets.agentEnvRefs;
    const anyMissing = refs.errors.length > 0 || refs.warns.length > 0;
    // Node sets process.stdin.isTTY to `true` for a TTY and leaves it
    // `undefined` otherwise (pipe / file / detached). Only the explicit-true
    // case means we have a real interactive shell — anything else degrades
    // to the "rerun interactively" path.
    const canInteract = !opts.json && process.stdin.isTTY === true;
    if (anyMissing) {
      if (opts.dryRun) {
        const out = await applyAgentEnvFix(opts.cwd, refs, { dryRun: true });
        fixOutcome.fixed.push(...out.fixed);
        fixOutcome.failed.push(...out.failed);
      } else if (canInteract) {
        const out = await applyAgentEnvFix(opts.cwd, refs, { dryRun: false });
        fixOutcome.fixed.push(...out.fixed);
        fixOutcome.failed.push(...out.failed);
      } else {
        const reason = opts.json
          ? 'interactive prompt suppressed under --json'
          : 'no TTY (non-interactive shell)';
        fixOutcome.failed.push({
          what: '/.env (agent-env-refs)',
          error: `--fix skipped: ${reason}. Rerun in an interactive shell to append missing keys.`,
        });
      }
    }

    if (!opts.dryRun && fixOutcome.fixed.length > 0) {
      workspaceFinal = auditWorkspace(opts.cwd);
    }
  }

  // Re-run secrets audit when a real fix mutated /.env so the rendered section
  // reflects post-fix state. Other audits are not affected by --fix.
  const secrets = opts.fix && !opts.dryRun && fixOutcome.fixed.length > 0
    ? runSecretsAudit({
        cwd: opts.cwd,
        rosterRoot: ROSTER_ROOT,
        schedules: schedulesForLeak,
      })
    : initialSecrets;
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

  // Render audits, then run the interactive --fix prompt for redundant agent
  // .env lines (if any), then render the interactive fix section. This ordering
  // lets the user see warnings before being prompted. --silent and --json
  // suppress prompts (treated as non-TTY) so automation never blocks on stdin.
  if (!opts.json && !opts.silent) {
    for (const line of renderText(results, summary, workarounds, effectiveScope)) console.log(line);
    for (const line of renderShadowSection(shadows)) console.log(line);
    for (const line of renderWorkspaceSection(workspaceFinal)) console.log(line);
    for (const line of renderSchedulingSection(scheduling)) console.log(line);
    for (const line of renderSchedulingDriftSection(schedulingDrift)) console.log(line);
    for (const line of renderStaleFiresSection(schedulingDrift.staleFires)) console.log(line);
    for (const line of renderSafetySection(safety)) console.log(line);
    for (const line of renderSecretsSection(secrets)) console.log(line);
    for (const line of renderFixSection(fixOutcome)) console.log(line);
  }

  let interactiveOutcome: FixPromptOutcome | null = null;
  if (opts.fix && secrets.agentEnvRedundancy.items.length > 0) {
    const isTTY = !opts.silent && !opts.json && (process.stdin.isTTY ?? false);
    interactiveOutcome = await confirmAndDeleteRedundantLines(
      secrets.agentEnvRedundancy.items,
      opts.cwd,
      { isTTY, stdin: process.stdin, stdout: process.stdout },
      opts.dryRun,
    );
    if (!opts.json && !opts.silent) {
      for (const line of renderInteractiveFixSection(interactiveOutcome)) console.log(line);
    }
  }

  if (opts.json) {
    const payload = {
      ok: allOk,
      rosterVersion: getPackageVersion(),
      scope: effectiveScope,
      shadows,
      tools: results,
      summary,
      workspace: workspaceFinal,
      scheduling,
      workarounds,
      safety,
      secrets,
      scheduling_drift: schedulingDrift,
      fix: fixOutcome,
      interactive_fix: interactiveOutcome,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else if (!opts.silent && opts.dryRun) {
    console.log(chalk.dim(opts.fix
      ? '--dry-run: nothing applied; lines above are what `--fix` would have done.'
      : '--dry-run: read-only audit; pass `--fix` to preview repairs.'));
  }

  return allOk ? EXIT_OK : EXIT_ERROR;
}
