import { join } from 'node:path';
import type { ToolKey } from '../tools.ts';

// Tools the `skills` CLI can install founder-skills into, mapped to the
// workspace-relative dir it writes to. Keep this in lockstep with roster's own
// project-scope install map (src/lib/install-scope.ts): Codex skills land under
// `.agents/skills/`. Gemini is intentionally absent for v1 (its `.agents/skills/` layout is unverified —
// deferred per ROS-125 plan).
export const SUPPORTED_FOUNDER_TOOLS: readonly ToolKey[] = ['claude', 'codex'];

// `skills` CLI `--agent` identifier per tool.
const AGENT_FLAG: Record<'claude' | 'codex', string> = {
  claude: 'claude-code',
  codex: 'codex',
};

const PROJECT_SUBDIR: Record<'claude' | 'codex', string[]> = {
  claude: ['.claude', 'skills'],
  codex: ['.agents', 'skills'],
};

export function isSupportedFounderTool(key: ToolKey): key is 'claude' | 'codex' {
  return key === 'claude' || key === 'codex';
}

export function agentFlagFor(key: 'claude' | 'codex'): string {
  return AGENT_FLAG[key];
}

export function targetDirFor(workspaceRoot: string, key: 'claude' | 'codex'): string {
  return join(workspaceRoot, ...PROJECT_SUBDIR[key]);
}
