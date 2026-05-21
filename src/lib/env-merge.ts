import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from './dotenv-parse.ts';

// Per SPEC §Flow 2: agent .env overrides workspace .env per key.
// Empty-string value (`K=`) in agent .env = explicit unset (masks the workspace
// value). Empty-string in workspace .env is treated symmetrically — as if K
// were never declared. Missing files are not errors; treat as absent.
export function resolveAgentEnv(
  workspaceRoot: string,
  agentPath: string,
): Record<string, string> {
  const workspace = tryReadAndParse(join(workspaceRoot, '.env'));
  const agent = tryReadAndParse(join(workspaceRoot, agentPath, '.env'));

  const out: Record<string, string> = {};
  for (const [k, v] of workspace) {
    if (v.length === 0) continue;
    out[k] = v;
  }
  for (const [k, v] of agent) {
    if (v.length === 0) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function tryReadAndParse(path: string): Map<string, string> {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}
