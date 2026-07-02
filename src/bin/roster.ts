#!/usr/bin/env node
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { getPackageVersion, ROSTER_ROOT } from '../lib/paths.ts';
import { allTools, detectTools, type Tool, type ToolKey } from '../lib/tools.ts';
import { installToTool, type InstallResult } from '../lib/install.ts';
import { parseInstallArgs } from '../lib/install-args.ts';
import {
  detectWorkspace,
  defaultScopeForContext,
  toolForScope,
  type Scope,
} from '../lib/install-scope.ts';
import { parseDoctorArgs } from '../lib/doctor-args.ts';
import { parseScheduleArgs } from '../lib/schedule-args.ts';
import { parseReviewArgs } from '../lib/review-args.ts';
import { parseHooksArgs } from '../lib/hooks-args.ts';
import { parseMigrateArgs } from '../lib/migrate-args.ts';
import { parsePendingArgs } from '../lib/pending-args.ts';
import { executePendingSync } from '../commands/pending-sync.ts';
import { executeInit } from '../commands/init.ts';
import { executeDoctor } from '../commands/doctor.ts';
import {
  executeScheduleValidate,
  executeScheduleInstall,
  executeScheduleList,
  executeScheduleRemove,
  executeScheduleStatus,
  executeScheduleRun,
  executeScheduleEstimateUsage,
} from '../commands/schedule.ts';
import { executeReview } from '../commands/review.ts';
import { executeSkillsSync, executeSkillsUpdate, renderSyncResult } from '../commands/skills.ts';
import { parseSkillsArgs } from '../lib/skills-args.ts';
import { executeUpgradeCommand } from '../commands/upgrade.ts';
import { parseUpgradeArgs } from '../lib/upgrade-args.ts';
import { executeUpdate } from '../commands/update.ts';
import { parseUpdateArgs } from '../lib/update-args.ts';
import { syncFounderSkills } from '../lib/founder-skills/sync.ts';
import { realInstaller } from '../lib/founder-skills/installer.ts';
import { executeHooksInstall } from '../commands/hooks.ts';
import { executeMigrateCodexSkills, executeMigrateFromAgentTeam } from '../commands/migrate.ts';
import { runTask } from '../commands/task.ts';
import { parseBrainArgs } from '../lib/brain-args.ts';
import {
  executeBrainInit,
  executeBrainDoctor,
  executeBrainSave,
  executeBrainEvent,
  executeBrainLink,
  executeBrainMerge,
  executeBrainGet,
  executeBrainTable,
  executeBrainSql,
  executeBrainMount,
  executeBrainExport,
  executeBrainImport,
  executeBrainQuery,
  executeBrainConfig,
  executeBrainReindex,
} from '../commands/brain.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  EXIT_NO_TOOLS,
  RosterError,
  isRosterError,
  noToolsError,
  renderError,
  toolsNotDetectedError,
  unexpectedError,
  userCancelledInit,
  userCancelledInstall,
  workspaceRequiredError,
} from '../lib/errors.ts';

type Subcommand = 'install' | 'init' | 'doctor' | 'schedule' | 'review' | 'hooks' | 'migrate' | 'pending' | 'skills' | 'upgrade' | 'update' | 'brain' | 'task';
const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>([
  'install',
  'init',
  'doctor',
  'schedule',
  'review',
  'hooks',
  'migrate',
  'upgrade',
  'update',
  'pending',
  'skills',
  'brain',
  'task',
]);

// Display a path under home as `~/foo`; otherwise if it's under cwd, show
// as `./foo` (workspace-local installs read better that way). Falls back
// to the absolute path for unrelated locations.
function displayPath(path: string, cwd: string): string {
  const home = homedir();
  if (path.startsWith(home)) return '~' + path.slice(home.length);
  const rel = relative(cwd, path);
  if (!rel.startsWith('..') && !rel.startsWith('/')) return './' + rel;
  return path;
}

function printBanner(version: string): void {
  console.log();
  console.log(`${chalk.bold.cyan('roster')}${chalk.dim(` v${version}`)}`);
  console.log(chalk.dim('Multi-agent workspace scaffolder for Claude Code, Codex CLI, and Gemini.'));
  console.log();
}

function printHelp(version: string): void {
  printBanner(version);
  const lines = [
    chalk.bold('Usage:'),
    `  roster                       ${chalk.dim('Interactive install (alias of `roster install`)')}`,
    `  roster install               ${chalk.dim('Copy skills + agents into detected AI tool config dirs')}`,
    `  roster init [name]           ${chalk.dim('Scaffold a multi-agent workspace in the current dir')}`,
    `  roster update                ${chalk.dim('Bring this workspace current: install + hooks install + upgrade in one step')}`,
    `  roster upgrade [--dry-run]   ${chalk.dim('Refresh scaffold files to the installed roster (guidelines/ excluded; --exclude <glob>)')}`,
    `  roster doctor                ${chalk.dim('Audit installed skills + agents per AI tool')}`,
    `  roster schedule validate     ${chalk.dim('Validate roster/<function>/schedules.yaml files')}`,
    `  roster schedule install      ${chalk.dim('Register a schedule (Claude: UI hand-off; Codex: ROS-35)')}`,
    `  roster schedule list         ${chalk.dim('List all registered schedules across roster/<function>/')}`,
    `  roster schedule status NAME  ${chalk.dim('Show last_run / last_status / next_due_at for a schedule')}`,
    `  roster schedule run NAME     ${chalk.dim('Manually fire a schedule (Claude: print prompt; Codex: spawn)')}`,
    `  roster schedule remove NAME  ${chalk.dim('Remove a schedule (strips crontab block if --via cron)')}`,
    `  roster schedule estimate-usage  ${chalk.dim('Estimate plan-message consumption per schedule')}`,
    `  roster skills sync           ${chalk.dim('Install founder-skills declared in founder-skills.yaml (project-local)')}`,
    `  roster skills update [--latest]  ${chalk.dim('Re-sync from the manifest (lock records result), or bump pinned refs to newest tags')}`,
    `  roster review [function]     ${chalk.dim('Review unread decisions (HITL); --json to list, --approve/--reject <id|path> to apply')}`,
    `  roster pending sync          ${chalk.dim('Synthesize HITL items from failed-fire signals (.exit + STALE)')}`,
    `  roster task setup            ${chalk.dim('Map your Notion board to canonical task states → roster/tracker.yaml (--data-source, --yes, --json)')}`,
    `  roster task list             ${chalk.dim('Show the claimable pool + your in-flight tasks (--json)')}`,
    `  roster task status [sel]     ${chalk.dim('Stage-grouped digest + needs-your-attention, or one task\'s stage (--json)')}`,
    `  roster task claim <sel>      ${chalk.dim('Claim a task: self-assign + advance (start/submit/done/revise/block/unblock/cancel)')}`,
    `  roster hooks install         ${chalk.dim('Install SessionStart banner hooks for Claude + Codex')}`,
    `  roster brain init            ${chalk.dim('Provision the Postgres knowledge brain (admin URL); prints runtime URL once')}`,
    `  roster brain doctor          ${chalk.dim('Audit brain append-only safety + report pending migrations')}`,
    `  roster brain save/get/event/link/merge/table/sql  ${chalk.dim('Append-only write/read verbs (runtime role)')}`,
    `  roster brain mount <file>    ${chalk.dim('Ingest a file as append-only document chunks + keyword index (runtime role)')}`,
    `  roster brain export          ${chalk.dim('Dump all brain tables to a portable backup dir (--out, --format jsonl|sql; admin URL)')}`,
    `  roster brain import <dir>    ${chalk.dim('Restore a backup into a fresh, empty brain (admin URL)')}`,
    `  roster brain query "<text>"  ${chalk.dim('Hybrid semantic + keyword + graph search (--kind, --limit, --json)')}`,
    `  roster brain config get|set  ${chalk.dim('Read/set brain settings (embeddings.enabled, provider, model, search knobs)')}`,
    `  roster brain reindex [--yes]  ${chalk.dim('Backfill embeddings for active chunks missing/stale vectors (--since, --model; admin URL)')}`,
    `  roster migrate from-agent-team <dir>  ${chalk.dim('Migrate a legacy agent-team workspace into roster')}`,
    `  roster migrate codex-skills  ${chalk.dim('Copy legacy .codex/skills into Codex-native .agents/skills')}`,
    '',
    chalk.bold('Flags:'),
    `  -h, --help                   ${chalk.dim('Show this help')}`,
    `  -v, --version                ${chalk.dim('Print version and exit')}`,
    `  --silent                     ${chalk.dim('Suppress non-error output (install)')}`,
    `  --verbose                    ${chalk.dim('Log each file path written (install)')}`,
    `  --all                        ${chalk.dim('Install to every detected tool (alias of --tool all) (install)')}`,
    `  --tool <name[,name...]>      ${chalk.dim('Install to one or more tools: claude | codex | gemini (install)')}`,
    `  --scope <project|user>       ${chalk.dim('Install at workspace-local or home-dir scope (install)')}`,
    `  --yes, -y                    ${chalk.dim('Skip prompts; use safe defaults (install)')}`,
    `  --tool <name>                ${chalk.dim('Required scheduler tool: claude | codex (schedule install)')}`,
    `  --migrate                    ${chalk.dim('Upgrade pre-CONTEXT.md workspace, preserving CLAUDE.md content (init)')}`,
    `  --json                       ${chalk.dim('Emit machine-readable JSON (doctor, schedule validate)')}`,
    `  --fix                        ${chalk.dim('Auto-fix broken symlinks + .env permissions (doctor)')}`,
    `  --cwd <dir>                  ${chalk.dim('Run schedule validate against a different cwd')}`,
    `  --dest <dir>                 ${chalk.dim('Destination workspace for migrate (default: cwd)')}`,
    `  --dry-run                    ${chalk.dim('Print plan without writes (schedule *, doctor, migrate)')}`,
    `  --force-resync               ${chalk.dim('Re-copy source files that changed since last migration (migrate)')}`,
    `  --debug                      ${chalk.dim('Print full stack trace on error (global)')}`,
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

function unknownCommandError(command: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} unknown command ${chalk.yellow(`'${command}'`)}`,
    body: '',
    remedy: `  Run ${chalk.bold('roster --help')} to see available commands.`,
    exitCode: EXIT_ERROR,
  });
}

function toolHints(tools: ReadonlyArray<Tool>): ReadonlyArray<{ name: string; installLink: string }> {
  return tools.map((t) => ({ name: t.name, installLink: t.installLink }));
}

function summarizeInstall(tool: Tool, result: InstallResult, cwd: string): string {
  const skillsLine = `${result.skillsCount} skills → ${displayPath(result.skillsTarget, cwd)}`;
  const agentsLine = result.agentsTarget
    ? `${result.agentsCount} agents → ${displayPath(result.agentsTarget, cwd)}`
    : `${result.agentsCount} agents → (n/a)`;
  return `${chalk.green('✓')} ${chalk.bold(tool.name)} — ${skillsLine}, ${agentsLine}`;
}

async function promptForTools(detected: Tool[], undetected: Tool[]): Promise<Tool[] | null> {
  // If only one tool is detected and there are no undetected peers worth
  // surfacing in the menu, skip the picker — there's nothing to choose.
  if (detected.length === 1 && undetected.length === 0) return detected;

  const { checkbox, confirm } = await import('@inquirer/prompts');
  type Choice = {
    name: string;
    value: ToolKey;
    checked?: boolean;
    disabled?: string;
  };
  const choices: Choice[] = [
    ...detected.map((t) => ({ name: t.name, value: t.key, checked: true })),
    ...undetected.map((t) => ({
      name: t.name,
      value: t.key,
      disabled: '(not detected)',
    })),
  ];

  let selectedKeys: ToolKey[];
  try {
    selectedKeys = await checkbox<ToolKey>({
      message: 'Install roster into which AI tools?',
      choices,
    });
  } catch {
    return null; // ESC / Ctrl-C
  }

  if (selectedKeys.length === 0) {
    let exitAnyway: boolean;
    try {
      exitAnyway = await confirm({
        message: 'No tools selected. Exit without installing?',
        default: true,
      });
    } catch {
      return null;
    }
    if (exitAnyway) return null;
    return promptForTools(detected, undetected);
  }

  return detected.filter((t) => selectedKeys.includes(t.key));
}

async function promptForScope(
  workspaceExists: boolean,
): Promise<Scope | null> {
  const { select } = await import('@inquirer/prompts');
  const projectHint = workspaceExists
    ? 'workspace-local — skills land in the host-native project directory'
    : 'workspace-local — REQUIRES roster init (config/project.yaml not found here)';
  try {
    return await select<Scope>({
      message: 'Install at which scope?',
      choices: [
        {
          name: 'project',
          value: 'project',
          description: projectHint,
        },
        {
          name: 'user',
          value: 'user',
          description:
            'home directory — skills land in ~/.<tool>/, visible to every Claude Code project on this machine',
        },
      ],
      default: workspaceExists ? 'project' : 'user',
    });
  } catch {
    return null;
  }
}

async function runInstall(args: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  const { silent, verbose, yes, scope: requestedScope, target } = parsed;
  const version = getPackageVersion();

  if (!silent) printBanner(version);

  const cwd = process.cwd();
  const isTTY = process.stdin.isTTY === true;
  const workspaceExists = detectWorkspace(cwd);
  // Non-TTY contexts (CI, pipes) behave as if --yes was passed: skip prompts,
  // pick safe defaults, decline symlink-replacement deterministically. The
  // --yes flag opts into the same mode from an interactive shell.
  const nonInteractive = yes || !isTTY;

  const detected = detectTools();

  // Resolve effective tools.
  let targetTools: Tool[];
  if (target.mode === 'all') {
    if (detected.length === 0) throw noToolsError(toolHints(allTools()));
    targetTools = detected;
  } else if (target.mode === 'tools') {
    const detectedKeys = detected.map((t) => t.key);
    const missing = target.keys.filter((k) => !detectedKeys.includes(k));
    if (missing.length > 0) {
      throw toolsNotDetectedError(target.keys, detectedKeys);
    }
    targetTools = detected.filter((t) => target.keys.includes(t.key));
  } else {
    // mode: 'interactive'
    if (detected.length === 0) throw noToolsError(toolHints(allTools()));
    if (nonInteractive) {
      targetTools = detected;
    } else {
      const undetected = allTools().filter(
        (t) => !detected.some((d) => d.key === t.key),
      );
      const picked = await promptForTools(detected, undetected);
      if (picked === null) throw userCancelledInstall();
      targetTools = picked;
    }
  }

  // Resolve effective scope.
  let scope: Scope;
  if (requestedScope !== null) {
    scope = requestedScope;
  } else if (nonInteractive) {
    scope = defaultScopeForContext(workspaceExists);
  } else {
    const picked = await promptForScope(workspaceExists);
    if (picked === null) throw userCancelledInstall();
    scope = picked;
  }

  // Guard: project scope without a workspace is the home-dir foot-gun. Refuse.
  if (scope === 'project' && !workspaceExists) {
    throw workspaceRequiredError(cwd);
  }

  const skillsSrc = join(ROSTER_ROOT, 'skills');
  const agentsSrc = join(ROSTER_ROOT, 'agents');

  // Decline symlink replacement prompts in non-interactive contexts (no TTY
  // to ask on). Preserves ROS-16 behavior.
  const confirmFn = nonInteractive ? async (): Promise<boolean> => false : undefined;

  for (const tool of targetTools) {
    const scopedTool = scope === 'project' ? toolForScope(tool, 'project', cwd) : tool;
    const result = await installToTool(scopedTool, {
      skills: skillsSrc,
      agents: agentsSrc,
      silent: !verbose,
      scope,
      ...(confirmFn ? { confirm: confirmFn } : {}),
    });
    if (!silent) console.log(summarizeInstall(scopedTool, result, cwd));
  }

  // Auto-sync founder-skills when a workspace declares them. Project-scope only:
  // founder-skills are always project-local (never global), so a user-scope
  // install must not touch them. A hard sync failure surfaces (non-zero) rather
  // than silently leaving the workspace half-provisioned.
  if (scope === 'project') {
    const syncResult = await syncFounderSkills({ cwd, installer: realInstaller });
    if (!silent && syncResult.status !== 'no-manifest') {
      console.log(renderSyncResult(syncResult).join('\n'));
    }
  }

  if (!silent) {
    console.log();
    if (scope === 'project') {
      console.log(
        `${chalk.dim('Next: ')}${chalk.bold('open Claude Code (or your AI tool) in this directory')}${chalk.dim(' — skills are workspace-local.')}`,
      );
    } else {
      console.log(
        `${chalk.dim('Next: ')}${chalk.bold('roster init')}${chalk.dim(' to scaffold a workspace, then re-run install at project scope.')}`,
      );
    }
  }
  return EXIT_OK;
}

async function runInit(args: readonly string[]): Promise<number> {
  const silent = args.includes('--silent');
  const force = args.includes('--force');
  const migrate = args.includes('--migrate');
  const noGit = args.includes('--no-git') || args.includes('--skip-git');
  const name = args.find((a) => !a.startsWith('-'));

  if (!silent) printBanner(getPackageVersion());

  const result = await executeInit({
    cwd: process.cwd(),
    name,
    silent,
    force,
    migrate,
    noGit,
  });
  if (result.status === 'cancelled') throw userCancelledInit();
  return EXIT_OK;
}

async function runSchedule(args: readonly string[]): Promise<number> {
  const parsed = parseScheduleArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (parsed.subcommand === 'validate') {
    return executeScheduleValidate({
      cwd: parsed.cwd ?? process.cwd(),
      json: parsed.json,
      silent: parsed.silent,
      dryRun: parsed.dryRun,
    });
  }
  if (parsed.subcommand === 'install') {
    return executeScheduleInstall({
      cwd: parsed.cwd ?? process.cwd(),
      functionName: parsed.functionName,
      agent: parsed.agent,
      plan: parsed.plan,
      cron: parsed.cron,
      tool: parsed.tool,
      via: parsed.via,
      name: parsed.name,
      dryRun: parsed.dryRun,
      cloudRoutine: parsed.cloudRoutine,
      json: parsed.json,
      silent: parsed.silent,
    });
  }
  if (parsed.subcommand === 'list') {
    return executeScheduleList({
      cwd: parsed.cwd ?? process.cwd(),
      json: parsed.json,
      silent: parsed.silent,
      dryRun: parsed.dryRun,
    });
  }
  if (parsed.subcommand === 'status') {
    return executeScheduleStatus({
      cwd: parsed.cwd ?? process.cwd(),
      name: parsed.name,
      functionName: parsed.functionName,
      json: parsed.json,
      silent: parsed.silent,
      dryRun: parsed.dryRun,
    });
  }
  if (parsed.subcommand === 'remove') {
    return await executeScheduleRemove({
      cwd: parsed.cwd ?? process.cwd(),
      name: parsed.name,
      functionName: parsed.functionName,
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      json: parsed.json,
      silent: parsed.silent,
    });
  }
  if (parsed.subcommand === 'run') {
    return await executeScheduleRun({
      cwd: parsed.cwd ?? process.cwd(),
      name: parsed.name,
      functionName: parsed.functionName,
      silent: parsed.silent,
      dryRun: parsed.dryRun,
    });
  }
  if (parsed.subcommand === 'estimate-usage') {
    return executeScheduleEstimateUsage({
      cwd: parsed.cwd ?? process.cwd(),
      json: parsed.json,
      silent: parsed.silent,
      dryRun: parsed.dryRun,
      plan: parsed.plan,
      warnThreshold: parsed.warnThreshold,
    });
  }
  // Exhaustive guard.
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} schedule subcommand not implemented`,
    body: '',
    remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
    exitCode: EXIT_ERROR,
  });
}

async function runReview(args: readonly string[]): Promise<number> {
  const parsed = parseReviewArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return await executeReview({
    cwd: parsed.cwd ?? process.cwd(),
    fn: parsed.fn,
    json: parsed.json,
    silent: parsed.silent,
    ...(parsed.approve !== undefined ? { approve: parsed.approve } : {}),
    ...(parsed.reject !== undefined ? { reject: parsed.reject } : {}),
  });
}

function runMigrate(args: readonly string[]): number {
  const parsed = parseMigrateArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (parsed.subcommand === 'codex-skills') {
    return executeMigrateCodexSkills({
      cwd: parsed.cwd ?? process.cwd(),
      dryRun: parsed.dryRun,
      json: parsed.json,
      silent: parsed.silent,
    });
  }
  return executeMigrateFromAgentTeam({
    sourceDir: parsed.sourceDir,
    dest: parsed.dest,
    dryRun: parsed.dryRun,
    forceResync: parsed.forceResync,
    json: parsed.json,
    silent: parsed.silent,
    cwd: process.cwd(),
  });
}

function runPending(args: readonly string[]): number {
  const parsed = parsePendingArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return executePendingSync({
    cwd: parsed.cwd ?? process.cwd(),
    silent: parsed.silent,
    json: parsed.json,
    dryRun: parsed.dryRun,
  });
}

async function runUpdate(args: readonly string[]): Promise<number> {
  const parsed = parseUpdateArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return await executeUpdate({
    cwd: parsed.cwd ?? process.cwd(),
    json: parsed.json,
    excludes: parsed.excludes,
  });
}

function runUpgrade(args: readonly string[]): number {
  const parsed = parseUpgradeArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return executeUpgradeCommand({
    cwd: parsed.cwd ?? process.cwd(),
    dryRun: parsed.dryRun,
    json: parsed.json,
    excludes: parsed.excludes,
  });
}

async function runSkills(args: readonly string[]): Promise<number> {
  const parsed = parseSkillsArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  const cwd = parsed.cwd ?? process.cwd();
  if (parsed.subcommand === 'sync') {
    return await executeSkillsSync({ cwd, json: parsed.json, silent: parsed.silent });
  }
  return await executeSkillsUpdate({
    cwd,
    json: parsed.json,
    silent: parsed.silent,
    latest: parsed.latest,
  });
}

async function runHooks(args: readonly string[]): Promise<number> {
  const parsed = parseHooksArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (parsed.subcommand === 'install') {
    return await executeHooksInstall({
      target: parsed.target,
      silent: parsed.silent,
    });
  }
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} hooks subcommand not implemented`,
    body: '',
    remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
    exitCode: EXIT_ERROR,
  });
}

async function runBrain(args: readonly string[]): Promise<number> {
  const parsed = parseBrainArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (parsed.subcommand === 'init') {
    return await executeBrainInit({
      json: parsed.json,
      silent: parsed.silent,
      embeddings: parsed.embeddings,
      role: parsed.role,
    });
  }
  if (parsed.subcommand === 'doctor') {
    return await executeBrainDoctor({
      json: parsed.json,
      silent: parsed.silent,
      role: parsed.role,
    });
  }
  if (parsed.subcommand === 'save') {
    return await executeBrainSave({
      json: parsed.json,
      kind: parsed.entKind,
      slug: parsed.slug,
      title: parsed.title,
      fields: parsed.fields,
      source: parsed.source,
      confidence: parsed.confidence,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'event') {
    return await executeBrainEvent({
      json: parsed.json,
      kind: parsed.entKind,
      slug: parsed.slug,
      payload: parsed.payload,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'link') {
    return await executeBrainLink({
      json: parsed.json,
      srcSlug: parsed.srcSlug,
      rel: parsed.rel,
      dstSlug: parsed.dstSlug,
      kindSrc: parsed.kindSrc,
      kindDst: parsed.kindDst,
      props: parsed.props,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'merge') {
    return await executeBrainMerge({
      json: parsed.json,
      fromSlug: parsed.fromSlug,
      intoSlug: parsed.intoSlug,
      kind: parsed.entKind,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'get') {
    return await executeBrainGet({ json: parsed.json, kind: parsed.entKind, slug: parsed.slug });
  }
  if (parsed.subcommand === 'mount') {
    return await executeBrainMount({ json: parsed.json, file: parsed.file });
  }
  if (parsed.subcommand === 'export') {
    return await executeBrainExport({ json: parsed.json, outDir: parsed.outDir, format: parsed.format });
  }
  if (parsed.subcommand === 'import') {
    return await executeBrainImport({ json: parsed.json, dir: parsed.dir });
  }
  if (parsed.subcommand === 'query') {
    return await executeBrainQuery({ json: parsed.json, text: parsed.text, kind: parsed.entKind, limit: parsed.limit });
  }
  if (parsed.subcommand === 'config') {
    if (parsed.op === 'set') {
      return await executeBrainConfig({ json: parsed.json, op: 'set', key: parsed.key, value: parsed.value });
    }
    return await executeBrainConfig({ json: parsed.json, op: 'get', key: parsed.key });
  }
  if (parsed.subcommand === 'reindex') {
    return await executeBrainReindex({ json: parsed.json, since: parsed.since, model: parsed.model, yes: parsed.yes });
  }
  if (parsed.subcommand === 'table') {
    if (parsed.op === 'create') {
      return await executeBrainTable({ json: parsed.json, op: 'create', name: parsed.name, columns: parsed.columns });
    }
    return await executeBrainTable({ json: parsed.json, op: 'list' });
  }
  return await executeBrainSql({ json: parsed.json, query: parsed.query });
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const parsed = parseDoctorArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  const code = await executeDoctor({
    json: parsed.json,
    silent: parsed.silent,
    fix: parsed.fix,
    dryRun: parsed.dryRun,
    cwd: process.cwd(),
    scope: parsed.scope,
  });
  if (code === EXIT_NO_TOOLS && !parsed.json) {
    throw noToolsError(toolHints(allTools()));
  }
  return code;
}

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMANDS.has(value);
}

const rawArgs = process.argv.slice(2);
const debugMode = rawArgs.includes('--debug');

async function main(): Promise<number> {
  const version = getPackageVersion();
  const args = debugMode ? rawArgs.filter((a) => a !== '--debug') : rawArgs;

  if (args.includes('--help') || args.includes('-h')) {
    printHelp(version);
    return EXIT_OK;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(version);
    return EXIT_OK;
  }

  const [first, ...rest] = args;

  if (first === undefined) {
    return runInstall(rest);
  }

  if (isSubcommand(first)) {
    if (first === 'install') return runInstall(rest);
    if (first === 'init') return await runInit(rest);
    if (first === 'doctor') return await runDoctor(rest);
    if (first === 'schedule') return await runSchedule(rest);
    if (first === 'review') return await runReview(rest);
    if (first === 'skills') return await runSkills(rest);
    if (first === 'upgrade') return runUpgrade(rest);
    if (first === 'update') return await runUpdate(rest);
    if (first === 'hooks') return await runHooks(rest);
    if (first === 'migrate') return runMigrate(rest);
    if (first === 'pending') return runPending(rest);
    if (first === 'brain') return await runBrain(rest);
    if (first === 'task') return await runTask(rest);
  }

  throw unknownCommandError(first);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const rosterErr = isRosterError(err) ? err : unexpectedError(err);
    renderError(rosterErr, { debug: debugMode });
    process.exit(rosterErr.exitCode);
  });
