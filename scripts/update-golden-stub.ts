// Regenerate test/golden/stub-agent/ by running templates/scaffold/scripts/new-agent.sh
// in a tmp workspace. Invoked via `pnpm test:update-golden:stub`.
//
// Run this when scripts/new-agent.sh intentionally changes. Review the
// resulting diff carefully — any byte change is a stub-mode contract shift
// that the create-agent.stub.test.ts regression test will pick up.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

const SOURCE_SCRIPT = join(repoRoot, 'templates/scaffold/scripts/new-agent.sh');
const SOURCE_LIB = join(repoRoot, 'templates/scaffold/scripts/lib');
const GOLDEN_ROOT = join(repoRoot, 'test/golden/stub-agent');

// Pinned slugs — deterministic so the golden snapshot is stable across runs.
const STUB_FN = 'stub-fn';
const STUB_AGENT = 'stub-agent';

function main(): void {
  const workspace = mkdtempSync(join(tmpdir(), 'roster-stub-golden-'));
  try {
    mkdirSync(join(workspace, 'scripts/lib'), { recursive: true });
    mkdirSync(join(workspace, '.config'), { recursive: true });

    cpSync(SOURCE_SCRIPT, join(workspace, 'scripts/new-agent.sh'));
    cpSync(SOURCE_LIB, join(workspace, 'scripts/lib'), { recursive: true });
    writeFileSync(
      join(workspace, '.config/functions.yaml'),
      `functions:\n  - slug: ${STUB_FN}\n    label: Stub Function\n`,
      'utf8',
    );

    execFileSync('bash', ['scripts/new-agent.sh', STUB_FN, STUB_AGENT], {
      cwd: workspace,
      env: { ...process.env, AGENT_TEAM_NO_CONFIRM: '1' },
      stdio: 'pipe',
    });

    rmSync(GOLDEN_ROOT, { recursive: true, force: true });
    mkdirSync(GOLDEN_ROOT, { recursive: true });
    // The script writes both the agent tree and the slash command — copy the
    // function dir and .claude/commands/. We do NOT copy scripts/ or .config/
    // back; those are inputs, not outputs.
    cpSync(join(workspace, STUB_FN), join(GOLDEN_ROOT, STUB_FN), { recursive: true });
    cpSync(
      join(workspace, '.claude'),
      join(GOLDEN_ROOT, '.claude'),
      { recursive: true },
    );

    console.log(`Wrote stub golden tree to ${GOLDEN_ROOT}`);
    console.log('Review the diff before committing — any change is a stub-mode contract shift.');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main();
