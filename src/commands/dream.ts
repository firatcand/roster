import chalk from 'chalk';
import { openVerifiedRuntimePool } from '../lib/brain/connect.ts';
import { isWorkspaceFailure } from '../lib/workspace-diagnostics.ts';
import { readWorkspaceRegistry } from '../lib/workspace-registry.ts';
import { normalizeScopeAlias } from '../lib/workspace-layout.ts';
import { readCappedFileSync, readCappedStream } from '../lib/bounded-read.ts';
import {
  brainNotConfiguredReadiness,
  canonicalizeDreamScope,
  dreamWatermarkCanonical,
  type DreamReadinessResult,
} from '../lib/brain/dream-contracts.ts';
import { computeDreamReadiness } from '../lib/brain/dream-readiness.ts';
import {
  MAX_DREAM_CANDIDATE_BYTES,
  lessonTargetScope,
  normalizeDreamCandidate,
  normalizeLessonDecision,
  type DreamCandidateDraft,
  type LessonDecisionVerb,
} from '../lib/brain/dream-candidate-contracts.ts';
import {
  decideLessonCandidate,
  decisionActionsFor,
  dreamLifecycleError,
  listDreamCandidates,
  loadDreamCandidate,
  loadHumanDecisionInstant,
  recordDreamCandidate,
  type DreamCandidateListRow,
} from '../lib/brain/dream-candidates.ts';
import {
  assertLessonContentAdmissible,
  isLessonLifecycleConflict,
  materializeLesson,
  preflightLessonTarget,
  renderLessonContent,
  retireLesson,
  withSubjectFence,
} from '../lib/brain/lesson-materialize.ts';
import { EXIT_ERROR, EXIT_OK } from '../lib/errors.ts';

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

export type DreamCandidatesOptions =
  | {
      cwd: string;
      json: boolean;
      verb: 'list';
      state?: string;
      target?: string;
      candidateId?: string;
      readinessKey?: string;
      limit?: number;
    }
  | { cwd: string; json: boolean; verb: 'create'; file?: string; stdin: boolean }
  | {
      cwd: string;
      json: boolean;
      verb: 'promote' | 'reject' | 'retire';
      candidateId: string;
      decisionId: string;
      actionDigest: string;
    };

export function renderCandidateLines(rows: readonly DreamCandidateListRow[]): string[] {
  if (rows.length === 0) {
    return ['', chalk.bold('roster dream candidates'), `  ${chalk.dim('·')} no candidates recorded`, ''];
  }
  const lines = ['', chalk.bold('roster dream candidates')];
  for (const row of rows) {
    const mark = row.state === 'promoted'
      ? chalk.green('●')
      : row.state === 'open'
        ? chalk.yellow('○')
        : chalk.dim('·');
    lines.push(`  ${mark} ${row.state.padEnd(10)} ${chalk.dim(row.candidate_id)}`);
    lines.push(`      ${row.lesson_qualified_id}  ${chalk.dim(`(${row.lesson_scope_key} from ${row.scope_key})`)}`);
    lines.push(`      ${row.lesson_purpose}`);
    lines.push(`      ${chalk.dim(`drafted by ${row.drafted_by_agent_id} · ${row.privacy_class} · ${row.recorded_at}`)}`);
    // The human decision's action, verbatim. A host cannot derive this: the
    // target is a grouped spelling of the candidate digest, because a bare
    // sha256 is credential-shaped and the evidence contract refuses it.
    for (const verb of ['promote', 'reject', 'retire'] as const) {
      const action = row.decision_action[verb];
      lines.push(`      ${chalk.dim(`decision action (${verb}):`)} target=${action.target} `
        + `effect=${action.effect} scope=${action.scope} params={} `
        + `action_digest=${action.action_digest}`);
    }
    for (const warning of row.warnings) {
      lines.push(`      ${chalk.yellow('⚠')} ${warning.code} — ${warning.detail}`);
    }
  }
  lines.push('');
  return lines;
}

function readDraftDocument(opts: { file?: string; stdin: boolean }): Promise<Buffer> {
  if (opts.stdin) return readCappedStream(process.stdin, MAX_DREAM_CANDIDATE_BYTES);
  const read = readCappedFileSync(opts.file!, MAX_DREAM_CANDIDATE_BYTES);
  if (read.state === 'unreadable') {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INPUT_INVALID',
      `The candidate draft at '${opts.file!}' could not be read.`,
      { file: opts.file! },
    );
  }
  if (read.state === 'over-cap') {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INPUT_INVALID',
      `The candidate draft exceeds ${MAX_DREAM_CANDIDATE_BYTES} bytes.`,
      { file: opts.file! },
    );
  }
  return Promise.resolve(read.bytes);
}

type DraftDocument = { readiness_key?: unknown } & Record<string, unknown>;

function parseDraft(bytes: Buffer): { readinessKey: string; draft: DreamCandidateDraft } {
  if (bytes.byteLength > MAX_DREAM_CANDIDATE_BYTES) {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INPUT_INVALID',
      `The candidate draft exceeds ${MAX_DREAM_CANDIDATE_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw dreamLifecycleError('BRAIN_DREAM_INPUT_INVALID', 'The candidate draft is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw dreamLifecycleError('BRAIN_DREAM_INPUT_INVALID', 'The candidate draft must be a JSON object.');
  }
  const document = parsed as DraftDocument;
  const readinessKey = document.readiness_key;
  if (typeof readinessKey !== 'string') {
    throw dreamLifecycleError(
      'BRAIN_DREAM_INPUT_INVALID',
      'The candidate draft must carry the readiness_key from roster dream status.',
    );
  }
  const { readiness_key: _ignored, ...rest } = document;
  return { readinessKey, draft: rest as unknown as DreamCandidateDraft };
}

export async function executeDreamCandidates(opts: DreamCandidatesOptions): Promise<number> {
  const workspaceId = readWorkspaceRegistry(opts.cwd).registry.workspace_id;
  let pool;
  try {
    pool = openVerifiedRuntimePool(opts.cwd);
  } catch (error) {
    if (!isWorkspaceFailure(error) || error.code !== 'BRAIN_NOT_CONFIGURED') throw error;
    // The list verb mirrors `dream status`'s local-only tolerance so a
    // Brain-less workspace does not error on an ordinary host interaction. Every
    // WRITING verb needs the durable ledger and fails closed.
    if (opts.verb !== 'list') throw error;
    if (opts.json) console.log(JSON.stringify({ ok: true, candidates: [], brain: 'not-configured' }, null, 2));
    else {
      console.log('');
      console.log(chalk.bold('roster dream candidates'));
      console.log(`  ${chalk.dim('·')} this workspace has no tracked Brain configuration, so no candidates exist`);
      console.log('');
    }
    return EXIT_OK;
  }
  try {
    if (opts.verb === 'list') return await runList(pool, opts);
    if (opts.verb === 'create') return await runCreate(pool, workspaceId, opts);
    return await runDecision(pool, workspaceId, opts);
  } finally {
    await pool.end();
  }
}

type RuntimePool = Awaited<ReturnType<typeof openVerifiedRuntimePool>>;

async function runList(
  pool: RuntimePool,
  opts: Extract<DreamCandidatesOptions, { verb: 'list' }>,
): Promise<number> {
  const rows = await listDreamCandidates(pool, {
    ...(opts.state === undefined ? {} : { state: opts.state }),
    ...(opts.target === undefined ? {} : { lessonAgentKey: opts.target }),
    ...(opts.candidateId === undefined ? {} : { candidateId: opts.candidateId }),
    ...(opts.readinessKey === undefined ? {} : { readinessKey: opts.readinessKey }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  });
  if (opts.json) console.log(JSON.stringify({ ok: true, candidates: rows }, null, 2));
  else for (const line of renderCandidateLines(rows)) console.log(line);
  return EXIT_OK;
}

async function runCreate(
  pool: RuntimePool,
  workspaceId: string,
  opts: Extract<DreamCandidatesOptions, { verb: 'create' }>,
): Promise<number> {
  const { readinessKey, draft } = parseDraft(await readDraftDocument(opts));
  const normalized = normalizeDreamCandidate(workspaceId, readinessKey, draft);
  assertLessonContentAdmissible(normalized.candidateId, draft.lessonPurpose, draft.lessonBody);
  const result = await recordDreamCandidate(pool, normalized.canonical);
  // The same-file warning is surfaced at CREATE as well as in `list`: a host
  // that drafts a sibling for a lesson file another candidate already targets
  // should see it now, not after a promotion is refused. Deterministic and
  // non-blocking -- a warning never fails a command.
  const warnings = (await listDreamCandidates(pool, { limit: 200 }))
    .find((row) => row.candidate_id === result.candidateId)?.warnings ?? [];
  // The draft is never echoed: it carries authored prose and up to 64 citation
  // pointers, and a candidate is reviewed through `list`, not through the write
  // verb's own output.
  if (opts.json) {
    console.log(JSON.stringify({
      ok: true,
      status: result.status,
      candidate_id: result.candidateId,
      lesson_qualified_id: normalized.lessonQualifiedId,
      decision_action: decisionActionsFor(result.candidateId, draft.lessonScopeKey),
      warnings,
    }, null, 2));
  } else {
    console.log('');
    console.log(chalk.bold('roster dream candidates create'));
    console.log(`  ${chalk.green('✓')} ${result.status}  ${chalk.dim(result.candidateId)}`);
    for (const warning of warnings) {
      console.log(`  ${chalk.yellow('⚠')} ${warning.code} — ${warning.detail}`);
    }
    console.log(`  ${chalk.dim('·')} target: ${normalized.lessonQualifiedId}`);
    for (const [verb, action] of Object.entries(
      decisionActionsFor(result.candidateId, draft.lessonScopeKey),
    )) {
      console.log(`  ${chalk.dim('·')} decision action (${verb}): target=${action.target} `
        + `effect=${action.effect} scope=${action.scope} params={} `
        + `action_digest=${action.action_digest}`);
    }
    console.log(`  ${chalk.dim('·')} present it to a human, record their decision, then promote or reject it`);
    console.log('');
  }
  return EXIT_OK;
}

export const SUPERSEDED_MESSAGE =
  'this decision was superseded by later lifecycle activity on this lesson; no filesystem change';

// A phase whose fence could not be proven alive is NEVER reported as success.
// The pre-phase variant additionally states that nothing was touched, because
// that is the difference an operator acts on.
export function renderUnverifiedLines(
  stage: 'pre-phase' | 'post-phase' | 'commit',
  reason: string,
): string[] {
  return [
    '',
    `  ✗ UNVERIFIED${stage === 'pre-phase' ? ' (no mutation performed)' : ''}`,
    `    ${reason} during the ${stage} check.`,
    '    The decision is durable — re-run the verb (it converges) and run roster brain doctor.',
    '',
  ];
}

async function runDecision(
  pool: RuntimePool,
  workspaceId: string,
  opts: Extract<DreamCandidatesOptions, { verb: 'promote' | 'reject' | 'retire' }>,
): Promise<number> {
  const verb: LessonDecisionVerb = opts.verb;
  const candidate = await loadDreamCandidate(pool, opts.candidateId);
  const decidedAt = await loadHumanDecisionInstant(pool, opts.decisionId);
  const targetScope = lessonTargetScope(candidate.lessonScopeKey);
  const rendered = renderLessonContent(
    candidate.lessonId,
    candidate.lessonPurpose,
    candidate.lessonBody,
    targetScope,
  );
  const lessonQualifiedId = `${candidate.lessonAgentKey}/playbook/${candidate.lessonId}`;

  const warnings = verb === 'reject'
    ? []
    : preflightLessonTarget(opts.cwd, candidate.lessonAgentKey, candidate.lessonId, targetScope);
  if (verb === 'promote') {
    assertLessonContentAdmissible(candidate.candidateId, candidate.lessonPurpose, candidate.lessonBody);
  }

  const watermarkCanonical = verb === 'promote'
    ? dreamWatermarkCanonical({
      scopeKey: candidate.scopeKey,
      cursorOrdinal: candidate.frontierOrdinal,
      policyVersion: candidate.policyVersion,
      reason: 'promotion',
      consumedCompletedRuns: candidate.consumedCompletedRuns,
      consumedFeedbackRecords: candidate.consumedFeedbackRecords,
      actorAssurance: 'human-confirmed',
    })
    : null;
  const decision = normalizeLessonDecision(workspaceId, {
    decision: verb,
    candidateId: candidate.candidateId,
    humanDecisionId: opts.decisionId,
    actionDigest: opts.actionDigest,
    frontierOrdinal: candidate.frontierOrdinal,
    decidedAt,
    lessonQualifiedId: verb === 'reject' ? null : lessonQualifiedId,
    lessonContentHash: verb === 'reject' ? null : rendered.contentHash,
    watermarkCanonical,
  });
  const committed = await decideLessonCandidate(pool, decision.canonical);

  if (verb === 'reject') {
    emitDecision(opts.json, {
      verb,
      status: committed.status,
      candidateId: candidate.candidateId,
      warnings,
      detail: 'the candidate is closed; no lesson file exists for it',
    });
    return EXIT_OK;
  }

  // Fence 1, a courtesy short-circuit only: the broker's verdict can stale the
  // instant it commits, so it skips the fence transaction for the common stale
  // replay rather than authorizing anything.
  if (!committed.subjectCurrent) {
    emitDecision(opts.json, {
      verb,
      status: committed.status,
      candidateId: candidate.candidateId,
      warnings,
      detail: SUPERSEDED_MESSAGE,
      superseded: true,
    });
    return EXIT_OK;
  }

  const outcome = await withSubjectFence({
    pool,
    root: opts.cwd,
    candidateId: candidate.candidateId,
    expectedDecision: verb,
    expectedSubjectSequence: committed.subjectSequence,
    phase: async (context) => (verb === 'promote'
      ? await materializeLesson({ root: opts.cwd, candidate, context })
      : await retireLesson({
        root: opts.cwd,
        candidate,
        lessonContentHash: rendered.contentHash,
      })),
  }).catch((error: unknown) => {
    if (isLessonLifecycleConflict(error)) return { outcome: 'conflict' as const, error };
    throw error;
  });

  if ('error' in outcome) {
    console.error('');
    console.error(chalk.red(`  ✗ ${outcome.error.code}`));
    console.error(`    ${outcome.error.message}`);
    console.error(`    ${outcome.error.details.remedy ?? 'A human reconciles the conflict, then re-run the verb.'}`);
    console.error('');
    return EXIT_ERROR;
  }
  if (outcome.outcome === 'superseded') {
    emitDecision(opts.json, {
      verb,
      status: committed.status,
      candidateId: candidate.candidateId,
      warnings,
      detail: SUPERSEDED_MESSAGE,
      superseded: true,
    });
    return EXIT_OK;
  }
  if (outcome.outcome === 'unverified') {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'UNVERIFIED',
        stage: outcome.stage,
        candidate_id: candidate.candidateId,
        detail: outcome.reason,
      }, null, 2));
    } else {
      for (const line of renderUnverifiedLines(outcome.stage, outcome.reason)) console.error(line);
    }
    return EXIT_ERROR;
  }

  emitDecision(opts.json, {
    verb,
    status: committed.status,
    candidateId: candidate.candidateId,
    warnings,
    detail: verb === 'promote'
      ? `${(outcome.value as { status: string; path: string }).status} ${(outcome.value as { path: string }).path}`
      : `${(outcome.value as { status: string }).status} ${(outcome.value as { path: string }).path}`,
    path: (outcome.value as { path: string }).path,
    contentHash: rendered.contentHash,
  });
  return EXIT_OK;
}

function emitDecision(
  json: boolean,
  report: {
    verb: LessonDecisionVerb;
    status: 'created' | 'existing';
    candidateId: string;
    warnings: readonly { code: string; detail: string }[];
    detail: string;
    superseded?: boolean;
    path?: string;
    contentHash?: string;
  },
): void {
  if (json) {
    console.log(JSON.stringify({
      ok: true,
      verb: report.verb,
      status: report.status,
      candidate_id: report.candidateId,
      superseded: report.superseded === true,
      detail: report.detail,
      ...(report.path === undefined ? {} : { path: report.path }),
      ...(report.contentHash === undefined ? {} : { content_hash: report.contentHash }),
      warnings: report.warnings,
    }, null, 2));
    return;
  }
  console.log('');
  console.log(chalk.bold(`roster dream candidates ${report.verb}`));
  for (const warning of report.warnings) {
    console.log(`  ${chalk.yellow('⚠')} ${warning.code} — ${warning.detail}`);
  }
  const mark = report.superseded === true ? chalk.dim('·') : chalk.green('✓');
  console.log(`  ${mark} ${report.status}  ${chalk.dim(report.candidateId)}`);
  console.log(`  ${chalk.dim('·')} ${report.detail}`);
  if (report.contentHash !== undefined) {
    console.log(`  ${chalk.dim('·')} content: ${report.contentHash}`);
  }
  console.log('');
}
