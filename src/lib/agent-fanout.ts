import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Walks an agent.md tree, counting `## Subagents` listings recursively.
// No declared frontmatter field for fanout exists yet — see ROS-44 plan §D1.
// We parse the markdown convention agents already use.

export type FanoutResult = {
  fanoutCount: number;
  depth: number;
  warnings: string[];
};

export const DEFAULT_DEPTH_CAP = 4;

const SUBAGENT_LINE_RE = /^\s*[-*]\s+`?([a-z0-9][a-z0-9_-]*)\.md`?/i;

function extractSubagentsSection(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const heading = /^##\s+Subagents\s*$/i;
  let i = 0;
  while (i < lines.length && !heading.test(lines[i]!)) i++;
  if (i >= lines.length) return [];

  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (/^##\s+/.test(line)) break;
    const m = line.match(SUBAGENT_LINE_RE);
    if (m) out.push(m[1]!);
  }
  return out;
}

// Counts subagent invocations from an orchestrator agent.md tree. Each listed
// edge in any reachable `## Subagents` section is one estimated message — a
// diamond graph (A → B and A → C both pointing at D) counts D twice because
// each invocation is a distinct message from the orchestrator's perspective.
// True cycles (a node revisits an ancestor on the current path) are detected
// via the recursion stack — not the parse cache — so shared subagents in
// independent subtrees don't false-trigger cycle warnings.
export function walkFanout(
  agentPath: string,
  depthCap: number = DEFAULT_DEPTH_CAP,
): FanoutResult {
  const warnings: string[] = [];
  const stack = new Set<string>();
  const parsed = new Map<string, string[]>();
  let maxDepth = 0;
  let fanoutCount = 0;

  if (!existsSync(agentPath)) {
    warnings.push(`agent file not found: ${agentPath}`);
    return { fanoutCount: 0, depth: 0, warnings };
  }

  const visit = (path: string, depth: number): void => {
    const abs = resolve(path);
    if (stack.has(abs)) {
      warnings.push(`${abs}: cycle detected — recursion truncated`);
      return;
    }

    let slugs = parsed.get(abs);
    if (slugs === undefined) {
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        warnings.push(`cannot read ${abs}: ${e.code ?? e.message}`);
        parsed.set(abs, []);
        return;
      }
      slugs = extractSubagentsSection(content);
      if (depth === 0 && slugs.length === 0 && !/^##\s+Subagents/im.test(content)) {
        warnings.push(`${abs}: no '## Subagents' section — assuming 0 fanout`);
      }
      parsed.set(abs, slugs);
    }

    stack.add(abs);
    const dir = dirname(abs);
    for (const slug of slugs) {
      fanoutCount++;
      const childDepth = depth + 1;
      maxDepth = Math.max(maxDepth, childDepth);

      if (childDepth >= depthCap) {
        warnings.push(
          `${abs}: depth >= ${depthCap} reached at '${slug}' — deeper fanout not recursed`,
        );
        continue;
      }

      const childPath = join(dir, `${slug}.md`);
      if (!existsSync(childPath)) {
        warnings.push(`${abs}: subagent '${slug}.md' not found (counted, not recursed)`);
        continue;
      }
      visit(childPath, childDepth);
    }
    stack.delete(abs);
  };

  visit(agentPath, 0);
  return { fanoutCount, depth: maxDepth, warnings };
}
