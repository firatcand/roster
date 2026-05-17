// Regenerate test/golden/content-agent/ from the canonical fixture and the
// pure render() function. Invoked via `pnpm test:update-golden`. Single
// responsibility: load fixture, render, write golden tree.
//
// Run this whenever the SKILL.md contract or templates.ts constants change.
// Review the resulting diff carefully — any byte change here is a contract
// shift that the next ROS-55 invariant tests will also need to track.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture } from '../src/lib/create-agent/fixture-schema.ts';
import { render } from '../src/lib/create-agent/render.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

const FIXTURE_PATH = join(repoRoot, 'test/fixtures/guided-content-agent.yaml');
const GOLDEN_ROOT = join(repoRoot, 'test/golden/content-agent');
const EXPERT_PATH = join(repoRoot, 'templates/scaffold/gtm/EXPERT.md');

function readExpert(): string | null {
  try {
    return readFileSync(EXPERT_PATH, 'utf8');
  } catch {
    return null;
  }
}

function main(): void {
  const fixture = loadFixture(FIXTURE_PATH);
  const expert = readExpert();
  const output = render({ fixture, expert });

  rmSync(GOLDEN_ROOT, { recursive: true, force: true });

  // Write the agent tree (everything in output.files)
  let fileCount = 0;
  for (const [relPath, content] of output.files) {
    const absPath = join(GOLDEN_ROOT, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf8');
    fileCount += 1;
  }

  // Write the slash command (separately tracked path)
  const slashAbsPath = join(GOLDEN_ROOT, output.slashCommand.path);
  mkdirSync(dirname(slashAbsPath), { recursive: true });
  writeFileSync(slashAbsPath, output.slashCommand.content, 'utf8');
  fileCount += 1;

  console.log(`Wrote ${fileCount} files to ${GOLDEN_ROOT}`);
  console.log(`  ${output.dirs.length} dirs declared by render()`);
}

main();
