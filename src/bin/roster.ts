#!/usr/bin/env node
import chalk from 'chalk';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { getPackageVersion, ROSTER_ROOT } from '../lib/paths.ts';
import { allTools, detectTools, type Tool, type ToolKey } from '../lib/tools.ts';
import {
  installToTool,
  unsupportedV2ProjectHostError,
  type InstallResult,
} from '../lib/install.ts';
import { parseInstallArgs } from '../lib/install-args.ts';
import {
  defaultScopeForContext,
  toolForScope,
  type Scope,
} from '../lib/install-scope.ts';
import { probeWorkspace } from '../lib/workspace-probe.ts';
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
import { executeSecondOpinion } from '../commands/second-opinion.ts';
import { parseSecondOpinionArgs } from '../lib/second-opinion-args.ts';
import { executeSkillsSync, executeSkillsUpdate } from '../commands/skills.ts';
import { parseSkillsArgs } from '../lib/skills-args.ts';
import { executeUpgradeCommand } from '../commands/upgrade.ts';
import { parseUpgradeArgs } from '../lib/upgrade-args.ts';
import { executeUpdate } from '../commands/update.ts';
import { parseUpdateArgs } from '../lib/update-args.ts';
import { executeHooksInstall } from '../commands/hooks.ts';
import { executeMigrateCodexSkills, executeMigrateFromAgentTeam } from '../commands/migrate.ts';
import { runTask } from '../commands/task.ts';
import { runRun } from '../commands/run.ts';
import { executeOpsSetup } from '../commands/ops.ts';
import { parseOpsArgs } from '../lib/ops-args.ts';
import { executeScaffold } from '../commands/scaffold.ts';
import { executeDiscover } from '../commands/discover.ts';
import { executeValidate } from '../commands/validate.ts';
import { parseScaffoldArgs } from '../lib/scaffold-args.ts';
import { parseDiscoverArgs } from '../lib/discover-args.ts';
import { parseValidateArgs } from '../lib/validate-args.ts';
import { parseContextArgs } from '../lib/context-args.ts';
import { executeContext } from '../commands/context.ts';
import { parseBrainArgs } from '../lib/brain-args.ts';
import {
  executeBrainInit,
  executeBrainDoctor,
  executeBrainIngest,
  executeBrainSave,
  executeBrainEvent,
  executeBrainLink,
  executeBrainMerge,
  executeBrainGet,
  executeBrainFs,
  executeBrainRecord,
  redactBrainProviderFailure,
} from '../commands/brain.ts';
import { parseDreamArgs } from '../lib/dream-args.ts';
import { executeDreamCandidates, executeDreamStatus } from '../commands/dream.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  EXIT_NO_TOOLS,
  RosterError,
  isRosterError,
  noToolsError,
  legacyWorkspaceError,
  mixedWorkspaceError,
  renderError,
  toolsNotDetectedError,
  unexpectedError,
  unsafeWorkspaceMarkerError,
  userCancelledInstall,
  workspaceRequiredError,
  type JsonValue,
} from '../lib/errors.ts';

type Subcommand = 'install' | 'init' | 'scaffold' | 'discover' | 'validate' | 'context' | 'doctor' | 'schedule' | 'review' | 'second-opinion' | 'hooks' | 'migrate' | 'pending' | 'skills' | 'upgrade' | 'update' | 'brain' | 'dream' | 'task' | 'ops' | 'run';
const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>([
  'install',
  'init',
  'scaffold',
  'discover',
  'validate',
  'context',
  'doctor',
  'schedule',
  'review',
  'second-opinion',
  'hooks',
  'migrate',
  'upgrade',
  'update',
  'pending',
  'skills',
  'brain',
  'dream',
  'task',
  'ops',
  'run',
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
  console.log(chalk.dim('Agent-facing workspace and context scaffolder for Claude Code and Codex.'));
  console.log();
}

function printHelp(version: string): void {
  printBanner(version);
  const lines = [
    chalk.bold('Usage:'),
    `  roster                       ${chalk.dim('Interactive install (alias of `roster install`)')}`,
    `  roster install               ${chalk.dim('Generate project activation; user scope retains quarantined legacy installation')}`,
    `  roster init [workspace-id] [--name <workspace-id>]  ${chalk.dim('Create a sparse workspace: roster.yaml + ROSTER.md')}`,
    `  roster scaffold <kind> <id>  ${chalk.dim('Create one registered function, agent, plan, subagent, guideline, tool-use, or lesson')}`,
    `  roster discover [query]      ${chalk.dim('Find compact qualified workspace records (--kind, --scope, --exact, --full, --json)')}`,
    `  roster validate [target]     ${chalk.dim('Validate registry, paths, ownership, and generated drift (--json)')}`,
    `  roster context <function>/<agent>[#plan]  ${chalk.dim('Resolve one bounded task context (--query, --step, --budget, --explain, --json)')}`,
    `  roster update                ${chalk.dim('Synchronize v2 activation and the derived vendor-skill map')}`,
    `  roster upgrade [--dry-run]   ${chalk.dim('Legacy eager-scaffold command; v2 workspaces use roster update')}`,
    `  roster doctor                ${chalk.dim('Audit v2 registry, generated activation, filesystem safety, and secrets')}`,
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
    `  roster second-opinion <files|--stdin|--diff>  ${chalk.dim('Ask a DIFFERENT AI CLI (codex|gemini|claude) for a structured review')}`,
    `  roster pending sync          ${chalk.dim('Synthesize HITL items from failed-fire signals (.exit incl. malformed evidence + STALE); skip an item durably via roster review --reject (writes an acknowledgement sentinel — a plain rm is re-created from the evidence)')}`,
    `  roster task setup            ${chalk.dim('Map your Notion board to canonical task states → roster/tracker.yaml (--data-source, --yes, --json)')}`,
    `  roster task list             ${chalk.dim('Show the claimable pool + your in-flight tasks (--json)')}`,
    `  roster task status [sel]     ${chalk.dim('Stage-grouped digest + needs-your-attention, or one task\'s stage (--json)')}`,
    `  roster task claim <sel>      ${chalk.dim('Claim a task: self-assign + advance (start/submit/done/revise/block/unblock/cancel)')}`,
    `  roster hooks install         ${chalk.dim('Install SessionStart banner hooks for Claude + Codex')}`,
    `  roster brain init            ${chalk.dim('Bind a configured workspace Brain using ambient admin/runtime credentials')}`,
    `  roster brain doctor          ${chalk.dim('Audit brain append-only safety + report pending migrations (metadata only)')}`,
    `  roster brain ingest          ${chalk.dim('Mint an immutable source version + extraction (--manifest <json> | --manifest-file <ws path>, --bytes-file <ws path>; admin URL)')}`,
    `  roster brain save/get/event/link/merge  ${chalk.dim('Append-only write/read verbs (runtime role)')}`,
    `  roster brain record run|artifact|feedback|decision  ${chalk.dim('Append portable work evidence (--payload <json> | --file <workspace path>)')}`,
    `  roster brain fs put|get|ls|rm  ${chalk.dim('Object-storage file store keyed by --kind/--slug, in the tracked brain.storage namespace (runtime role)')}`,
    `  roster brain query "<text>"  ${chalk.dim('Fails closed until cited retrieval ships (#352) — use roster context for cited evidence')}`,
    `  roster brain mount|table|sql|config|reindex|gc|export|import  ${chalk.dim('Legacy spellings; recognized but fail closed until removal in #363')}`,
    `  roster dream status          ${chalk.dim('Read durable Dreamer readiness: due|not_due over observed evidence (--scope/--function/--agent, --json)')}`,
    `  roster dream candidates      ${chalk.dim('list | create | promote | reject | retire — the human-confirmed lesson lifecycle (list takes --readiness-key <sha256:...> for the exact occasion; --json)')}`,
    `  roster ops setup             ${chalk.dim('Configure the workspace operations backend: --backend local|postgres-s3 (--database, --bucket, --new-identity, --json, --yes)')}`,
    `  roster run <verb>            ${chalk.dim('Run + artifact ledger: start|end|event|report|declare-artifact|show|list|doctor|repair (--run, --json, --allow-partial)')}`,
    `  roster migrate from-agent-team <dir>  ${chalk.dim('Migrate a legacy agent-team workspace into roster')}`,
    `  roster migrate codex-skills  ${chalk.dim('Copy legacy .codex/skills into Codex-native .agents/skills')}`,
    '',
    chalk.bold('Flags:'),
    `  -h, --help                   ${chalk.dim('Show this help')}`,
    `  -v, --version                ${chalk.dim('Print version and exit')}`,
    `  --silent                     ${chalk.dim('Suppress non-error output (init/install)')}`,
    `  --verbose                    ${chalk.dim('Log each file path written (install)')}`,
    `  --all                        ${chalk.dim('Install to every detected tool (install)')}`,
    `  --tool <name[,name...]>      ${chalk.dim('Install to one or more tools: claude | codex | gemini (install)')}`,
    `  --scope <project|user>       ${chalk.dim('Install at workspace-local or home-dir scope (install)')}`,
    `  --scope <owner>              ${chalk.dim('Select workspace, function, agent, or plan ownership (scaffold/discover)')}`,
    `  --function <function-id>     ${chalk.dim('Alias function ownership/filter scope (scaffold/discover)')}`,
    `  --agent <function/agent>     ${chalk.dim('Alias agent ownership/filter scope (scaffold/discover)')}`,
    `  --name <workspace-id>        ${chalk.dim('Set the sparse workspace identity (init)')}`,
    `  --purpose <text>             ${chalk.dim('Seed the authored record purpose (scaffold)')}`,
    `  --kind <record-kind>         ${chalk.dim('Filter discovery to one workspace record kind')}`,
    `  --exact                      ${chalk.dim('Require one exact qualified discovery match')}`,
    `  --full                       ${chalk.dim('Include bounded authored content in discovery output')}`,
    `  --query <retrieval-query>    ${chalk.dim('Set the required non-secret host retrieval query')}`,
    `  --step <hint>                ${chalk.dim('Add an optional host-supplied context ranking hint')}`,
    `  --budget <tokens>            ${chalk.dim('Set the context token budget (default: 12000; maximum: 128000)')}`,
    `  --explain                    ${chalk.dim('Include bounded context provenance explanations')}`,
    `  --include-legacy-unverified  ${chalk.dim('Admit legacy-unverified Brain evidence, floored below every verified candidate')}`,
    `  --yes, -y                    ${chalk.dim('Skip prompts; use safe defaults (install)')}`,
    `  --tool <name>                ${chalk.dim('Required scheduler tool: claude | codex (schedule install)')}`,
    `  --json                       ${chalk.dim('Emit machine-readable JSON (install/scaffold/discover/validate/context/update/doctor and supported legacy commands)')}`,
    `  --fix                        ${chalk.dim('Auto-fix broken symlinks + .env permissions (doctor)')}`,
    `  --cwd <dir>                  ${chalk.dim('Run schedule validate against a different cwd')}`,
    `  --host <name>                ${chalk.dim('Reviewer host: claude | codex | gemini (second-opinion; default: first installed ≠ recommended by skill)')}`,
    `  --message <text>             ${chalk.dim('What the reviewer should focus on (second-opinion)')}`,
    `  --timeout <sec>              ${chalk.dim('Reviewer wall clock, default 180 (second-opinion)')}`,
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
  if (result.activation !== undefined) {
    const paths = result.activation.files
      .filter((file) => file.status !== 'preserved-authored')
      .map((file) => file.path)
      .join(', ');
    return `${chalk.green('✓')} ${chalk.bold(tool.name)} — project activation ${result.activation.assurance}${paths.length === 0 ? '' : ` → ${paths}`}`;
  }
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
    : 'workspace-local — REQUIRES roster init (roster.yaml not found here)';
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
      code: 'INVALID_ARGS',
      details: {},
    });
  }
  const { silent, verbose, yes, json, scope: requestedScope, target } = parsed;
  const version = getPackageVersion();

  if (!silent && !json) printBanner(version);

  const cwd = process.cwd();
  const isTTY = process.stdin.isTTY === true;
  const workspaceProbe = probeWorkspace(cwd);
  const workspaceExists = workspaceProbe.kind === 'v2';
  // Non-TTY contexts (CI, pipes) behave as if --yes was passed: skip prompts,
  // pick safe defaults, decline symlink-replacement deterministically. The
  // --yes flag opts into the same mode from an interactive shell.
  const nonInteractive = yes || !isTTY;

  const detected = detectTools();

  // An implicit/project install must never reinterpret a legacy, mixed, or
  // unsafe workspace as "no workspace" and silently fall back to user scope.
  // Explicit user scope remains the quarantined pre-v2 behavior.
  if (requestedScope !== 'user') {
    if (workspaceProbe.kind === 'legacy') {
      throw legacyWorkspaceError(workspaceProbe.legacySignals);
    }
    if (workspaceProbe.kind === 'mixed') {
      throw mixedWorkspaceError(workspaceProbe.v2Signals, workspaceProbe.legacySignals);
    }
    if (workspaceProbe.kind === 'unsafe') {
      throw unsafeWorkspaceMarkerError(workspaceProbe.unsafeSignals);
    }
  }

  // Scope is resolved before tools because an explicit v2 project host is a
  // declaration, not a claim that the same host already has a user-level home.
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

  const explicitV2ProjectHost = scope === 'project' && workspaceExists;

  // Resolve effective tools.
  let targetTools: Tool[];
  if (target.mode === 'all') {
    if (detected.length === 0) throw noToolsError(toolHints(allTools()));
    targetTools = detected;
  } else if (target.mode === 'tools') {
    const available = explicitV2ProjectHost ? allTools() : detected;
    const availableKeys = available.map((t) => t.key);
    const missing = target.keys.filter((k) => !availableKeys.includes(k));
    if (missing.length > 0) {
      throw toolsNotDetectedError(target.keys, detected.map((tool) => tool.key));
    }
    targetTools = available.filter((t) => target.keys.includes(t.key));
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

  if (explicitV2ProjectHost && targetTools.some((tool) => tool.key === 'gemini')) {
    throw unsupportedV2ProjectHostError('gemini');
  }

  const skillsSrc = join(ROSTER_ROOT, 'skills');
  const agentsSrc = join(ROSTER_ROOT, 'agents');

  // Decline symlink replacement prompts in non-interactive contexts (no TTY
  // to ask on). Preserves ROS-16 behavior.
  const confirmFn = nonInteractive ? async (): Promise<boolean> => false : undefined;

  const installed: Array<{ host: ToolKey; result: InstallResult }> = [];
  for (const tool of targetTools) {
    const scopedTool = scope === 'project' ? toolForScope(tool, 'project', cwd) : tool;
    const result = await installToTool(scopedTool, {
      skills: skillsSrc,
      agents: agentsSrc,
      silent: !verbose,
      scope,
      ...(scope === 'project' ? { projectRoot: cwd } : {}),
      ...(confirmFn ? { confirm: confirmFn } : {}),
    });
    installed.push({ host: tool.key, result });
    if (!silent && !json) console.log(summarizeInstall(scopedTool, result, cwd));
  }

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      scope,
      hosts: installed.map(({ host, result }) => ({
        host,
        ...(result.activation === undefined
          ? {
              skills_count: result.skillsCount,
              agents_count: result.agentsCount,
            }
          : { activation: result.activation }),
      })),
    }));
  }

  if (!silent && !json) {
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
  let silent = false;
  let workspaceId: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--silent') {
      silent = true;
      continue;
    }
    if (arg === '--name') {
      const value = args[++index];
      if (value === undefined || value.startsWith('-')) {
        throw new RosterError({
          header: `${chalk.red.bold('roster:')} --name requires a workspace id`,
          body: '',
          remedy: '  Usage: roster init [workspace-id] [--name <workspace-id>] [--silent]',
          exitCode: EXIT_ERROR,
        });
      }
      name = value;
      continue;
    }
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} unsupported init flag ${chalk.yellow(`'${arg}'`)}`,
        body: '  Roster v2 does not overlay, force-refresh, migrate, or initialize Git during init.',
        remedy: '  Usage: roster init [workspace-id] [--name <workspace-id>] [--silent]',
        exitCode: EXIT_ERROR,
      });
    }
    if (workspaceId !== undefined) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} init accepts one workspace id`,
        body: `  Unexpected extra argument: ${arg}`,
        remedy: '  Usage: roster init [workspace-id] [--name <workspace-id>] [--silent]',
        exitCode: EXIT_ERROR,
      });
    }
    workspaceId = arg;
  }

  if (!silent) printBanner(getPackageVersion());

  await executeInit({
    cwd: process.cwd(),
    silent,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(name !== undefined ? { name } : {}),
  });
  return EXIT_OK;
}

function commandParseError(
  command: 'scaffold' | 'discover' | 'validate' | 'context',
  message: string,
  json: boolean,
  details: Readonly<Record<string, JsonValue>> = {},
): number {
  const remedy = `Run roster ${command} --help for usage.`;
  if (json) {
    console.log(JSON.stringify({ ok: false, code: 'INVALID_ARGS', message, remedy, details }));
    return EXIT_ERROR;
  }
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} ${message}`,
    body: '',
    remedy: `  ${remedy}`,
    exitCode: EXIT_ERROR,
    code: 'INVALID_ARGS',
    details,
  });
}

function runScaffold(args: readonly string[]): number {
  const parsed = parseScaffoldArgs(args);
  if (parsed.kind === 'err') {
    return commandParseError('scaffold', parsed.message, args.includes('--json'));
  }
  return executeScaffold({
    cwd: process.cwd(),
    recordKind: parsed.recordKind,
    id: parsed.id,
    purpose: parsed.purpose,
    json: parsed.json,
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
  });
}

function runDiscover(args: readonly string[]): number {
  const parsed = parseDiscoverArgs(args);
  if (parsed.kind === 'err') {
    return commandParseError('discover', parsed.message, args.includes('--json'));
  }
  return executeDiscover({
    cwd: process.cwd(),
    exact: parsed.exact,
    full: parsed.full,
    json: parsed.json,
    ...(parsed.query !== undefined ? { query: parsed.query } : {}),
    ...(parsed.recordKind !== undefined ? { recordKind: parsed.recordKind } : {}),
    ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
  });
}

function runValidate(args: readonly string[]): number {
  const parsed = parseValidateArgs(args);
  if (parsed.kind === 'err') {
    return commandParseError('validate', parsed.message, args.includes('--json'));
  }
  return executeValidate({
    cwd: process.cwd(),
    json: parsed.json,
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
  });
}

async function runContext(args: readonly string[]): Promise<number> {
  const parsed = parseContextArgs(args);
  if (parsed.kind === 'err') {
    return commandParseError('context', parsed.message, args.includes('--json'), parsed.details);
  }
  return await executeContext({
    root: process.cwd(),
    target: parsed.target,
    query: parsed.query,
    stepHint: parsed.stepHint,
    budgetTokens: parsed.budgetTokens,
    explain: parsed.explain,
    includeLegacyUnverified: parsed.includeLegacyUnverified,
  });
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

async function runPending(args: readonly string[]): Promise<number> {
  const parsed = parsePendingArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return await executePendingSync({
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

const DISABLED_BRAIN_COMMANDS: ReadonlySet<string> = new Set([
  'mount',
  'table',
  'sql',
  'config',
  'reindex',
  'gc',
  'export',
  'import',
]);

// AC-4: the legacy spellings stay RECOGNIZED (their parsers are untouched) and
// fail closed. The refusal is raised before the workspace record, the ambient
// environment, any pool, and any filesystem path named on the command line are
// read.
function legacyBrainCommandDisabled(command: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} legacy Brain command '${command}' is disabled`,
    body: '  This spelling predates workspace-verified Brain authority and cannot prove that the target Brain belongs to this workspace.',
    remedy: '  Use the canonical surface: roster brain init|doctor|ingest|save|get|event|link|merge|fs|record.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_LEGACY_COMMAND_DISABLED',
    details: { command: `brain ${command}` },
  });
}

function brainRetrievalNotReady(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} Brain retrieval is not ready`,
    body: '  Cited company retrieval is not wired to the extraction and citation pipeline yet.',
    remedy: '  Use `roster context <function>/<agent> --query "…"` for cited evidence once #352 ships.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_RETRIEVAL_NOT_READY',
    details: { command: 'brain query', blocked_by: ['352'] },
  });
}

async function runBrain(args: readonly string[]): Promise<number> {
  try {
    return await dispatchBrain(args);
  } catch (error) {
    throw redactBrainProviderFailure(error);
  }
}

async function dispatchBrain(args: readonly string[]): Promise<number> {
  const parsed = parseBrainArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  if (DISABLED_BRAIN_COMMANDS.has(parsed.subcommand)) {
    throw legacyBrainCommandDisabled(parsed.subcommand);
  }
  if (parsed.subcommand === 'query') throw brainRetrievalNotReady();

  const cwd = process.cwd();
  if (parsed.subcommand === 'init') {
    return await executeBrainInit({
      cwd,
      json: parsed.json,
      silent: parsed.silent,
      embeddings: parsed.embeddings,
      role: parsed.role,
    });
  }
  if (parsed.subcommand === 'doctor') {
    return await executeBrainDoctor({
      cwd,
      json: parsed.json,
      silent: parsed.silent,
      role: parsed.role,
    });
  }
  if (parsed.subcommand === 'ingest') {
    return await executeBrainIngest({
      cwd,
      json: parsed.json,
      manifest: parsed.manifest,
      manifestFile: parsed.manifestFile,
      bytesFile: parsed.bytesFile,
    });
  }
  if (parsed.subcommand === 'save') {
    return await executeBrainSave({
      cwd,
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
      cwd,
      json: parsed.json,
      kind: parsed.entKind,
      slug: parsed.slug,
      payload: parsed.payload,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'link') {
    return await executeBrainLink({
      cwd,
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
      cwd,
      json: parsed.json,
      fromSlug: parsed.fromSlug,
      intoSlug: parsed.intoSlug,
      kind: parsed.entKind,
      actor: parsed.actor,
    });
  }
  if (parsed.subcommand === 'get') {
    return await executeBrainGet({ cwd, json: parsed.json, kind: parsed.entKind, slug: parsed.slug });
  }
  if (parsed.subcommand === 'record') {
    return await executeBrainRecord({
      cwd,
      json: parsed.json,
      recordKind: parsed.recordKind,
      payload: parsed.payload,
      file: parsed.file,
    });
  }
  if (parsed.subcommand === 'fs') {
    if (parsed.op === 'put') {
      return await executeBrainFs({
        cwd, json: parsed.json, op: 'put', kind: parsed.entKind, slug: parsed.slug,
        file: parsed.file, filename: parsed.filename, actor: parsed.actor,
      });
    }
    if (parsed.op === 'get') {
      return await executeBrainFs({
        cwd, json: parsed.json, op: 'get', kind: parsed.entKind, slug: parsed.slug,
        filename: parsed.filename, out: parsed.out,
      });
    }
    if (parsed.op === 'rm') {
      return await executeBrainFs({
        cwd, json: parsed.json, op: 'rm', kind: parsed.entKind, slug: parsed.slug,
        filename: parsed.filename, actor: parsed.actor,
      });
    }
    return await executeBrainFs({ cwd, json: parsed.json, op: 'ls', kind: parsed.entKind, slug: parsed.slug });
  }
  throw legacyBrainCommandDisabled(parsed.subcommand);
}

// `status` is a pure read; `candidates` is the human-confirmed lesson lifecycle.
// Roster never decides: promote/reject/retire each require a durable human
// decision bound by action digest to that exact candidate.
async function runDream(args: readonly string[]): Promise<number> {
  const parsed = parseDreamArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  try {
    if (parsed.subcommand === 'status') {
      return await executeDreamStatus({
        cwd: process.cwd(),
        json: parsed.json,
        ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
        ...(parsed.functionId !== undefined ? { functionId: parsed.functionId } : {}),
        ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      });
    }
    if (parsed.verb === 'list') {
      return await executeDreamCandidates({
        cwd: process.cwd(),
        json: parsed.json,
        verb: 'list',
        ...(parsed.state !== undefined ? { state: parsed.state } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        ...(parsed.candidateId !== undefined ? { candidateId: parsed.candidateId } : {}),
        ...(parsed.readinessKey !== undefined ? { readinessKey: parsed.readinessKey } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      });
    }
    if (parsed.verb === 'create') {
      return await executeDreamCandidates({
        cwd: process.cwd(),
        json: parsed.json,
        verb: 'create',
        stdin: parsed.stdin,
        ...(parsed.file !== undefined ? { file: parsed.file } : {}),
      });
    }
    return await executeDreamCandidates({
      cwd: process.cwd(),
      json: parsed.json,
      verb: parsed.verb,
      candidateId: parsed.candidateId,
      decisionId: parsed.decisionId,
      actionDigest: parsed.actionDigest,
    });
  } catch (error) {
    throw redactBrainProviderFailure(error);
  }
}

function opsUsageError(): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} usage: roster ops setup [flags]`,
    body: [
      '  Flags:',
      '    --backend local|postgres-s3   backend to configure (required on first setup)',
      '    --database brain|dedicated    which Postgres the ops schemas live in (postgres-s3)',
      '    --bucket <name>               dedicated S3 bucket for this workspace (postgres-s3)',
      '    --region <region>             bucket region (optional)',
      '    --endpoint <url>              S3-compatible endpoint, e.g. MinIO/R2 (optional)',
      '    --force-path-style            path-style S3 addressing (optional)',
      '    --name <label>                workspace display name (default: directory name)',
      '    --new-identity                fork a fresh workspace identity (with --yes if resources are claimed)',
      '    --json                        machine-readable output',
      '    --yes, -y                     confirm orphaning the previous identity',
    ].join('\n'),
    remedy: `  Run ${chalk.bold('roster --help')} for the full command list.`,
    exitCode: EXIT_ERROR,
  });
}

async function runOps(args: readonly string[]): Promise<number> {
  const parsed = parseOpsArgs(args);
  if (parsed.kind === 'usage') throw opsUsageError();
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster ops')} for usage.`,
      exitCode: EXIT_ERROR,
    });
  }
  return await executeOpsSetup({
    cwd: parsed.cwd ?? process.cwd(),
    ...(parsed.backend !== undefined ? { backend: parsed.backend } : {}),
    ...(parsed.database !== undefined ? { database: parsed.database } : {}),
    ...(parsed.bucket !== undefined ? { bucket: parsed.bucket } : {}),
    ...(parsed.region !== undefined ? { region: parsed.region } : {}),
    ...(parsed.endpoint !== undefined ? { endpoint: parsed.endpoint } : {}),
    ...(parsed.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    newIdentity: parsed.newIdentity,
    yes: parsed.yes,
    json: parsed.json,
  });
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const parsed = parseDoctorArgs(args);
  if (parsed.kind === 'err') {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Run ${chalk.bold('roster --help')} for usage.`,
      exitCode: EXIT_ERROR,
      code: 'INVALID_ARGS',
      details: {},
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

async function runSecondOpinion(args: readonly string[]): Promise<number> {
  const parsed = parseSecondOpinionArgs(args);
  if (parsed.kind === 'err') {
    // Machine consumers get the same {ok:false, code, message} envelope for
    // parse failures (NO_INPUT / HOST_UNKNOWN / INVALID_ARGS) as for run
    // failures — a bare thrown error would break --json pipelines.
    if (args.includes('--json')) {
      console.log(JSON.stringify({ ok: false, code: parsed.code, message: parsed.message }));
      return EXIT_ERROR;
    }
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} ${parsed.message}`,
      body: '',
      remedy: `  Usage: roster second-opinion [files...] [--stdin] [--diff [ref]] [--host claude|codex|gemini] [--message "focus"] [--timeout sec] [--json]`,
      exitCode: EXIT_ERROR,
    });
  }
  return await executeSecondOpinion({
    files: parsed.files,
    ...(parsed.host !== undefined ? { host: parsed.host } : {}),
    ...(parsed.message !== undefined ? { message: parsed.message } : {}),
    stdin: parsed.stdin,
    ...(parsed.diff !== undefined ? { diff: parsed.diff } : {}),
    timeoutSec: parsed.timeoutSec,
    json: parsed.json,
  });
}

function isSubcommand(value: string): value is Subcommand {
  return SUBCOMMANDS.has(value);
}

const rawArgs = process.argv.slice(2);
const debugMode = rawArgs.includes('--debug');
const jsonMode = rawArgs.includes('--json');

async function main(): Promise<number> {
  const version = getPackageVersion();
  const args = debugMode ? rawArgs.filter((a) => a !== '--debug') : rawArgs;
  const [first, ...rest] = args;

  if (first === 'context') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      printHelp(version);
      return EXIT_OK;
    }
    return await runContext(rest);
  }

  if (args.includes('--help') || args.includes('-h')) {
    printHelp(version);
    return EXIT_OK;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(version);
    return EXIT_OK;
  }

  if (first === undefined) {
    return runInstall(rest);
  }

  if (isSubcommand(first)) {
    if (first === 'install') return runInstall(rest);
    if (first === 'init') return await runInit(rest);
    if (first === 'scaffold') return runScaffold(rest);
    if (first === 'discover') return runDiscover(rest);
    if (first === 'validate') return runValidate(rest);
    if (first === 'doctor') return await runDoctor(rest);
    if (first === 'schedule') return await runSchedule(rest);
    if (first === 'review') return await runReview(rest);
    if (first === 'second-opinion') return await runSecondOpinion(rest);
    if (first === 'skills') return await runSkills(rest);
    if (first === 'upgrade') return runUpgrade(rest);
    if (first === 'update') return await runUpdate(rest);
    if (first === 'hooks') return await runHooks(rest);
    if (first === 'migrate') return runMigrate(rest);
    if (first === 'pending') return await runPending(rest);
    if (first === 'brain') return await runBrain(rest);
    if (first === 'dream') return await runDream(rest);
    if (first === 'task') return await runTask(rest);
    if (first === 'ops') return await runOps(rest);
    if (first === 'run') return await runRun(rest);
  }

  throw unknownCommandError(first);
}

// process.exit() DISCARDS whatever is still queued on an async stdout/stderr —
// and stdout is async whenever it is a pipe (`roster run show --json | jq`, a
// spawned CLI in a script). A ~130 KiB `--json` payload was therefore delivered
// TRUNCATED at the pipe buffer, i.e. as invalid JSON. Writing an empty chunk and
// exiting from its completion callback drains the queue first; exiting is still
// explicit, so a lingering handle can never hold the CLI open.
function exitAfterFlush(code: number): void {
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
}

main()
  .then(exitAfterFlush)
  .catch((err: unknown) => {
    const rosterErr = isRosterError(err) ? err : unexpectedError(err);
    if (jsonMode) {
      const header = stripVTControlCharacters(rosterErr.header).replace(/^roster:\s*/, '');
      const body = stripVTControlCharacters(rosterErr.body).trim();
      console.log(JSON.stringify({
        ok: false,
        code: rosterErr.code,
        message: body.length === 0 ? header : `${header}\n${body}`,
        remedy: stripVTControlCharacters(rosterErr.remedy).trim(),
        details: rosterErr.details,
      }));
    } else {
      renderError(rosterErr, { debug: debugMode });
    }
    exitAfterFlush(rosterErr.exitCode);
  });
