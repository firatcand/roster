import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnvFile } from './dotenv-parse.ts';

// Mirrors SKIP_TOP in doctor-secrets-audit.ts. Kept local to avoid a back-import
// cycle (runSecretsAudit imports auditAgentEnvRedundancy). ROS-85/87 will likely
// converge this into a shared walker once all three v1 agent-env checks land.
const SKIP_TOP = new Set([
  'roster',
  'node_modules',
  'plans',
  'spec',
  'docs',
  'bin',
  'lib',
  'skills',
  'agents',
  'templates',
  'test',
  'src',
]);

export type AgentEnvRedundancyItem = {
  agentEnvPath: string;
  line: number;
  key: string;
};

export type AgentEnvRedundancyResult = {
  status: 'ok' | 'warn';
  items: AgentEnvRedundancyItem[];
};

function collectAgentEnvFiles(cwd: string): string[] {
  const out: string[] = [];
  let topEntries: string[];
  try {
    topEntries = readdirSync(cwd);
  } catch {
    return [];
  }

  for (const top of topEntries) {
    if (top.startsWith('.')) continue;
    if (SKIP_TOP.has(top)) continue;
    const fnDir = join(cwd, top);
    let fnSt: Stats;
    try {
      fnSt = statSync(fnDir);
    } catch {
      continue;
    }
    if (!fnSt.isDirectory()) continue;

    let agents: string[];
    try {
      agents = readdirSync(fnDir);
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (agent.startsWith('.')) continue;
      const agentDir = join(fnDir, agent);
      let aSt: Stats;
      try {
        aSt = statSync(agentDir);
      } catch {
        continue;
      }
      if (!aSt.isDirectory()) continue;
      const envPath = join(agentDir, '.env');
      let eSt: Stats;
      try {
        eSt = statSync(envPath);
      } catch {
        continue;
      }
      if (!eSt.isFile()) continue;
      out.push(envPath);
    }
  }
  return out;
}

// Locates the 1-based line where `key` is effectively defined in `rawContent`.
// parseEnvFile is last-wins on duplicate keys (Map.set overwrites), so this
// scan must return the LAST occurrence to stay in lockstep with the parser.
// Reporting an earlier shadowed line would target the wrong line for deletion.
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;

export function findLastLineForKey(rawContent: string, key: string): number | null {
  let content = rawContent;
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const lines = content.split(/\r?\n/);
  let lastMatch: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').replace(/^\s+/, '');
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const candidate = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).replace(/^\s+/, '')
      : trimmed;
    const m = candidate.match(KEY_RE);
    if (m === null) continue;
    if (m[1] === key) lastMatch = i + 1;
  }
  return lastMatch;
}

export function auditAgentEnvRedundancy(cwd: string): AgentEnvRedundancyResult {
  let workspaceMap: Map<string, string>;
  try {
    workspaceMap = parseEnvFile(readFileSync(join(cwd, '.env'), 'utf8'));
  } catch {
    return { status: 'ok', items: [] };
  }

  const items: AgentEnvRedundancyItem[] = [];
  for (const envPath of collectAgentEnvFiles(cwd)) {
    let raw: string;
    try {
      raw = readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }
    const agentMap = parseEnvFile(raw);
    for (const [key, value] of agentMap) {
      const wsValue = workspaceMap.get(key);
      if (wsValue === undefined) continue;
      if (wsValue !== value) continue;
      const line = findLastLineForKey(raw, key);
      if (line === null) continue;
      items.push({
        agentEnvPath: relative(cwd, envPath),
        line,
        key,
      });
    }
  }

  items.sort((a, b) => {
    if (a.agentEnvPath !== b.agentEnvPath) {
      return a.agentEnvPath.localeCompare(b.agentEnvPath);
    }
    return a.line - b.line;
  });

  return {
    status: items.length === 0 ? 'ok' : 'warn',
    items,
  };
}

export type RemoveLineOutcome =
  | { kind: 'removed' }
  | { kind: 'would-remove' }
  | { kind: 'changed'; reason: string }
  | { kind: 'error'; message: string };

// Re-reads `absPath` and removes the line at `oneBasedLine` only if that line
// (a) still declares `expectedKey` AND (b) still parses to `expectedValue`.
// The dual guard catches concurrent edits during a long interactive prompt
// session — a user could change the line's value to something no longer
// redundant; we must NOT delete it in that case. Atomic write via temp file +
// rename, preserving existing mode bits and original newline style (LF vs CRLF).
export function removeLineForKey(
  absPath: string,
  oneBasedLine: number,
  expectedKey: string,
  expectedValue: string,
  dryRun: boolean,
): RemoveLineOutcome {
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  const hadTrailingNewline = raw.length > 0 && raw.charCodeAt(raw.length - 1) === 0x0a;
  const usesCRLF = /\r\n/.test(raw);
  const newline = usesCRLF ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const effectiveLineCount = hadTrailingNewline ? lines.length - 1 : lines.length;
  if (oneBasedLine < 1 || oneBasedLine > effectiveLineCount) {
    return { kind: 'changed', reason: 'line out of range' };
  }
  const targetLine = lines[oneBasedLine - 1] ?? '';
  const trimmed = targetLine.replace(/^\s+/, '');
  const candidate = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).replace(/^\s+/, '')
    : trimmed;
  const m = candidate.match(KEY_RE);
  if (m === null || m[1] !== expectedKey) {
    return { kind: 'changed', reason: 'line no longer declares expected key' };
  }
  // Verify the parsed value of THIS line still matches the redundancy snapshot.
  // Re-using parseEnvFile on a single-line buffer keeps quoting / escape rules
  // identical to the audit's comparison.
  const singleLineMap = parseEnvFile(targetLine);
  const parsedAtLine = singleLineMap.get(expectedKey);
  if (parsedAtLine === undefined || parsedAtLine !== expectedValue) {
    return { kind: 'changed', reason: 'line value no longer matches workspace' };
  }
  if (dryRun) return { kind: 'would-remove' };

  const kept = lines.slice(0, oneBasedLine - 1).concat(lines.slice(oneBasedLine));
  const next = kept.join(newline);

  let mode = 0o600;
  try {
    mode = statSync(absPath).mode & 0o777;
  } catch {
    // statSync failure here is unusual (we just read the file) but non-fatal
    // for the write path — fall back to 0o600.
  }

  const tmpPath = absPath + '.tmp.' + String(process.pid);
  try {
    writeFileSync(tmpPath, next, { mode });
    renameSync(tmpPath, absPath);
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
  return { kind: 'removed' };
}
