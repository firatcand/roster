import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolKey } from './tools.ts';
import { renderSkillFrontmatterContent } from './frontmatter.ts';

export type ItemStatus = 'ok' | 'missing' | 'stale';
export type ItemKind = 'skill' | 'agent';

export type ItemAudit = {
  kind: ItemKind;
  name: string;
  status: ItemStatus;
  targetPath: string;
  reason?: string;
};

export type ToolAuditResult = {
  tool: ToolKey;
  toolName: string;
  configRoot: string;
  items: ItemAudit[];
  ok: boolean;
};

export type AuditSources = {
  skills: string;
  agents: string;
};

function listDirNames(root: string, kind: 'dir' | 'file'): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => (kind === 'dir' ? d.isDirectory() : d.isFile()))
    .map((d) => d.name)
    .sort();
}

function walkSourceFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string, rel: string): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      const nextRel = rel ? join(rel, dirent.name) : dirent.name;
      if (dirent.isDirectory()) recurse(full, nextRel);
      else if (dirent.isFile()) out.push(nextRel);
    }
  }
  recurse(root, '');
  return out;
}

function auditSkillDir(name: string, srcDir: string, targetDir: string, toolKey: ToolKey): ItemAudit {
  if (!existsSync(targetDir)) {
    return { kind: 'skill', name, status: 'missing', targetPath: targetDir };
  }
  try {
    const files = walkSourceFiles(srcDir);
    for (const rel of files) {
      const tgt = join(targetDir, rel);
      if (!existsSync(tgt)) {
        return { kind: 'skill', name, status: 'stale', targetPath: targetDir, reason: `missing file: ${rel}` };
      }
      // SKILL.md is rendered through renderSkillFrontmatter on install; compare
      // the rendered source to the target so the installed_for injection is not
      // mistaken for drift.
      if (rel === 'SKILL.md') {
        const expected = renderSkillFrontmatterContent(readFileSync(join(srcDir, rel), 'utf8'), toolKey);
        const actual = readFileSync(tgt, 'utf8');
        if (expected !== actual) {
          return { kind: 'skill', name, status: 'stale', targetPath: targetDir, reason: `bytes differ: ${rel}` };
        }
        continue;
      }
      const srcBytes = readFileSync(join(srcDir, rel));
      const tgtBytes = readFileSync(tgt);
      if (Buffer.compare(srcBytes, tgtBytes) !== 0) {
        return { kind: 'skill', name, status: 'stale', targetPath: targetDir, reason: `bytes differ: ${rel}` };
      }
    }
    return { kind: 'skill', name, status: 'ok', targetPath: targetDir };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    return { kind: 'skill', name, status: 'stale', targetPath: targetDir, reason: code };
  }
}

function auditSkillFlatFile(name: string, srcSkillMd: string, targetFile: string, toolKey: ToolKey): ItemAudit {
  if (!existsSync(targetFile)) {
    return { kind: 'skill', name, status: 'missing', targetPath: targetFile };
  }
  try {
    const expected = renderSkillFrontmatterContent(readFileSync(srcSkillMd, 'utf8'), toolKey);
    const actual = readFileSync(targetFile, 'utf8');
    if (expected !== actual) {
      return { kind: 'skill', name, status: 'stale', targetPath: targetFile, reason: 'bytes differ' };
    }
    return { kind: 'skill', name, status: 'ok', targetPath: targetFile };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    return { kind: 'skill', name, status: 'stale', targetPath: targetFile, reason: code };
  }
}

function auditAgentFile(name: string, srcFile: string, targetFile: string): ItemAudit {
  if (!existsSync(targetFile)) {
    return { kind: 'agent', name, status: 'missing', targetPath: targetFile };
  }
  try {
    const srcBytes = readFileSync(srcFile);
    const tgtBytes = readFileSync(targetFile);
    if (Buffer.compare(srcBytes, tgtBytes) !== 0) {
      return { kind: 'agent', name, status: 'stale', targetPath: targetFile, reason: 'bytes differ' };
    }
    return { kind: 'agent', name, status: 'ok', targetPath: targetFile };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
    return { kind: 'agent', name, status: 'stale', targetPath: targetFile, reason: code };
  }
}

// Subscription-billing ban-list: any occurrence is a release blocker.
// Lines that legitimately *document* the ban annotate with the opt-out marker.
//
// Pattern shape: { id: short tag, regex: matcher }. Matched against the trimmed
// content of each line (after stripping the opt-out marker). The id surfaces
// in violation reports so users can search for the exact rule.
type BanRule = { id: string; regex: RegExp };

const BAN_RULES: BanRule[] = [
  { id: 'claude-p-flag', regex: /(^|[^A-Za-z0-9_-])claude\s+-p(\s|$)/ },
  { id: 'claude-prompt-flag', regex: /(^|[^A-Za-z0-9_-])claude\s+--prompt(\s|$)/ },
  { id: 'claude-api-cmd', regex: /(^|[^A-Za-z0-9_-])claude\s+api(\s|$)/ },
  { id: 'anthropic-sdk-import', regex: /['"`]@anthropic-ai\/sdk(?:\/[^'"`]*)?['"`]/ },
  { id: 'python-anthropic-import', regex: /(^|[^A-Za-z0-9_-])from\s+anthropic(\s|$|\.)/ },
];

// Opt-out marker must NAME the rule it suppresses, e.g.
//   <!-- roster-audit-ok: claude-p-flag -->
// Per Codex review #4: an unscoped marker can hide unrelated banned literals
// on the same line. Capture group 1 holds the rule id; only that rule is
// skipped on the line.
const OPT_OUT_MARKER = /<!--\s*roster-audit-ok:\s*([A-Za-z0-9_-]+)\s*-->/;

export type BanlistViolation = {
  file: string;
  line: number;
  ruleId: string;
  preview: string;
};

function isTextFile(name: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|py|sh|yaml|yml|toml|json)$/i.test(name);
}

function walkAllFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  function recurse(dir: string): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) continue;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) recurse(full);
      else if (dirent.isFile() && isTextFile(dirent.name)) out.push(full);
    }
  }
  recurse(root);
  return out;
}

// Scan a list of root paths for banned subscription-billing primitives.
// Each line is checked against every ban rule. Lines containing the opt-out
// marker are skipped. Returns one violation per (file, line, rule) tuple.
export function scanForBannedPrimitives(roots: string[]): BanlistViolation[] {
  const violations: BanlistViolation[] = [];
  for (const root of roots) {
    for (const file of walkAllFiles(root)) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const optOut = line.match(OPT_OUT_MARKER);
        const suppressedRuleId = optOut ? optOut[1] : undefined;
        for (const rule of BAN_RULES) {
          if (suppressedRuleId === rule.id) continue;
          if (rule.regex.test(line)) {
            violations.push({
              file,
              line: i + 1,
              ruleId: rule.id,
              preview: line.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }
  return violations;
}

export function auditTool(tool: Tool, sources: AuditSources): ToolAuditResult {
  const items: ItemAudit[] = [];

  for (const skillName of listDirNames(sources.skills, 'dir')) {
    const srcDir = join(sources.skills, skillName);
    if (tool.skillsLayout === 'file') {
      const srcSkillMd = join(srcDir, 'SKILL.md');
      if (!existsSync(srcSkillMd)) continue;
      const ext = tool.skillsFileExt ?? '.md';
      const targetFile = join(tool.skillsTarget, `${skillName}${ext}`);
      items.push(auditSkillFlatFile(skillName, srcSkillMd, targetFile, tool.key));
    } else {
      // Skip source dirs without SKILL.md — mirrors installToTool's behaviour;
      // such dirs are not real skills and would never reach the target.
      const srcSkillMd = join(srcDir, 'SKILL.md');
      if (!existsSync(srcSkillMd)) continue;
      const targetDir = join(tool.skillsTarget, skillName);
      items.push(auditSkillDir(skillName, srcDir, targetDir, tool.key));
    }
  }

  if (tool.agentsTarget) {
    for (const agentName of listDirNames(sources.agents, 'file')) {
      if (!agentName.endsWith('.md')) continue;
      const srcFile = join(sources.agents, agentName);
      const targetFile = join(tool.agentsTarget, agentName);
      items.push(auditAgentFile(agentName, srcFile, targetFile));
    }
  }

  const ok = items.every((i) => i.status === 'ok');
  return { tool: tool.key, toolName: tool.name, configRoot: tool.configRoot, items, ok };
}
