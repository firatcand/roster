import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontMatter } from './front-matter.ts';

export type PendingItem = {
  function: string;
  path: string;
  filename: string;
  frontMatter: Record<string, unknown>;
  body: string;
};

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listFunctionDirs(rosterDir: string): string[] {
  try {
    return readdirSync(rosterDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listPendingFiles(pendingDir: string): string[] {
  try {
    return readdirSync(pendingDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function scanPending(cwd: string, fn?: string): PendingItem[] {
  const rosterDir = join(cwd, 'roster');
  if (!dirExists(rosterDir)) return [];

  const functions = fn !== undefined ? [fn] : listFunctionDirs(rosterDir);
  const items: PendingItem[] = [];

  for (const f of functions) {
    const pendingDir = join(rosterDir, f, 'pending');
    if (!dirExists(pendingDir)) continue;

    for (const filename of listPendingFiles(pendingDir)) {
      const itemPath = join(pendingDir, filename);
      let content: string;
      try {
        content = readFileSync(itemPath, 'utf8');
      } catch {
        continue;
      }
      const { frontMatter, body } = parseFrontMatter(content);
      items.push({
        function: f,
        path: itemPath,
        filename: basename(itemPath),
        frontMatter,
        body,
      });
    }
  }

  return items;
}

export function countPending(cwd: string): number {
  return scanPending(cwd).length;
}
