import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ToolKey = 'claude' | 'codex' | 'cursor' | 'gemini';

export type Tool = {
  key: ToolKey;
  name: string;
  skillsTarget: string;
  agentsTarget: string | null;
  // "dir": each skill is a directory copied wholesale (Claude, Gemini)
  // "file": each skill is a single flat file under skillsTarget (Codex, Cursor)
  skillsLayout: 'dir' | 'file';
  // File extension when skillsLayout === 'file' (e.g., ".md", ".mdc"). null for dir layout.
  skillsFileExt: string | null;
};

type ToolDefinition = Tool & { configRoot: string };

// ROSTER_CLAUDE_HOME lets tests redirect Claude writes to a temp dir.
// Honoured here so detectTools() and downstream installs agree on paths.
function claudeHome(): string {
  return process.env['ROSTER_CLAUDE_HOME'] ?? join(homedir(), '.claude');
}

function defaultDefinitions(): ToolDefinition[] {
  const home = homedir();
  const claude = claudeHome();
  return [
    {
      key: 'claude',
      name: 'Claude Code',
      configRoot: claude,
      skillsTarget: join(claude, 'skills'),
      agentsTarget: join(claude, 'agents'),
      skillsLayout: 'dir',
      skillsFileExt: null,
    },
    {
      key: 'codex',
      name: 'Codex CLI',
      configRoot: join(home, '.codex'),
      skillsTarget: join(home, '.codex', 'prompts'),
      agentsTarget: join(home, '.codex', 'agents'),
      skillsLayout: 'file',
      skillsFileExt: '.md',
    },
    {
      key: 'cursor',
      name: 'Cursor',
      configRoot: join(home, '.cursor'),
      skillsTarget: join(home, '.cursor', 'rules'),
      agentsTarget: null,
      skillsLayout: 'file',
      skillsFileExt: '.mdc',
    },
    {
      key: 'gemini',
      name: 'Gemini CLI',
      configRoot: join(home, '.gemini'),
      skillsTarget: join(home, '.gemini', 'extensions'),
      agentsTarget: join(home, '.gemini', 'agents'),
      skillsLayout: 'dir',
      skillsFileExt: null,
    },
  ];
}

function toPublic(def: ToolDefinition): Tool {
  const { configRoot: _configRoot, ...tool } = def;
  return tool;
}

export function detectTools(): Tool[] {
  return defaultDefinitions()
    .filter((def) => existsSync(def.configRoot))
    .map(toPublic);
}

export function getToolByKey(key: ToolKey): Tool | undefined {
  const def = defaultDefinitions().find((d) => d.key === key);
  return def ? toPublic(def) : undefined;
}

export type InstallOptions = {
  skills: string;
  agents: string;
};

export type InstallResult = {
  skillsCount: number;
  skillsTarget: string;
  agentsCount: number;
  agentsTarget: string | null;
};

export function installToTool(_tool: Tool, _opts: InstallOptions): InstallResult {
  throw new Error('installToTool: not implemented yet (ROS-5 / P1-T05)');
}

export type AuditResult = {
  ok: boolean;
  missing: string[];
  stale: string[];
};

export function auditTool(_tool: Tool): AuditResult {
  throw new Error('auditTool: not implemented yet (ROS-19 / P2-T09)');
}
