import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool, ToolKey } from './tools.ts';

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

function auditSkillDir(name: string, srcDir: string, targetDir: string): ItemAudit {
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

function auditSkillFlatFile(name: string, srcSkillMd: string, targetFile: string): ItemAudit {
  if (!existsSync(targetFile)) {
    return { kind: 'skill', name, status: 'missing', targetPath: targetFile };
  }
  try {
    const srcBytes = readFileSync(srcSkillMd);
    const tgtBytes = readFileSync(targetFile);
    if (Buffer.compare(srcBytes, tgtBytes) !== 0) {
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

export function auditTool(tool: Tool, sources: AuditSources): ToolAuditResult {
  const items: ItemAudit[] = [];

  for (const skillName of listDirNames(sources.skills, 'dir')) {
    const srcDir = join(sources.skills, skillName);
    if (tool.skillsLayout === 'file') {
      const srcSkillMd = join(srcDir, 'SKILL.md');
      if (!existsSync(srcSkillMd)) continue;
      const ext = tool.skillsFileExt ?? '.md';
      const targetFile = join(tool.skillsTarget, `${skillName}${ext}`);
      items.push(auditSkillFlatFile(skillName, srcSkillMd, targetFile));
    } else {
      const targetDir = join(tool.skillsTarget, skillName);
      items.push(auditSkillDir(skillName, srcDir, targetDir));
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
