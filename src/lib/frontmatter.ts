import type { ToolKey } from './tools.ts';

// Pure function shared by install.ts (mutates target SKILL.md on write) and
// audit.ts (renders source in-memory before byte-compare with target). Keeping
// the transform in one place avoids the mutation-symmetry bug class described
// in docs/learnings/2026-Q2/installer-mutations-need-drift-detector-mirror.md.
//
// Behavior:
//   - If the input has a leading YAML frontmatter block (`^---\n...\n---\n`),
//     replaces any prior `installed_for:` line in that block and appends
//     `installed_for: <toolKey>` as the last frontmatter field.
//   - If the input has no frontmatter block, returns it unchanged.
//   - Idempotent: rendering with the same toolKey twice yields the same output.
export function renderSkillFrontmatterContent(content: string, toolKey: ToolKey): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return content;
  const fmBody = fmMatch[1] ?? '';
  const lines = fmBody.split('\n').filter((l) => !/^installed_for:\s/.test(l));
  lines.push(`installed_for: ${toolKey}`);
  const newFm = `---\n${lines.join('\n')}\n---\n`;
  return newFm + content.slice(fmMatch[0].length);
}
