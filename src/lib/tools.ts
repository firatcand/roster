import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ToolKey = 'claude' | 'codex' | 'gemini';

export type Tool = {
  key: ToolKey;
  name: string;
  configRoot: string;
  skillsTarget: string;
  agentsTarget: string | null;
  // "dir": each skill is a directory copied wholesale (Claude, Gemini)
  // "file": each skill is a single flat file under skillsTarget (Codex)
  skillsLayout: 'dir' | 'file';
  // File extension when skillsLayout === 'file' (e.g., ".md", ".mdc"). null for dir layout.
  skillsFileExt: string | null;
};

type ToolDefinition = Tool;

// ROSTER_{CLAUDE,CODEX,GEMINI}_HOME let tests redirect writes to a temp dir.
// Honoured here so detectTools() and downstream installs agree on paths.
function claudeHome(): string {
  return process.env['ROSTER_CLAUDE_HOME'] ?? join(homedir(), '.claude');
}

function codexHome(): string {
  return process.env['ROSTER_CODEX_HOME'] ?? join(homedir(), '.codex');
}

function geminiHome(): string {
  return process.env['ROSTER_GEMINI_HOME'] ?? join(homedir(), '.gemini');
}

function defaultDefinitions(): ToolDefinition[] {
  const claude = claudeHome();
  const codex = codexHome();
  const gemini = geminiHome();
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
      configRoot: codex,
      skillsTarget: join(codex, 'prompts'),
      agentsTarget: join(codex, 'agents'),
      skillsLayout: 'file',
      skillsFileExt: '.md',
    },
    {
      key: 'gemini',
      name: 'Gemini CLI',
      configRoot: gemini,
      skillsTarget: join(gemini, 'extensions'),
      agentsTarget: join(gemini, 'agents'),
      skillsLayout: 'dir',
      skillsFileExt: null,
    },
  ];
}

export function detectTools(): Tool[] {
  return defaultDefinitions().filter((def) => existsSync(def.configRoot));
}

export function getToolByKey(key: ToolKey): Tool | undefined {
  return defaultDefinitions().find((d) => d.key === key);
}

// installToTool lives in ./install.ts (ROS-5). auditTool lives in ./audit.ts (ROS-19).
