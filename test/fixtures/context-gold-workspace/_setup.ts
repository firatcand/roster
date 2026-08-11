import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVendorSkillMap } from '../../../src/lib/workspace-registry.ts';
import { VENDOR_SKILL_MAP_PATH } from '../../../src/lib/vendor-skills/adapter-map.ts';

export type ContextGoldRegistryVariant = 'local' | 'brain' | 'partial';

export type ContextGoldWorkspaceFixture = {
  root: string;
  registry: ContextGoldRegistryVariant;
  cleanup: () => void;
};

const sourceRoot = dirname(fileURLToPath(import.meta.url));

export const CONTEXT_GOLD_WORKSPACE_SOURCE = sourceRoot;

// The partial variant is DERIVED from the checked-in brain variant, never
// authored a third time: dropping the complete `storage` block from the
// complete registry is exactly the half-declared Brain the contract's
// BRAIN_CONFIGURATION_INCOMPLETE failure envelope exists for.
export function derivePartialRegistry(brainRegistryText: string): string {
  const lines = brainRegistryText.split('\n');
  const start = lines.findIndex((line) => line === '  storage:');
  if (start < 0) throw new Error('roster.brain.yaml no longer declares a storage block');
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('    ')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

export function buildContextGoldWorkspace(
  options: Readonly<{ registry?: ContextGoldRegistryVariant }> = {},
): ContextGoldWorkspaceFixture {
  const registry = options.registry ?? 'local';
  const root = mkdtempSync(join(tmpdir(), 'roster-context-gold-workspace-'));
  for (const entry of ['ROSTER.md', 'functions', 'tools']) {
    cpSync(join(sourceRoot, entry), join(root, entry), { recursive: true });
  }
  if (registry === 'local') {
    copyFileSync(join(sourceRoot, 'roster.yaml'), join(root, 'roster.yaml'));
  } else if (registry === 'brain') {
    copyFileSync(join(sourceRoot, 'roster.brain.yaml'), join(root, 'roster.yaml'));
  } else {
    const brainText = readFileSync(join(sourceRoot, 'roster.brain.yaml'), 'utf8');
    writeFileSync(join(root, 'roster.yaml'), derivePartialRegistry(brainText));
  }
  // A partial registry cannot produce a workspace snapshot at all — `roster
  // context` must fail before any generated map is read — so the vendor map is
  // materialized only for the two complete variants.
  if (registry !== 'partial') {
    const prepared = prepareVendorSkillMap(root);
    const mapPath = join(root, VENDOR_SKILL_MAP_PATH);
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, prepared.content);
  }
  return {
    root,
    registry,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
