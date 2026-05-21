import { readFileSync } from 'node:fs';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
import { parseEnvFile } from './dotenv-parse.ts';
import {
  removeLineForKey,
  type AgentEnvRedundancyItem,
} from './doctor-agent-env-audit.ts';

export type FixPromptDeps = {
  isTTY: boolean;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
};

export type FixPromptOutcome = {
  deleted: string[];
  failed: Array<{ what: string; error: string }>;
  skipped: string[];
  nonTtySkipped: boolean;
};

export async function confirmAndDeleteRedundantLines(
  items: ReadonlyArray<AgentEnvRedundancyItem>,
  cwd: string,
  deps: FixPromptDeps,
  dryRun: boolean,
): Promise<FixPromptOutcome> {
  const out: FixPromptOutcome = {
    deleted: [],
    failed: [],
    skipped: [],
    nonTtySkipped: false,
  };
  if (items.length === 0) return out;
  if (!deps.isTTY) {
    out.nonTtySkipped = true;
    return out;
  }

  // Re-read workspace .env once for per-key expected values. The dual-guard
  // in removeLineForKey verifies the agent line still matches THIS snapshot —
  // if the workspace .env changes between audit and prompt for a key, items
  // referencing that key will be rejected as "value no longer matches".
  let workspaceMap = new Map<string, string>();
  try {
    workspaceMap = parseEnvFile(readFileSync(join(cwd, '.env'), 'utf8'));
  } catch {
    // No workspace .env — every item will fail the value-match guard, which
    // is the correct behavior (nothing is redundant against a missing file).
  }

  const rl = createInterface({ input: deps.stdin, output: deps.stdout, terminal: false });
  let stdinClosed = false;
  rl.once('close', () => {
    stdinClosed = true;
  });

  try {
    for (const item of items) {
      const absPath = join(cwd, item.agentEnvPath);
      const label = `${item.agentEnvPath}:${item.line} ${item.key}`;
      if (stdinClosed) {
        out.skipped.push(`${label}: stdin closed`);
        continue;
      }

      deps.stdout.write(`Delete ${label}? [y/N] `);
      const answer = await readOneLine(rl);
      if (answer === null) {
        // EOF received mid-session — treat the remaining items as skipped.
        stdinClosed = true;
        out.skipped.push(`${label}: stdin closed`);
        continue;
      }
      const normalized = answer.trim().toLowerCase();
      if (normalized !== 'y' && normalized !== 'yes') {
        out.skipped.push(label);
        continue;
      }

      const expectedValue = workspaceMap.get(item.key);
      if (expectedValue === undefined) {
        out.failed.push({
          what: label,
          error: 'workspace .env no longer declares this key',
        });
        continue;
      }

      const result = removeLineForKey(absPath, item.line, item.key, expectedValue, dryRun);
      if (result.kind === 'removed') {
        out.deleted.push(`${label}: removed`);
      } else if (result.kind === 'would-remove') {
        out.deleted.push(`${label}: would remove (dry-run)`);
      } else if (result.kind === 'changed') {
        out.failed.push({ what: label, error: `file changed (${result.reason})` });
      } else {
        out.failed.push({ what: label, error: result.message });
      }
    }
  } finally {
    rl.close();
  }

  return out;
}

// Resolves to the line on success, or null on EOF. `settled` guards against
// the race where `line` and `close` could fire near-simultaneously.
function readOneLine(rl: ReadlineInterface): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const onLine = (line: string): void => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      resolve(line);
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      rl.off('line', onLine);
      resolve(null);
    };
    rl.once('line', onLine);
    rl.once('close', onClose);
  });
}
