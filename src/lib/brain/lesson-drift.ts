import { isWorkspaceFailure } from '../workspace-diagnostics.ts';
import { hashWorkspaceBytes, readWorkspaceFile, readWorkspaceText } from '../workspace-io.ts';
import { parseAgentDefinition, parseMarkdownDefinition } from '../workspace-record.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';
import { lessonTargetScope } from './dream-candidate-contracts.ts';
import {
  listLessonGovernors,
  loadGovernorTargetScopes,
  type LessonGovernor,
} from './dream-candidates.ts';
import { resolveLessonPaths } from './lesson-materialize.ts';

export const LESSON_DRIFT_FINDINGS = [
  'lesson-missing',
  'lesson-drifted',
  'lesson-unregistered',
  'lesson-scope-drifted',
  'retired-lesson-lingering',
  'retired-membership-lingering',
  'lesson-unreadable',
] as const;

export type LessonDriftFindingCode = (typeof LESSON_DRIFT_FINDINGS)[number];

export type LessonDriftFinding = Readonly<{
  code: LessonDriftFindingCode;
  lesson_qualified_id: string;
  candidate_id: string;
  path: string;
  detail: string;
  remedy: string;
}>;

export type LessonDriftReport = Readonly<{
  ok: boolean;
  applicable: boolean;
  subjects: number;
  findings: readonly LessonDriftFinding[];
}>;

const RE_RUN_PROMOTE = 'Re-run roster dream candidates promote for the governing candidate; the run converges.';
const RE_RUN_RETIRE = 'Re-run roster dream candidates retire for the governing candidate; the run converges.';

function auditGovernor(
  root: string,
  governor: LessonGovernor,
  targetScopeKey: string | undefined,
): LessonDriftFinding[] {
  const findings: LessonDriftFinding[] = [];
  let paths;
  try {
    paths = resolveLessonPaths(root, governor.lessonAgentKey, governor.lessonId);
  } catch (error) {
    if (!isWorkspaceFailure(error)) throw error;
    findings.push({
      code: 'lesson-unreadable',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: `${governor.lessonAgentKey}/playbook/${governor.lessonId}.md`,
      detail: `The workspace does not register '${governor.lessonAgentKey}', so this lesson has no path.`,
      remedy: 'Scaffold the function and agent the governing candidate targets, then re-run the verb.',
    });
    return findings;
  }
  // TRI-STATE on purpose. "absent" and "unregistered" are the DESIRED retired
  // states, so collapsing an unreadable, non-regular, or refused read into them
  // would report a retired subject with an unreadable file as HEALTHY -- exactly
  // the case an operator most needs to see.
  let file: { state: 'present'; bytes: Buffer } | { state: 'absent' } | { state: 'unreadable'; reason: string };
  try {
    file = { state: 'present', bytes: readWorkspaceFile(root, paths.lessonPath) };
  } catch (error) {
    const code = isWorkspaceFailure(error) ? error.code : 'UNKNOWN';
    // Only a missing parent or a missing leaf is genuinely "absent"; a symlink,
    // a directory, a size refusal, or a permission error is unreadable.
    file = code === 'PARENT_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unreadable', reason: code };
  }
  let membership:
    | { state: 'registered' }
    | { state: 'unregistered' }
    | { state: 'unreadable'; reason: string };
  try {
    const agent = parseAgentDefinition(readWorkspaceText(root, paths.agentPath), paths.agentPath);
    membership = agent.lessons.includes(governor.lessonId)
      ? { state: 'registered' }
      : { state: 'unregistered' };
  } catch (error) {
    const code = isWorkspaceFailure(error) ? error.code : 'UNKNOWN';
    membership = { state: 'unreadable', reason: code };
  }
  if (file.state === 'unreadable') {
    findings.push({
      code: 'lesson-unreadable',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: paths.lessonPath,
      detail: `The lesson path could not be read (${file.reason}); its state cannot be accounted for.`,
      remedy: 'Inspect the path directly — a symlink, a directory, or a permission refusal is never a Roster-managed lesson.',
    });
  }
  if (membership.state === 'unreadable') {
    findings.push({
      code: 'lesson-unreadable',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: paths.agentPath,
      detail: `The owning agent record could not be read (${membership.reason}); registration cannot be accounted for.`,
      remedy: 'Run roster validate and repair the agent record, then re-run the governing verb.',
    });
  }

  if (governor.decision === 'promote') {
    if (file.state === 'absent') {
      findings.push({
        code: 'lesson-missing',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.lessonPath,
        detail: 'The governing promotion has no file on disk.',
        remedy: RE_RUN_PROMOTE,
      });
    } else if (file.state === 'present'
      && hashWorkspaceBytes(file.bytes) !== governor.lessonContentHash) {
      findings.push({
        code: 'lesson-drifted',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.lessonPath,
        detail: `The file holds ${hashWorkspaceBytes((file as { bytes: Buffer }).bytes)} but the governing promotion recorded ${governor.lessonContentHash}.`,
        remedy: 'A human reconciles the drifted file, or retires and re-promotes the lesson.',
      });
    }
    if (membership.state === 'unregistered') {
      findings.push({
        code: 'lesson-unregistered',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.agentPath,
        detail: 'The governing promotion is not registered on its agent.',
        remedy: RE_RUN_PROMOTE,
      });
    } else if (file.state === 'present' && targetScopeKey !== undefined) {
      // The report-side twin of the promote repair arm: a registration under a
      // scope the governing candidate does not target is exactly the residue a
      // crashed predecessor leaves behind.
      try {
        const parsed = parseMarkdownDefinition(file.bytes.toString('utf8'), paths.lessonPath);
        const expected = lessonTargetScope(targetScopeKey);
        const actualPlan = parsed.scope.plan ?? null;
        if (actualPlan !== (expected.plan ?? null)) {
          findings.push({
            code: 'lesson-scope-drifted',
            lesson_qualified_id: governor.lessonQualifiedId,
            candidate_id: governor.candidateId,
            path: paths.lessonPath,
            detail: `The registered lesson scope names plan '${actualPlan ?? '(none)'}' while the governing candidate targets '${expected.plan ?? '(none)'}'.`,
            remedy: RE_RUN_PROMOTE,
          });
        }
      } catch {
        findings.push({
          code: 'lesson-unreadable',
          lesson_qualified_id: governor.lessonQualifiedId,
          candidate_id: governor.candidateId,
          path: paths.lessonPath,
          detail: 'The governing promotion file does not parse as a lesson record.',
          remedy: 'Run roster validate and reconcile the file, then re-run promote.',
        });
      }
    }
    return findings;
  }

  if (file.state === 'present') {
    findings.push({
      code: 'retired-lesson-lingering',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: paths.lessonPath,
      detail: 'A retired lesson still has a file on disk.',
      remedy: RE_RUN_RETIRE,
    });
  }
  if (membership.state === 'registered') {
    findings.push({
      code: 'retired-membership-lingering',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: paths.agentPath,
      detail: 'A retired lesson is still registered on its agent.',
      remedy: RE_RUN_RETIRE,
    });
  }
  return findings;
}

// Per SUBJECT, not per decision: one governor row per materialized lesson file
// makes the audit's account of each file unique, so an A-retired/B-promoted pair
// with byte-identical content reads green instead of double-reporting.
//
// The reads are deliberately UNFENCED and take neither local lock: this
// diagnoses and never mutates, so a torn read can only mis-report transiently.
// It is also the named second half of the UNVERIFIED remediation -- after a lost
// fence it reports exactly which convergence the re-run will perform.
export async function auditLessonDrift(
  pool: VerifiedBrainPool,
  root: string,
): Promise<LessonDriftReport> {
  const governors = await listLessonGovernors(pool);
  if (governors.length === 0) {
    return Object.freeze({ ok: true, applicable: true, subjects: 0, findings: Object.freeze([]) });
  }
  const scopes = await loadGovernorTargetScopes(
    pool,
    governors.filter((governor) => governor.decision === 'promote').map((governor) => governor.candidateId),
  );
  const findings: LessonDriftFinding[] = [];
  for (const governor of governors) {
    findings.push(...auditGovernor(root, governor, scopes.get(governor.candidateId)));
  }
  return Object.freeze({
    ok: findings.length === 0,
    applicable: true,
    subjects: governors.length,
    findings: Object.freeze(findings),
  });
}

export function notApplicableLessonDrift(): LessonDriftReport {
  return Object.freeze({ ok: true, applicable: false, subjects: 0, findings: Object.freeze([]) });
}
