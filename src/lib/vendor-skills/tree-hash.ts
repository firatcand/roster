import { createHash } from 'node:crypto';

export type SkillTreeHashEntry = {
  path: string;
  content: Uint8Array;
};

const HASH_DOMAIN = Buffer.from('roster-project-skill-tree-v1', 'utf8');

function lengthPrefix(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('Skill tree hash framing requires a safe non-negative length.');
  }
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}

export function hashSkillTree(entries: readonly SkillTreeHashEntry[]): string {
  const ordered = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const seen = new Set<string>();
  const hash = createHash('sha256');
  hash.update(lengthPrefix(HASH_DOMAIN.byteLength));
  hash.update(HASH_DOMAIN);
  hash.update(lengthPrefix(ordered.length));
  for (const entry of ordered) {
    if (entry.path.length === 0 || seen.has(entry.path)) {
      throw new TypeError('Skill tree hash framing requires unique non-empty relative paths.');
    }
    seen.add(entry.path);
    const path = Buffer.from(entry.path, 'utf8');
    hash.update(lengthPrefix(path.byteLength));
    hash.update(path);
    hash.update(lengthPrefix(entry.content.byteLength));
    hash.update(entry.content);
  }
  return `sha256:${hash.digest('hex')}`;
}
