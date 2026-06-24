import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolKey } from './tools.ts';

export type Scope = 'project' | 'user';

// Sentinel for "the workspace this install would write to". Project-scope
// installs need it; user-scope installs ignore it.
export const SCOPES: readonly Scope[] = ['project', 'user'];

// Workspace detection signal. v1.0 single-project shape means `config/project.yaml`
// is the canonical marker — `roster init` always writes it; nothing else does.
// Keep this in lockstep with src/commands/init.ts's emit path.
export function detectWorkspace(cwd: string): boolean {
  return existsSync(join(cwd, 'config', 'project.yaml'));
}

// Safe default for `--yes` / non-TTY context. In a workspace, install scope
// defaults to project (the v1 "workspace = project" model). Outside, fall
// back to user-scope (matches today's behavior so the README one-liner from
// a non-roster shell doesn't suddenly refuse).
export function defaultScopeForContext(workspaceExists: boolean): Scope {
  return workspaceExists ? 'project' : 'user';
}

type ProjectPaths = {
  configRoot: string;
  installRoot?: string;
  skillsTarget: string;
  agentsTarget: string | null;
};

// Per-tool workspace-relative layout. Kept inline (not factored into tools.ts)
// so a tool refactor doesn't accidentally change scope mapping; this table is
// the contract scope code reads against. Gemini uses `extensions/` for skills
// per its plugin protocol; the other two use `skills/`.
function projectPathsFor(
  toolKey: ToolKey,
  workspaceRoot: string,
  hasAgents: boolean,
): ProjectPaths {
  const agentsPath = (root: string): string | null =>
    hasAgents ? join(workspaceRoot, root, 'agents') : null;

  switch (toolKey) {
    case 'claude':
      return {
        configRoot: join(workspaceRoot, '.claude'),
        skillsTarget: join(workspaceRoot, '.claude', 'skills'),
        agentsTarget: agentsPath('.claude'),
      };
    case 'codex':
      return {
        configRoot: join(workspaceRoot, '.codex'),
        installRoot: workspaceRoot,
        skillsTarget: join(workspaceRoot, '.agents', 'skills'),
        agentsTarget: agentsPath('.codex'),
      };
    case 'gemini':
      return {
        configRoot: join(workspaceRoot, '.gemini'),
        skillsTarget: join(workspaceRoot, '.gemini', 'extensions'),
        agentsTarget: agentsPath('.gemini'),
      };
  }
}

// Project-scope variant of an existing Tool. User-scope returns the input
// unchanged so callers can compose without branching. Throws if scope is
// 'project' but workspaceRoot is missing — that combination is a programmer
// error, not a user error, so it's not a RosterError.
export function toolForScope(tool: Tool, scope: 'user'): Tool;
export function toolForScope(tool: Tool, scope: 'project', workspaceRoot: string): Tool;
export function toolForScope(tool: Tool, scope: Scope, workspaceRoot?: string): Tool {
  if (scope === 'user') return tool;
  if (workspaceRoot === undefined) {
    throw new Error(
      'toolForScope: workspaceRoot is required when scope is "project"',
    );
  }
  const hasAgents = tool.agentsTarget !== null;
  const paths = projectPathsFor(tool.key, workspaceRoot, hasAgents);
  return { ...tool, ...paths };
}
