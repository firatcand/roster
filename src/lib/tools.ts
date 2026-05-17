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
  // "md-copy": copy source agents/<name>.md verbatim to agentsTarget (Claude, Gemini).
  // "codex-toml": render source to <name>.toml + <name>.persona.md per ROS-33 / ADR-0001.
  agentsLayout: 'md-copy' | 'codex-toml';
  installLink: string;
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
      agentsLayout: 'md-copy',
      installLink: 'https://claude.ai/code',
    },
    {
      key: 'codex',
      name: 'Codex CLI',
      configRoot: codex,
      skillsTarget: join(codex, 'skills'),
      agentsTarget: join(codex, 'agents'),
      agentsLayout: 'codex-toml',
      installLink: 'https://github.com/openai/codex',
    },
    {
      key: 'gemini',
      name: 'Gemini CLI',
      configRoot: gemini,
      skillsTarget: join(gemini, 'extensions'),
      agentsTarget: join(gemini, 'agents'),
      agentsLayout: 'md-copy',
      installLink: 'https://github.com/google-gemini/gemini-cli',
    },
  ];
}

export function detectTools(): Tool[] {
  return defaultDefinitions().filter((def) => existsSync(def.configRoot));
}

export function allTools(): Tool[] {
  return defaultDefinitions();
}

export function getToolByKey(key: ToolKey): Tool | undefined {
  return defaultDefinitions().find((d) => d.key === key);
}

// installToTool lives in ./install.ts (ROS-5). auditTool lives in ./audit.ts (ROS-19).
