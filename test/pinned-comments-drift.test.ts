import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

const SCAN_DIRS = ['src', 'test', 'skills', 'templates', 'scripts'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.md', '.sh']);
// Only skip dirs that would never contain a load-bearing pinned comment.
// Do NOT skip `lib` or `bin` here — `src/lib/` and `src/bin/` are real source paths.
const SKIP_DIRS = new Set(['node_modules', '.git']);

type Match = {
  file: string;
  lineNumber: number;
  raw: string;
  skill: string;
  rest: string;
};

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (stat.isFile()) {
      const dot = entry.lastIndexOf('.');
      const ext = dot >= 0 ? entry.slice(dot) : '';
      if (SCAN_EXTS.has(ext)) yield full;
    }
  }
}

function collectMatches(): Match[] {
  const re = /Pinned to skills\/([^/\s]+)\/SKILL\.md\s+(.+?)\s*$/;
  const out: Match[] = [];
  for (const top of SCAN_DIRS) {
    const root = join(REPO_ROOT, top);
    try {
      statSync(root);
    } catch {
      continue;
    }
    for (const file of walk(root)) {
      if (file === __filename) continue;
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(re);
        if (!m) continue;
        out.push({
          file: relative(REPO_ROOT, file),
          lineNumber: i + 1,
          raw: lines[i]!,
          skill: m[1]!,
          rest: m[2]!,
        });
      }
    }
  }
  return out;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:]+$/, '').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findHeading(skillMd: string, sectionName: string): boolean {
  const escaped = escapeRegex(sectionName);
  const re = new RegExp(`^#+\\s+${escaped}\\s*$`, 'm');
  return re.test(skillMd);
}

test('pinned SKILL.md comments use § <section> form, not line numbers', () => {
  const matches = collectMatches();
  assert.ok(
    matches.length > 0,
    'sanity: expected at least one `Pinned to skills/.../SKILL.md` comment in the repo',
  );

  const offenders: string[] = [];
  for (const m of matches) {
    if (m.rest.startsWith('§')) continue;
    if (m.rest.match(/^lines?\s+\d/i)) {
      offenders.push(
        `${m.file}:${m.lineNumber}: line-number form '${m.rest}' — rewrite as '§ <section name>' (line numbers go stale on SKILL renumber).`,
      );
    } else {
      offenders.push(
        `${m.file}:${m.lineNumber}: unrecognized anchor '${m.rest}' — use '§ <section name>'.`,
      );
    }
  }
  assert.equal(offenders.length, 0, `pinned-comments form drift:\n  ${offenders.join('\n  ')}`);
});

test('pinned SKILL.md comments cite a section that actually exists', () => {
  const matches = collectMatches();
  const skillMdCache = new Map<string, string>();
  const offenders: string[] = [];

  for (const m of matches) {
    if (!m.rest.startsWith('§')) continue;
    const sectionRaw = m.rest.replace(/^§\s+/, '');
    const sectionName = stripTrailingPunct(sectionRaw);

    const skillPath = join(REPO_ROOT, 'skills', m.skill, 'SKILL.md');
    let skillMd = skillMdCache.get(skillPath);
    if (skillMd === undefined) {
      try {
        skillMd = readFileSync(skillPath, 'utf8');
        skillMdCache.set(skillPath, skillMd);
      } catch {
        offenders.push(
          `${m.file}:${m.lineNumber}: cited skill 'skills/${m.skill}/SKILL.md' not found.`,
        );
        continue;
      }
    }

    if (!findHeading(skillMd, sectionName)) {
      offenders.push(
        `${m.file}:${m.lineNumber}: section '§ ${sectionName}' not found as a heading in skills/${m.skill}/SKILL.md (rename or relocate the comment).`,
      );
    }
  }

  assert.equal(offenders.length, 0, `pinned-comments content drift:\n  ${offenders.join('\n  ')}`);
});
