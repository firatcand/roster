import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { join } from 'node:path';
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

  const rl = createInterface({ input: deps.stdin, output: deps.stdout, terminal: false });
  try {
    for (const item of items) {
      const absPath = join(cwd, item.agentEnvPath);
      const label = `${item.agentEnvPath}:${item.line} ${item.key}`;
      deps.stdout.write(`Delete ${label}? [y/N] `);
      const answer = (await readOneLine(rl)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        out.skipped.push(label);
        continue;
      }
      const result = removeLineForKey(absPath, item.line, item.key, dryRun);
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

function readOneLine(rl: ReadlineInterface): Promise<string> {
  return new Promise((resolve) => {
    const onLine = (line: string): void => {
      rl.off('close', onClose);
      resolve(line);
    };
    const onClose = (): void => {
      rl.off('line', onLine);
      resolve('');
    };
    rl.once('line', onLine);
    rl.once('close', onClose);
  });
}
