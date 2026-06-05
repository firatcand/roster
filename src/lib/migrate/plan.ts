import { basename, join } from 'node:path';
import type { SourceModel, CronWrapperPair, ScanWarning } from './scan.ts';
import { mapWrapperToAgentPlan } from './wrapper.ts';
import { shellEscape } from '../shell-escape.ts';

type ScheduleInstallCmd = {
  function: string;
  agent: string;
  plan: string;
  cron: string;
  tool: 'claude' | 'codex';
  wrapperBasename: string;
  /** When true, the command is emitted commented out in the install script. */
  blocked: boolean;
  blockedReason: string | null;
  /** Fully-rendered shell command string (without comment prefix). */
  rendered: string;
};

type FileMove = {
  srcPath: string;
  destPath: string;
  destFunction: string;
  destAgent: string;
};

type DirCopy = {
  srcDir: string;
  destDir: string;
  files: ReadonlyArray<{ relSrc: string; absSrc: string }>;
};

type PlanBlocker =
  | { kind: 'env-too-open'; envPath: string; mode: number }
  | { kind: 'dest-not-initialized'; destDir: string }
  | { kind: 'source-is-roster'; sourceDir: string };

type ManualStep = { description: string; commandHint?: string };

type AgentMdNote = {
  agentName: string;
  agentDirRel: string;
};

type UnmappedWrapper = {
  basename: string;
  wrapperPath: string;
  cron: string;
};

export type MigrationPlan = {
  sourceDir: string;
  destWorkspace: string;
  scheduleInstalls: ReadonlyArray<ScheduleInstallCmd>;
  unmappedWrappers: ReadonlyArray<UnmappedWrapper>;
  pendingMoves: ReadonlyArray<FileMove>;
  logCopies: ReadonlyArray<DirCopy>;
  envCopy: { src: string; dest: string; sourceMode: number; targetMode: number } | null;
  agentMdNotes: ReadonlyArray<AgentMdNote>;
  subscriptionWarnings: ReadonlyArray<{ wrapperPath: string; pattern: string }>;
  manualSteps: ReadonlyArray<ManualStep>;
  blockers: ReadonlyArray<PlanBlocker>;
  /** Sorted relative source paths that should be tracked in the manifest. */
  trackedFiles: ReadonlyArray<{ src: string; dest: string }>;
};

export type PlanOptions = {
  destWorkspace: string;
  destIsInitialized: boolean;
};

function pendingDestFor(destWorkspace: string, sourceFunction: string | null, agentName: string, filename: string): {
  destPath: string;
  destFunction: string;
  destAgent: string;
} {
  const destFunction = sourceFunction ?? agentName;
  const destAgent = agentName;
  const destPath = join(destWorkspace, 'roster', destFunction, 'pending', filename);
  return { destPath, destFunction, destAgent };
}

function logDestFor(destWorkspace: string, agentName: string, parentFunction: string | null, monthDir: string): string {
  const fn = parentFunction ?? agentName;
  return join(destWorkspace, 'roster', fn, agentName, 'log', 'runs', monthDir);
}

function renderScheduleInstallCmd(args: {
  function: string;
  agent: string;
  plan: string;
  cron: string;
  tool: 'claude' | 'codex';
  destWorkspace: string;
}): string {
  // `tool` is a typed union literal so it stays unquoted; every other token is single-quoted.
  return [
    'roster schedule install',
    `${shellEscape(args.function)}/${shellEscape(args.agent)}`,
    shellEscape(args.plan),
    '--cron',
    shellEscape(args.cron),
    '--tool',
    args.tool,
    '--cwd',
    shellEscape(args.destWorkspace),
  ].join(' ');
}

function planScheduleFor(pair: CronWrapperPair, model: SourceModel, destWorkspace: string): ScheduleInstallCmd | UnmappedWrapper {
  const mapping = mapWrapperToAgentPlan(pair.wrapper.basename, model.knownAgentPaths);
  if (!mapping.ok) {
    return { basename: pair.wrapper.basename, wrapperPath: pair.wrapper.wrapperPath, cron: pair.cron };
  }

  const tool: 'claude' | 'codex' = pair.wrapper.kind === 'codex' ? 'codex' : 'claude';

  // ROS-35 merged: --tool codex install is live. No longer mark as blocked.
  // Codex schedules emit ready-to-run; user may add --via cron for programmatic install
  // (default is UI hand-off via the Codex desktop app).
  const rendered = renderScheduleInstallCmd({
    function: mapping.function,
    agent: mapping.agent,
    plan: mapping.plan,
    cron: pair.cron,
    tool,
    destWorkspace,
  });

  return {
    function: mapping.function,
    agent: mapping.agent,
    plan: mapping.plan,
    cron: pair.cron,
    tool,
    wrapperBasename: pair.wrapper.basename,
    blocked: false,
    blockedReason: null,
    rendered,
  };
}

function isUnmapped(v: ScheduleInstallCmd | UnmappedWrapper): v is UnmappedWrapper {
  return (v as UnmappedWrapper).basename !== undefined && (v as ScheduleInstallCmd).rendered === undefined;
}

export function planMigration(model: SourceModel, opts: PlanOptions): MigrationPlan {
  const destWorkspace = opts.destWorkspace;
  const blockers: PlanBlocker[] = [];

  if (!opts.destIsInitialized) {
    blockers.push({ kind: 'dest-not-initialized', destDir: destWorkspace });
  }

  // Schedules
  const scheduleResults = model.cronEntries.map((p) => planScheduleFor(p, model, destWorkspace));
  const scheduleInstalls: ScheduleInstallCmd[] = scheduleResults.filter((r): r is ScheduleInstallCmd => !isUnmapped(r));
  const unmappedWrappers: UnmappedWrapper[] = scheduleResults.filter(isUnmapped);
  scheduleInstalls.sort((a, b) => a.wrapperBasename.localeCompare(b.wrapperBasename));
  unmappedWrappers.sort((a, b) => a.basename.localeCompare(b.basename));

  // Pending HITL moves
  const pendingMoves: FileMove[] = model.pendingItems.map((item) => {
    const r = pendingDestFor(destWorkspace, item.parentFunction, item.agent, item.filename);
    return { srcPath: item.filePath, destPath: r.destPath, destFunction: r.destFunction, destAgent: r.destAgent };
  });

  // Logs
  const logCopies: DirCopy[] = model.agentLogs.flatMap((tree) => {
    const agent = model.agents.find((a) => a.name === tree.agent);
    if (agent === undefined) return [];
    return tree.monthDirs.map((m) => ({
      srcDir: join(tree.baseDir, m.month),
      destDir: logDestFor(destWorkspace, tree.agent, agent.parentFunction, m.month),
      files: m.files.map((absSrc) => ({ absSrc, relSrc: basename(absSrc) })),
    }));
  });

  // .env
  let envCopy: MigrationPlan['envCopy'] = null;
  if (model.envFile !== null) {
    const mode = model.envFile.mode & 0o777;
    if (mode !== 0o600) {
      blockers.push({ kind: 'env-too-open', envPath: model.envFile.path, mode });
    } else {
      envCopy = {
        src: model.envFile.path,
        dest: join(destWorkspace, '.env'),
        sourceMode: mode,
        targetMode: 0o600,
      };
    }
  }

  // Notes from scan warnings
  const agentMdNotes: AgentMdNote[] = model.warnings
    .filter((w): w is Extract<ScanWarning, { kind: 'agent-md-present' }> => w.kind === 'agent-md-present')
    .map((w) => ({ agentName: w.agentName, agentDirRel: w.agentDir }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName));

  const subscriptionWarnings = model.warnings
    .filter((w): w is Extract<ScanWarning, { kind: 'subscription-safety' }> => w.kind === 'subscription-safety')
    .map((w) => ({ wrapperPath: w.wrapperPath, pattern: w.pattern }))
    .sort((a, b) => a.wrapperPath.localeCompare(b.wrapperPath));

  // Manual steps
  const manualSteps: ManualStep[] = [];
  if (model.cronEntries.length > 0) {
    manualSteps.push({
      description: 'Remove the agent-team managed block from your crontab.',
      commandHint:
        "crontab -l 2>/dev/null | awk '/^# AGENT-TEAM-START$/{s=1;next} /^# AGENT-TEAM-END$/{s=0;next} !s' | crontab -",
    });
    manualSteps.push({
      description:
        'After running each emitted `roster schedule install --tool claude` command, paste the corresponding .roster/schedule-specs/<name>.claude.fields.md into Claude Desktop.',
    });
  }
  const codexCount = scheduleInstalls.filter((s) => s.tool === 'codex').length;
  if (codexCount > 0) {
    manualSteps.push({
      description: `${codexCount} Codex schedule${codexCount === 1 ? '' : 's'} default to UI hand-off via the Codex desktop app. Add ${'`'}--via cron${'`'} to the install command for programmatic install on Linux / macOS / Windows.`,
    });
  }
  if (agentMdNotes.length > 0) {
    manualSteps.push({
      description:
        "Roster gets agents from installed skills (`~/.claude/skills/<agent>/`). Customizations in source `<agent>/agent.md` files won't apply — re-create them as project-local overlays if needed.",
    });
  }

  // Tracked files for manifest
  const trackedFiles: { src: string; dest: string }[] = [];
  for (const m of pendingMoves) trackedFiles.push({ src: m.srcPath, dest: m.destPath });
  for (const dc of logCopies) {
    for (const f of dc.files) trackedFiles.push({ src: f.absSrc, dest: join(dc.destDir, f.relSrc) });
  }
  if (envCopy !== null) trackedFiles.push({ src: envCopy.src, dest: envCopy.dest });
  trackedFiles.sort((a, b) => a.src.localeCompare(b.src));

  blockers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    sourceDir: model.sourceDir,
    destWorkspace,
    scheduleInstalls,
    unmappedWrappers,
    pendingMoves,
    logCopies,
    envCopy,
    agentMdNotes,
    subscriptionWarnings,
    manualSteps,
    blockers,
    trackedFiles,
  };
}

