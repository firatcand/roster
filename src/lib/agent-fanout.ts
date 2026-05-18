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

// Matches lines like:
//   - `critic.md` — Reviews each candidate...
//   - critic.md — Reviews each candidate...
//   * `critic.md` — desc
// Captures the bare slug (without `.md`) for recursion.
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
    if (/^##\s+/.test(line)) break; // next H2
    const m = line.match(SUBAGENT_LINE_RE);
    if (m) out.push(m[1]!);
  }
  return out;
}

// Walks agent.md → ## Subagents → list of `<slug>.md` files in the same
// directory; recursively counts how many distinct subagent.md files are
// reachable, and how deep the tree goes. Cycle-resilient and depth-capped.
export function walkFanout(
  agentPath: string,
  depthCap: number = DEFAULT_DEPTH_CAP,
): FanoutResult {
  const warnings: string[] = [];
  const visited = new Set<string>();
  let maxDepth = 0;

  if (!existsSync(agentPath)) {
    warnings.push(`agent file not found: ${agentPath}`);
    return { fanoutCount: 0, depth: 0, warnings };
  }

  const visit = (path: string, currentDepth: number): void => {
    const abs = resolve(path);
    if (visited.has(abs)) {
      warnings.push(`cycle detected at ${abs} — count truncated`);
      return;
    }
    visited.add(abs);

    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      warnings.push(`cannot read ${abs}: ${e.code ?? e.message}`);
      return;
    }

    const slugs = extractSubagentsSection(content);
    if (currentDepth === 0 && slugs.length === 0 && !/^##\s+Subagents/im.test(content)) {
      warnings.push(`${abs}: no '## Subagents' section — assuming 0 fanout`);
    }

    const dir = dirname(abs);
    for (const slug of slugs) {
      // Count each LISTED subagent (even if its .md doesn't resolve, the
      // orchestrator still spawns one call — worst-case for the estimator).
      const childDepth = currentDepth + 1;
      maxDepth = Math.max(maxDepth, childDepth);

      if (childDepth >= depthCap) {
        warnings.push(
          `${abs}: depth >= ${depthCap} reached at '${slug}' — fanout may be undercounted`,
        );
        continue;
      }

      const childPath = join(dir, `${slug}.md`);
      if (!existsSync(childPath)) {
        // Listed but file missing: still count, just don't recurse.
        warnings.push(`${abs}: subagent '${slug}.md' not found (counted, not recursed)`);
        continue;
      }
      visit(childPath, childDepth);
    }
  };

  visit(agentPath, 0);

  // fanoutCount = total distinct subagent.md files visited beyond the root.
  // Subtract 1 for the root agent itself.
  const fanoutCount = Math.max(visited.size - 1, 0);
  return { fanoutCount, depth: maxDepth, warnings };
}
