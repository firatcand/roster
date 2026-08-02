import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVendorSkillMap } from '../../../src/lib/workspace-registry.ts';
import { VENDOR_SKILL_MAP_PATH } from '../../../src/lib/vendor-skills/adapter-map.ts';

export type SocialManagerContextFixture = {
  root: string;
  cleanup: () => void;
};

const sourceRoot = dirname(fileURLToPath(import.meta.url));

export function buildSocialManagerContextFixture(): SocialManagerContextFixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-social-manager-context-'));
  for (const entry of ['roster.yaml', 'ROSTER.md', 'functions', 'tools']) {
    cpSync(join(sourceRoot, entry), join(root, entry), { recursive: true });
  }
  const prepared = prepareVendorSkillMap(root);
  const mapPath = join(root, VENDOR_SKILL_MAP_PATH);
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, prepared.content);
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
