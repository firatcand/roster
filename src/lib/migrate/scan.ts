import { existsSync, readdirSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parseCrontab, type CrontabLine } from './crontab.ts';
import { parseWrapperFile, type ParsedWrapper, type KnownAgentPath } from './wrapper.ts';

type SourceAgent = {
  name: string;
  parentFunction: string | null;
  dirPath: string;
  hasAgentMd: boolean;
  hasStateMd: boolean;
  pendingDir: string | null;
  logsDir: string | null;
};

type SourceProject = {
  name: string;
  dirPath: string;
  hasStateMd: boolean;
};

type SourcePendingItem = {
  agent: string;
  parentFunction: string | null;
  filePath: string;
  filename: string;
};

type SourceLogTree = {
  agent: string;
  baseDir: string;
  monthDirs: ReadonlyArray<{ month: string; files: ReadonlyArray<string> }>;
};

type SourceEnvInfo = {
  path: string;
  mode: number;
  exists: boolean;
};

export type CronWrapperPair = {
  cron: string;
  crontabLineRaw: string;
  wrapper: ParsedWrapper;
};

export type ScanWarning =
  | { kind: 'subscription-safety'; wrapperPath: string; pattern: string }
  | { kind: 'wrapper-not-found'; cron: string; pathReferenced: string | null }
  | { kind: 'agent-md-present'; agentName: string; agentDir: string };

export type SourceModel = {
  sourceDir: string;
  agents: ReadonlyArray<SourceAgent>;
  projects: ReadonlyArray<SourceProject>;
  pendingItems: ReadonlyArray<SourcePendingItem>;
  agentLogs: ReadonlyArray<SourceLogTree>;
  cronEntries: ReadonlyArray<CronWrapperPair>;
  envFile: SourceEnvInfo | null;
  knownAgentPaths: ReadonlyArray<KnownAgentPath>;
  warnings: ReadonlyArray<ScanWarning>;
};

export type ScanOptions = {
  sourceDir: string;
};

const TOP_LEVEL_SKIP = new Set([
  '.git',
  '.claude',
  '.codex',
  '.gemini',
  '.forge',
  'node_modules',
  'projects',
  'logs',
  'scripts',
  'docs',
  'spec',
  'plans',
  '.config',
  '.vscode',
  '.idea',
]);

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function listSubdirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(p: string, suffix?: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .filter((name) => (suffix ? name.endsWith(suffix) : true))
      .sort();
  } catch {
    return [];
  }
}

function isAgentDir(agentPath: string): boolean {
  // An agent dir has agent.md; this filters out functions (which only have EXPERT.md).
  return fileExists(join(agentPath, 'agent.md'));
}

function scanAgentDir(name: string, parentFunction: string | null, dirPath: string): SourceAgent {
  return {
    name,
    parentFunction,
    dirPath,
    hasAgentMd: fileExists(join(dirPath, 'agent.md')),
    hasStateMd: fileExists(join(dirPath, 'state.md')),
    pendingDir: dirExists(join(dirPath, 'pending')) ? join(dirPath, 'pending') : null,
    logsDir: dirExists(join(dirPath, 'logs')) ? join(dirPath, 'logs') : null,
  };
}

function collectAgents(sourceDir: string): SourceAgent[] {
  const agents: SourceAgent[] = [];

  for (const entry of listSubdirs(sourceDir)) {
    if (TOP_LEVEL_SKIP.has(entry)) continue;
    const entryPath = join(sourceDir, entry);

    if (isAgentDir(entryPath)) {
      agents.push(scanAgentDir(entry, null, entryPath));
      continue;
    }

    for (const nested of listSubdirs(entryPath)) {
      const nestedPath = join(entryPath, nested);
      if (isAgentDir(nestedPath)) {
        agents.push(scanAgentDir(nested, entry, nestedPath));
      }
    }
  }

  agents.sort((a, b) => {
    const aKey = a.parentFunction ? `${a.parentFunction}/${a.name}` : a.name;
    const bKey = b.parentFunction ? `${b.parentFunction}/${b.name}` : b.name;
    return aKey.localeCompare(bKey);
  });

  return agents;
}

function collectProjects(sourceDir: string): SourceProject[] {
  const projectsDir = join(sourceDir, 'projects');
  if (!dirExists(projectsDir)) return [];
  return listSubdirs(projectsDir)
    .map((name) => {
      const dirPath = join(projectsDir, name);
      return {
        name,
        dirPath,
        hasStateMd: fileExists(join(dirPath, 'state.md')),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectPending(agents: ReadonlyArray<SourceAgent>): SourcePendingItem[] {
  const items: SourcePendingItem[] = [];
  for (const agent of agents) {
    if (agent.pendingDir === null) continue;
    for (const fname of listFiles(agent.pendingDir, '.md')) {
      items.push({
        agent: agent.name,
        parentFunction: agent.parentFunction,
        filePath: join(agent.pendingDir, fname),
        filename: fname,
      });
    }
  }
  return items.sort((a, b) => a.filename.localeCompare(b.filename));
}

function collectAgentLogs(agents: ReadonlyArray<SourceAgent>): SourceLogTree[] {
  const trees: SourceLogTree[] = [];
  for (const agent of agents) {
    if (agent.logsDir === null) continue;
    const monthDirs = listSubdirs(agent.logsDir)
      .map((month) => ({
        month,
        files: listFiles(join(agent.logsDir!, month)).map((f) => join(agent.logsDir!, month, f)),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
    if (monthDirs.length === 0) continue;
    trees.push({ agent: agent.name, baseDir: agent.logsDir, monthDirs });
  }
  return trees;
}

function readEnvInfo(sourceDir: string): SourceEnvInfo | null {
  const envPath = join(sourceDir, '.env');
  if (!fileExists(envPath)) return null;
  try {
    const st = statSync(envPath);
    return { path: envPath, mode: st.mode, exists: true };
  } catch {
    return null;
  }
}

function buildKnownAgentPaths(agents: ReadonlyArray<SourceAgent>): KnownAgentPath[] {
  return agents.map((a) => ({
    key: a.parentFunction ? `${a.parentFunction}.${a.name}` : a.name,
    function: a.parentFunction ?? a.name,
    agent: a.name,
  }));
}

function collectCronEntries(sourceDir: string, warnings: ScanWarning[]): CronWrapperPair[] {
  const crontabPath = join(sourceDir, 'scripts', 'cron', 'crontab');
  if (!fileExists(crontabPath)) return [];

  let content: string;
  try {
    content = readFileSync(crontabPath, 'utf8');
  } catch {
    return [];
  }

  const lines = parseCrontab(content);
  const pairs: CronWrapperPair[] = [];

  for (const line of lines) {
    const wrapperPath = resolveWrapperPath(line, sourceDir);
    if (wrapperPath === null) {
      warnings.push({ kind: 'wrapper-not-found', cron: line.cron, pathReferenced: line.wrapperPath });
      continue;
    }
    if (!fileExists(wrapperPath)) {
      warnings.push({ kind: 'wrapper-not-found', cron: line.cron, pathReferenced: line.wrapperPath });
      continue;
    }
    const wrapper = parseWrapperFile(wrapperPath);
    if (wrapper.usesClaudeMinusP) {
      warnings.push({
        kind: 'subscription-safety',
        wrapperPath: relative(sourceDir, wrapper.wrapperPath),
        pattern: 'claude -p',
      });
    }
    pairs.push({ cron: line.cron, crontabLineRaw: line.raw, wrapper });
  }

  return pairs.sort((a, b) => a.wrapper.basename.localeCompare(b.wrapper.basename));
}

function resolveWrapperPath(line: CrontabLine, sourceDir: string): string | null {
  if (line.wrapperPath === null) return null;
  if (line.wrapperPath.startsWith('/')) {
    // Use realpathSync (not lexical path.resolve) so a symlink planted inside sourceDir
    // that targets an ancestor cannot bypass containment. realpathSync throws on missing
    // paths — fall back to basename translation (same UX as the pre-existing "wrong
    // absolute path" branch).
    try {
      const realDir = realpathSync(sourceDir);
      const realPath = realpathSync(line.wrapperPath);
      if (realPath === realDir || realPath.startsWith(realDir + sep)) {
        return realPath;
      }
    } catch {
      // Fall through to basename translation.
    }
    const base = basename(line.wrapperPath);
    return join(sourceDir, 'scripts', 'cron', 'wrappers', base);
  }
  return join(sourceDir, line.wrapperPath);
}

export function scanSourceWorkspace(opts: ScanOptions): SourceModel {
  const sourceDir = opts.sourceDir;
  if (!existsSync(sourceDir)) {
    throw new Error(`scanSourceWorkspace: sourceDir does not exist: ${sourceDir}`);
  }

  const warnings: ScanWarning[] = [];
  const agents = collectAgents(sourceDir);
  for (const agent of agents) {
    if (agent.hasAgentMd) {
      warnings.push({ kind: 'agent-md-present', agentName: agent.name, agentDir: relative(sourceDir, agent.dirPath) });
    }
  }
  const projects = collectProjects(sourceDir);
  const pendingItems = collectPending(agents);
  const agentLogs = collectAgentLogs(agents);
  const envFile = readEnvInfo(sourceDir);
  const knownAgentPaths = buildKnownAgentPaths(agents);
  const cronEntries = collectCronEntries(sourceDir, warnings);

  warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    sourceDir,
    agents,
    projects,
    pendingItems,
    agentLogs,
    cronEntries,
    envFile,
    knownAgentPaths,
    warnings,
  };
}

export function isLikelyRosterWorkspace(dir: string): boolean {
  return fileExists(join(dir, 'CONTEXT.md')) || dirExists(join(dir, 'roster'));
}
