import chalk from 'chalk';
import { openVerifiedRuntimePool } from '../lib/brain/connect.ts';
import { isWorkspaceFailure } from '../lib/workspace-diagnostics.ts';
import { readWorkspaceRegistry } from '../lib/workspace-registry.ts';
import { normalizeScopeAlias } from '../lib/workspace-layout.ts';
import {
  brainNotConfiguredReadiness,
  canonicalizeDreamScope,
  type DreamReadinessResult,
} from '../lib/brain/dream-contracts.ts';
import { computeDreamReadiness } from '../lib/brain/dream-readiness.ts';
import { EXIT_OK } from '../lib/errors.ts';

export type DreamStatusOptions = {
  cwd: string;
  json: boolean;
  scope?: string;
  functionId?: string;
  agent?: string;
};

// Exported so the privacy assertion can cover the HUMAN mode with the same
// vectors as the JSON mode: only counts, window bounds, and the closed reason
// vocabulary are printed -- never an evidence id, summary, or canonical byte.
export function renderDreamStatusLines(result: DreamReadinessResult): string[] {
  const mark = result.status === 'due' ? chalk.green('●') : chalk.dim('○');
  return [
    '',
    `${chalk.bold('roster dream status')} ${chalk.dim(result.scope.key)}`,
    `  ${mark} ${result.status}  ${chalk.dim(result.readiness_key)}`,
    `  ${chalk.dim('·')} policy: ${result.policy.version} (${result.policy.source}) `
      + `runs>=${result.policy.min_completed_runs} feedback>=${result.policy.min_feedback_records} `
      + `mix>=${result.policy.min_signal_mix} window=${result.policy.evidence_window} `
      + `cooldown=${result.policy.cooldown}`,
    `  ${chalk.dim('·')} watermark: ${result.watermark.state} ordinal=${result.watermark.ordinal} `
      + `sequence=${result.watermark.sequence}`,
    `  ${chalk.dim('·')} frontier: ordinal=${result.frontier.ordinal} `
      + `observations=${result.frontier.eligible_observations}`,
    `  ${chalk.dim('·')} evidence: ${result.evidence.completed_runs} runs, `
      + `${result.evidence.feedback_records} feedback, ${result.evidence.signal_mix} mixed/negative `
      + `(${result.evidence.window_start} .. ${result.evidence.window_end}, `
      + `bound=${result.evidence.window_start_bound})`,
    `  ${chalk.dim('·')} cooldown: ${result.cooldown.active ? `active until ${result.cooldown.until}` : 'inactive'}`,
    ...result.reasons.map((reason) => `  ${chalk.dim('·')} ${reason.code} — ${reason.detail}`),
    '',
  ];
}

// A pure read: it creates no candidate, invokes no model, dispatches nothing,
// and schedules nothing. A local-only workspace must not error on every host
// interaction, so BRAIN_NOT_CONFIGURED is answered with a `not_due` verdict at
// exit 0 without contacting a store; every other configuration or authority
// failure propagates unchanged and fails closed.
export async function executeDreamStatus(opts: DreamStatusOptions): Promise<number> {
  const scope = canonicalizeDreamScope(normalizeScopeAlias({
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    ...(opts.functionId === undefined ? {} : { functionId: opts.functionId }),
    ...(opts.agent === undefined ? {} : { agent: opts.agent }),
  }));
  const workspaceId = readWorkspaceRegistry(opts.cwd).registry.workspace_id;

  let result: DreamReadinessResult;
  let pool;
  try {
    pool = openVerifiedRuntimePool(opts.cwd);
  } catch (error) {
    if (!isWorkspaceFailure(error) || error.code !== 'BRAIN_NOT_CONFIGURED') throw error;
    result = brainNotConfiguredReadiness(workspaceId, scope, new Date().toISOString());
    emitDreamStatus(result, opts.json);
    return EXIT_OK;
  }
  try {
    result = await computeDreamReadiness(pool, scope);
  } finally {
    await pool.end();
  }
  emitDreamStatus(result, opts.json);
  return EXIT_OK;
}

function emitDreamStatus(result: DreamReadinessResult, json: boolean): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of renderDreamStatusLines(result)) console.log(line);
}
