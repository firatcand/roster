import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Fixture = {
  root: string;
  cleanup: () => void;
};

/**
 * Builds the agent-team-mini fixture in a tmpdir.
 * - .env is created at mode 0o644 so the permission blocker fires.
 * - Wrappers are written executable.
 * - Two wrappers + crontab lines so longest-prefix matching can be regression-tested.
 */
export function buildAgentTeamMini(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-fixture-agent-team-mini-'));
  const cleanup = (): void => {
    rmSync(root, { recursive: true, force: true });
  };

  // .env (mode 0o644 → triggers refuse-with-hint)
  const envPath = join(root, '.env');
  writeFileSync(envPath, 'SLACK_TOKEN=xoxb-fake-fake\nLINEAR_API_KEY=lin_api_fake\n', 'utf8');
  chmodSync(envPath, 0o644);

  // dreamer (top-level agent, no function)
  const dreamer = join(root, 'dreamer');
  mkdirSync(join(dreamer, 'pending'), { recursive: true });
  mkdirSync(join(dreamer, 'logs', '2026-04'), { recursive: true });
  writeFileSync(join(dreamer, 'agent.md'), '# Dreamer agent\nLegacy agent definition.\n', 'utf8');
  writeFileSync(join(dreamer, 'state.md'), '---\nlast_run: never\n---\n# Dreamer State\n', 'utf8');
  writeFileSync(
    join(dreamer, 'pending', 'L-2026-05-05-001.md'),
    '---\nid: L-2026-05-05-001\nsource: human\nagent: dreamer\nproject: "—"\n---\n# Pending\n',
    'utf8',
  );
  writeFileSync(join(dreamer, 'logs', '2026-04', '2026-04-15-2200.md'), '# Run log\n', 'utf8');

  // chief-of-staff (another top-level agent — no pending, no logs)
  const cos = join(root, 'chief-of-staff');
  mkdirSync(cos, { recursive: true });
  writeFileSync(join(cos, 'agent.md'), '# Chief of Staff agent\n', 'utf8');

  // gtm/sdr (function/agent pair)
  const sdr = join(root, 'gtm', 'sdr');
  mkdirSync(sdr, { recursive: true });
  writeFileSync(join(sdr, 'agent.md'), '# SDR agent\n', 'utf8');

  // projects/_demo
  const demoProject = join(root, 'projects', '_demo');
  mkdirSync(demoProject, { recursive: true });
  writeFileSync(join(demoProject, 'state.md'), '---\nupdated: 2026-05-01\n---\n', 'utf8');

  // logs/cron (left empty for now)
  mkdirSync(join(root, 'logs', 'cron'), { recursive: true });

  // scripts/cron/crontab + wrappers
  const cronDir = join(root, 'scripts', 'cron');
  const wrappersDir = join(cronDir, 'wrappers');
  mkdirSync(wrappersDir, { recursive: true });

  const dreamerWrapper = join(wrappersDir, 'dreamer-nightly.sh');
  writeFileSync(
    dreamerWrapper,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd "$(dirname "$0")/../../.."',
      'claude -p "$(cat scripts/cron/wrappers/dreamer-nightly-prompt.txt)"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(dreamerWrapper, 0o755);
  writeFileSync(
    join(wrappersDir, 'dreamer-nightly-prompt.txt'),
    'Run dreamer nightly reinforcement.\n',
    'utf8',
  );

  // Multi-dash wrapper — tests longest-prefix match (gtm.sdr → function=gtm, agent=sdr, plan=daily-outreach)
  const sdrWrapper = join(wrappersDir, 'gtm-sdr-daily-outreach.sh');
  writeFileSync(
    sdrWrapper,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd "$(dirname "$0")/../../.."',
      'codex exec "$(cat scripts/cron/wrappers/gtm-sdr-daily-outreach-prompt.txt)"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(sdrWrapper, 0o755);
  writeFileSync(
    join(wrappersDir, 'gtm-sdr-daily-outreach-prompt.txt'),
    'Run SDR outreach for project _demo.\n',
    'utf8',
  );

  writeFileSync(
    join(cronDir, 'crontab'),
    [
      '# agent-team crontab',
      '# Format: m h dom mon dow command',
      '',
      `0 3 * * * ${dreamerWrapper}`,
      `30 9 * * 1-5 ${sdrWrapper}`,
      '',
      '# Commented out (must NOT be picked up)',
      '# 0 0 * * * /never/runs.sh',
      '',
    ].join('\n'),
    'utf8',
  );

  return { root, cleanup };
}
