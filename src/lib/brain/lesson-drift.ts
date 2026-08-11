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
  let fileBytes: Buffer | null = null;
  try {
    fileBytes = readWorkspaceFile(root, paths.lessonPath);
  } catch {
    fileBytes = null;
  }
  let registered = false;
  try {
    const agent = parseAgentDefinition(readWorkspaceText(root, paths.agentPath), paths.agentPath);
    registered = agent.lessons.includes(governor.lessonId);
  } catch {
    registered = false;
  }

  if (governor.decision === 'promote') {
    if (fileBytes === null) {
      findings.push({
        code: 'lesson-missing',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.lessonPath,
        detail: 'The governing promotion has no file on disk.',
        remedy: RE_RUN_PROMOTE,
      });
    } else if (hashWorkspaceBytes(fileBytes) !== governor.lessonContentHash) {
      findings.push({
        code: 'lesson-drifted',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.lessonPath,
        detail: `The file holds ${hashWorkspaceBytes(fileBytes)} but the governing promotion recorded ${governor.lessonContentHash}.`,
        remedy: 'A human reconciles the drifted file, or retires and re-promotes the lesson.',
      });
    }
    if (!registered) {
      findings.push({
        code: 'lesson-unregistered',
        lesson_qualified_id: governor.lessonQualifiedId,
        candidate_id: governor.candidateId,
        path: paths.agentPath,
        detail: 'The governing promotion is not registered on its agent.',
        remedy: RE_RUN_PROMOTE,
      });
    } else if (fileBytes !== null && targetScopeKey !== undefined) {
      // The report-side twin of the promote repair arm: a registration under a
      // scope the governing candidate does not target is exactly the residue a
      // crashed predecessor leaves behind.
      try {
        const parsed = parseMarkdownDefinition(fileBytes.toString('utf8'), paths.lessonPath);
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

  if (fileBytes !== null) {
    findings.push({
      code: 'retired-lesson-lingering',
      lesson_qualified_id: governor.lessonQualifiedId,
      candidate_id: governor.candidateId,
      path: paths.lessonPath,
      detail: 'A retired lesson still has a file on disk.',
      remedy: RE_RUN_RETIRE,
    });
  }
  if (registered) {
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
