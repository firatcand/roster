import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  scaffoldWorkspace,
  validateWorkspace,
} from '../../src/lib/workspace-registry.ts';
import {
  hashWorkspaceBytes,
  readWorkspaceFile,
  replaceWorkspaceFile,
} from '../../src/lib/workspace-io.ts';
import {
  parseMarkdownDefinition,
  renderMarkdownDefinition,
} from '../../src/lib/workspace-record.ts';

const STATE_SCHEMA_VERSION = 1 as const;
const MAX_STATE_BYTES = 128 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_ID_BYTES = 256;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export type SeededCompletedRun = {
  id: string;
  target: string;
  request_hash: string;
  host: string;
  roster_version: string;
  started_at: string;
  completed_at: string;
  outcome: 'completed';
  selected_result_id: string;
  tool_ids: readonly string[];
  source_ids: readonly string[];
  artifact_ids: readonly string[];
};

export type SeededFeedback = {
  id: string;
  run_id: string;
  signal: 'positive' | 'negative' | 'mixed';
  summary: string;
  summary_hash: string;
};

export type SeededCandidateMeaning = {
  disposition: 'prefer' | 'avoid';
  source_kind: 'attributable-practitioner' | 'profile-page' | 'anonymous-source';
  topic_kind: 'operational-problem' | 'crypto-promotion' | 'generic-ad';
  falsifier_action: 'reject' | 'retain';
  falsifier_observation:
    | 'reviewed-outcomes-contradict'
    | 'reviewed-outcomes-confirm'
    | 'no-counterevidence';
};

export type SeededRenderedCandidateMeaning = {
  recommendation: string;
  falsifiable_by: string;
};

export type SeededLessonCandidate = {
  id: string;
  lesson_id: string;
  watermark: string;
  target: string;
  meaning: SeededCandidateMeaning;
  recommendation: string;
  falsifiable_by: string;
  citations: {
    run_ids: readonly string[];
    feedback_ids: readonly string[];
  };
};

export type SeededLearningStatus = {
  status: 'due' | 'not_due';
  watermark: string | null;
  run_ids: readonly string[];
  feedback_ids: readonly string[];
};

export type SeededLearningSnapshot = {
  schema_version: typeof STATE_SCHEMA_VERSION;
  completed_runs: readonly SeededCompletedRun[];
  feedback: readonly SeededFeedback[];
  processed_watermarks: readonly string[];
  candidates: readonly SeededLessonCandidate[];
};

export type SeededRecordResult<T> = {
  status: 'created' | 'existing';
  record: T;
  content_hash: string;
};

export type SeededLessonDefinition = {
  id: string;
  purpose: string;
  scope: {
    function: string;
    agent: string;
    plan: string;
  };
  body: string;
};

export type SeededLessonMaterialization = {
  status: 'created' | 'existing';
  qualified_id: string;
  path: string;
  source_hash: string;
  content: string;
};

export type SeededLearningStoreErrorCode =
  | 'FIXTURE_CONFLICT'
  | 'FIXTURE_INVALID'
  | 'FIXTURE_LIMIT'
  | 'FIXTURE_NOT_DUE'
  | 'FIXTURE_NOT_FOUND';

export class SeededLearningStoreError extends Error {
  readonly code: SeededLearningStoreErrorCode;

  constructor(code: SeededLearningStoreErrorCode, message: string) {
    super(message);
    this.name = 'SeededLearningStoreError';
    this.code = code;
  }
}

type MutableState = {
  schema_version: typeof STATE_SCHEMA_VERSION;
  completed_runs: SeededCompletedRun[];
  feedback: SeededFeedback[];
  processed_watermarks: string[];
  candidates: SeededLessonCandidate[];
};

export type SeededLearningStore = {
  snapshot: () => SeededLearningSnapshot;
  status: () => SeededLearningStatus;
  recordCompletedRun: (record: SeededCompletedRun) => SeededRecordResult<SeededCompletedRun>;
  recordFeedback: (record: SeededFeedback) => SeededRecordResult<SeededFeedback>;
  createCandidate: (record: SeededLessonCandidate) => SeededRecordResult<SeededLessonCandidate>;
  candidate: (id: string) => SeededRecordResult<SeededLessonCandidate> | null;
};

function fail(code: SeededLearningStoreErrorCode, message: string): never {
  throw new SeededLearningStoreError(code, message);
}

function compareUnicode(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort(compareUnicode)
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value));
  if (encoded === undefined) fail('FIXTURE_INVALID', 'Fixture learning value is not JSON serializable.');
  return encoded;
}

function hashValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUnicode);
  const wanted = [...expected].sort(compareUnicode);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedString(value: unknown, maximum = MAX_TEXT_BYTES): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum) {
    return false;
  }
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    if ((point >= 0 && point <= 0x1f) || (point >= 0x7f && point <= 0x9f)) return false;
    index += point > 0xffff ? 2 : 1;
  }
  return true;
}

function boundedMarkdown(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) {
    return false;
  }
  for (let index = 0; index < value.length;) {
    const point = value.codePointAt(index)!;
    const prohibited = ((point >= 0 && point <= 0x1f)
      && point !== 0x09
      && point !== 0x0a
      && point !== 0x0d)
      || (point >= 0x7f && point <= 0x9f);
    if (prohibited) return false;
    index += point > 0xffff ? 2 : 1;
  }
  return true;
}

function safeId(value: unknown): value is string {
  return boundedString(value, MAX_ID_BYTES) && SAFE_ID.test(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every(safeId)
    && new Set(value).size === value.length;
}

function validCompletedRun(value: unknown): value is SeededCompletedRun {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, [
    'id',
    'target',
    'request_hash',
    'host',
    'roster_version',
    'started_at',
    'completed_at',
    'outcome',
    'selected_result_id',
    'tool_ids',
    'source_ids',
    'artifact_ids',
  ])
    && safeId(record['id'])
    && boundedString(record['target'], MAX_ID_BYTES)
    && safeHash(record['request_hash'])
    && safeId(record['host'])
    && boundedString(record['roster_version'], MAX_ID_BYTES)
    && boundedString(record['started_at'], MAX_ID_BYTES)
    && boundedString(record['completed_at'], MAX_ID_BYTES)
    && !Number.isNaN(Date.parse(record['started_at']))
    && !Number.isNaN(Date.parse(record['completed_at']))
    && Date.parse(record['started_at']) <= Date.parse(record['completed_at'])
    && record['outcome'] === 'completed'
    && safeId(record['selected_result_id'])
    && stringList(record['tool_ids'])
    && stringList(record['source_ids'])
    && stringList(record['artifact_ids']);
}

function validFeedback(value: unknown): value is SeededFeedback {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return exactKeys(record, ['id', 'run_id', 'signal', 'summary', 'summary_hash'])
    && safeId(record['id'])
    && safeId(record['run_id'])
    && ['positive', 'negative', 'mixed'].includes(record['signal'] as string)
    && boundedString(record['summary'])
    && safeHash(record['summary_hash'])
    && hashValue(record['summary']) === record['summary_hash'];
}

function validCandidateMeaning(value: unknown): value is SeededCandidateMeaning {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const meaning = value as Record<string, unknown>;
  return exactKeys(meaning, [
    'disposition',
    'source_kind',
    'topic_kind',
    'falsifier_action',
    'falsifier_observation',
  ])
    && ['prefer', 'avoid'].includes(meaning['disposition'] as string)
    && ['attributable-practitioner', 'profile-page', 'anonymous-source']
      .includes(meaning['source_kind'] as string)
    && ['operational-problem', 'crypto-promotion', 'generic-ad']
      .includes(meaning['topic_kind'] as string)
    && ['reject', 'retain'].includes(meaning['falsifier_action'] as string)
    && ['reviewed-outcomes-contradict', 'reviewed-outcomes-confirm', 'no-counterevidence']
      .includes(meaning['falsifier_observation'] as string);
}

export function renderSeededCandidateMeaning(
  meaning: SeededCandidateMeaning,
): Readonly<SeededRenderedCandidateMeaning> {
  if (!validCandidateMeaning(meaning)) {
    fail('FIXTURE_INVALID', 'Fixture candidate meaning does not match its closed semantic schema.');
  }
  const dispositions: Record<SeededCandidateMeaning['disposition'], string> = {
    prefer: 'Prefer',
    avoid: 'Avoid',
  };
  const sourceKinds: Record<SeededCandidateMeaning['source_kind'], string> = {
    'attributable-practitioner': 'attributable practitioner sources',
    'profile-page': 'profile pages',
    'anonymous-source': 'anonymous sources',
  };
  const topicKinds: Record<SeededCandidateMeaning['topic_kind'], string> = {
    'operational-problem': 'that describe concrete operational problems',
    'crypto-promotion': 'focused on cryptocurrency promotion',
    'generic-ad': 'that are generic advertisements',
  };
  const falsifierActions: Record<SeededCandidateMeaning['falsifier_action'], string> = {
    reject: 'Reject',
    retain: 'Retain',
  };
  const falsifierObservations: Record<SeededCandidateMeaning['falsifier_observation'], string> = {
    'reviewed-outcomes-contradict': 'reviewed outcomes contradict it',
    'reviewed-outcomes-confirm': 'reviewed outcomes confirm it',
    'no-counterevidence': 'no reviewed counterevidence appears',
  };
  return deepFreeze({
    recommendation: `${dispositions[meaning.disposition]} ${sourceKinds[meaning.source_kind]} ${topicKinds[meaning.topic_kind]}.`,
    falsifiable_by: `${falsifierActions[meaning.falsifier_action]} this recommendation if ${falsifierObservations[meaning.falsifier_observation]}.`,
  });
}

export function renderSeededCandidateLessonId(meaning: SeededCandidateMeaning): string {
  if (!validCandidateMeaning(meaning)) {
    fail('FIXTURE_INVALID', 'Fixture candidate meaning does not match its closed semantic schema.');
  }
  const sourceCodes: Record<SeededCandidateMeaning['source_kind'], string> = {
    'attributable-practitioner': 'practitioner',
    'profile-page': 'profile',
    'anonymous-source': 'anonymous',
  };
  const topicCodes: Record<SeededCandidateMeaning['topic_kind'], string> = {
    'operational-problem': 'operational',
    'crypto-promotion': 'crypto',
    'generic-ad': 'ad',
  };
  const observationCodes: Record<SeededCandidateMeaning['falsifier_observation'], string> = {
    'reviewed-outcomes-contradict': 'contradict',
    'reviewed-outcomes-confirm': 'confirm',
    'no-counterevidence': 'absent',
  };
  return [
    meaning.disposition,
    sourceCodes[meaning.source_kind],
    topicCodes[meaning.topic_kind],
    meaning.falsifier_action,
    observationCodes[meaning.falsifier_observation],
  ].join('-');
}

function validCandidate(value: unknown): value is SeededLessonCandidate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const citations = record['citations'];
  const meaning = record['meaning'];
  if (!validCandidateMeaning(meaning)) return false;
  const rendered = renderSeededCandidateMeaning(meaning);
  return exactKeys(record, [
    'id',
    'lesson_id',
    'watermark',
    'target',
    'meaning',
    'recommendation',
    'falsifiable_by',
    'citations',
  ])
    && safeId(record['id'])
    && record['lesson_id'] === renderSeededCandidateLessonId(meaning)
    && safeHash(record['watermark'])
    && boundedString(record['target'], MAX_ID_BYTES)
    && record['recommendation'] === rendered.recommendation
    && record['falsifiable_by'] === rendered.falsifiable_by
    && citations !== null
    && typeof citations === 'object'
    && !Array.isArray(citations)
    && exactKeys(citations as Record<string, unknown>, ['run_ids', 'feedback_ids'])
    && stringList((citations as Record<string, unknown>)['run_ids'])
    && stringList((citations as Record<string, unknown>)['feedback_ids']);
}

function emptyState(): MutableState {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    completed_runs: [],
    feedback: [],
    processed_watermarks: [],
    candidates: [],
  };
}

function learningStatus(state: MutableState): SeededLearningStatus {
  const eligibleFeedback = state.feedback.filter((entry) => (
    state.completed_runs.some((run) => run.id === entry.run_id)
  ));
  const runIds = [...new Set(eligibleFeedback.map((entry) => entry.run_id))].sort(compareUnicode);
  const feedbackIds = eligibleFeedback.map((entry) => entry.id).sort(compareUnicode);
  if (runIds.length === 0 || feedbackIds.length === 0) {
    return deepFreeze({ status: 'not_due', watermark: null, run_ids: runIds, feedback_ids: feedbackIds });
  }
  const watermark = hashValue({ run_ids: runIds, feedback_ids: feedbackIds });
  return deepFreeze({
    status: state.processed_watermarks.includes(watermark) ? 'not_due' : 'due',
    watermark,
    run_ids: runIds,
    feedback_ids: feedbackIds,
  });
}

function validateState(value: unknown): MutableState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('FIXTURE_INVALID', 'Fixture learning state must be a JSON object.');
  }
  const state = value as Record<string, unknown>;
  if (!exactKeys(state, [
    'schema_version',
    'completed_runs',
    'feedback',
    'processed_watermarks',
    'candidates',
  ]) || state['schema_version'] !== STATE_SCHEMA_VERSION
    || !Array.isArray(state['completed_runs'])
    || state['completed_runs'].length > 1
    || !state['completed_runs'].every(validCompletedRun)
    || !Array.isArray(state['feedback'])
    || state['feedback'].length > 1
    || !state['feedback'].every(validFeedback)
    || !Array.isArray(state['processed_watermarks'])
    || state['processed_watermarks'].length > 1
    || !state['processed_watermarks'].every(safeHash)
    || !Array.isArray(state['candidates'])
    || state['candidates'].length > 1
    || !state['candidates'].every(validCandidate)) {
    fail('FIXTURE_INVALID', 'Fixture learning state does not match its bounded schema.');
  }
  const parsed = clone(state) as MutableState;
  if (parsed.processed_watermarks.length !== parsed.candidates.length) {
    fail('FIXTURE_INVALID', 'Fixture processed watermarks and candidates must have one-to-one cardinality.');
  }
  for (const feedback of parsed.feedback) {
    if (!parsed.completed_runs.some((run) => run.id === feedback.run_id)) {
      fail('FIXTURE_INVALID', 'Fixture feedback cites a missing completed run.');
    }
  }
  for (const candidate of parsed.candidates) {
    const expected = hashValue({
      run_ids: [...candidate.citations.run_ids].sort(compareUnicode),
      feedback_ids: [...candidate.citations.feedback_ids].sort(compareUnicode),
    });
    if (candidate.watermark !== expected
      || !candidate.citations.run_ids.every((id) => parsed.completed_runs.some((run) => run.id === id))
      || !candidate.citations.feedback_ids.every((id) => parsed.feedback.some((entry) => entry.id === id))
      || !parsed.processed_watermarks.includes(candidate.watermark)) {
      fail('FIXTURE_INVALID', 'Fixture candidate citations do not match its processed watermark.');
    }
  }
  return parsed;
}

function readState(path: string): MutableState {
  if (!existsSync(path)) return emptyState();
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    fail('FIXTURE_INVALID', 'Fixture learning state must be a bounded regular file.');
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_STATE_BYTES) fail('FIXTURE_INVALID', 'Fixture learning state exceeds its byte limit.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('FIXTURE_INVALID', 'Fixture learning state is not valid UTF-8 JSON.');
  }
  return validateState(decoded);
}

function writeState(path: string, state: MutableState): void {
  const validated = validateState(state);
  const content = `${canonicalJson(validated)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) {
    fail('FIXTURE_LIMIT', 'Fixture learning state exceeds its byte limit.');
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function recordById<T>(options: {
  path: string;
  state: MutableState;
  collection: T[];
  record: T & { id: string };
  kind: string;
}): SeededRecordResult<T> {
  const existing = options.collection.find((entry) => (entry as T & { id: string }).id === options.record.id);
  if (existing !== undefined) {
    if (canonicalJson(existing) !== canonicalJson(options.record)) {
      fail('FIXTURE_CONFLICT', `Fixture ${options.kind} ID was replayed with different bytes.`);
    }
    return deepFreeze({ status: 'existing', record: clone(existing), content_hash: hashValue(existing) });
  }
  if (options.collection.length >= 1) {
    fail('FIXTURE_LIMIT', `Fixture ${options.kind} collection is already full.`);
  }
  const stored = clone(options.record);
  options.collection.push(stored);
  writeState(options.path, options.state);
  return deepFreeze({ status: 'created', record: clone(stored), content_hash: hashValue(stored) });
}

export function hashSeededLearningValue(value: unknown): string {
  return hashValue(value);
}

export function openSeededLearningStore(path: string): SeededLearningStore {
  return {
    snapshot() {
      return deepFreeze(clone(readState(path)));
    },
    status() {
      return learningStatus(readState(path));
    },
    recordCompletedRun(record) {
      if (!validCompletedRun(record)) fail('FIXTURE_INVALID', 'Fixture completed run is invalid.');
      const state = readState(path);
      return recordById({
        path,
        state,
        collection: state.completed_runs,
        record,
        kind: 'completed-run',
      });
    },
    recordFeedback(record) {
      if (!validFeedback(record)) fail('FIXTURE_INVALID', 'Fixture feedback is invalid.');
      const state = readState(path);
      if (!state.completed_runs.some((run) => run.id === record.run_id)) {
        fail('FIXTURE_NOT_FOUND', 'Fixture feedback cites a missing completed run.');
      }
      return recordById({
        path,
        state,
        collection: state.feedback,
        record,
        kind: 'feedback',
      });
    },
    createCandidate(record) {
      if (!validCandidate(record)) fail('FIXTURE_INVALID', 'Fixture lesson candidate is invalid.');
      const state = readState(path);
      const existing = state.candidates.find((entry) => entry.id === record.id);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(record)) {
          fail('FIXTURE_CONFLICT', 'Fixture candidate ID was replayed with different bytes.');
        }
        return deepFreeze({ status: 'existing', record: clone(existing), content_hash: hashValue(existing) });
      }
      if (state.candidates.length >= 1) fail('FIXTURE_LIMIT', 'Fixture candidate collection is already full.');
      const current = learningStatus(state);
      if (current.status !== 'due' || current.watermark === null) {
        fail('FIXTURE_NOT_DUE', 'Fixture learning state has no unprocessed due watermark.');
      }
      if (record.watermark !== current.watermark
        || canonicalJson(record.citations.run_ids) !== canonicalJson(current.run_ids)
        || canonicalJson(record.citations.feedback_ids) !== canonicalJson(current.feedback_ids)) {
        fail('FIXTURE_CONFLICT', 'Fixture candidate does not cite the complete due watermark.');
      }
      const target = state.completed_runs.find((run) => run.id === current.run_ids[0])?.target;
      if (target === undefined || record.target !== target) {
        fail('FIXTURE_CONFLICT', 'Fixture candidate target does not match its completed run.');
      }
      state.candidates.push(clone(record));
      state.processed_watermarks.push(current.watermark);
      writeState(path, state);
      return deepFreeze({ status: 'created', record: clone(record), content_hash: hashValue(record) });
    },
    candidate(id) {
      if (!safeId(id)) fail('FIXTURE_INVALID', 'Fixture candidate ID is invalid.');
      const found = readState(path).candidates.find((entry) => entry.id === id);
      return found === undefined
        ? null
        : deepFreeze({ status: 'existing', record: clone(found), content_hash: hashValue(found) });
    },
  };
}

function lessonScope(scope: SeededLessonDefinition['scope']): string {
  return `plan:${scope.function}/${scope.agent}#${scope.plan}`;
}

function lessonTarget(scope: SeededLessonDefinition['scope']): string {
  return `${scope.function}/${scope.agent}#${scope.plan}`;
}

function renderSeededLesson(lesson: SeededLessonDefinition): string {
  if (!boundedMarkdown(lesson.body)) fail('FIXTURE_INVALID', 'Fixture lesson body is invalid.');
  const prefix = renderMarkdownDefinition('lesson', lesson.id, lesson.purpose, lesson.scope);
  const content = `${prefix}\n${lesson.body}${lesson.body.endsWith('\n') ? '' : '\n'}`;
  const parsed = parseMarkdownDefinition(content, `fixture:${lesson.id}.md`);
  if (parsed.id !== lesson.id || parsed.kind !== 'lesson'
    || parsed.purpose !== lesson.purpose
    || canonicalJson(parsed.scope) !== canonicalJson(lesson.scope)) {
    fail('FIXTURE_INVALID', 'Fixture lesson bytes do not match the requested identity.');
  }
  return content;
}

export function materializeSeededLesson(options: {
  store: SeededLearningStore;
  workspaceRoot: string;
  candidateId: string;
  expectedCandidateHash: string;
  lesson: SeededLessonDefinition;
}): SeededLessonMaterialization {
  const candidate = options.store.candidate(options.candidateId);
  if (candidate === null) fail('FIXTURE_NOT_FOUND', 'Fixture lesson candidate was not found.');
  if (!safeHash(options.expectedCandidateHash)
    || candidate.content_hash !== options.expectedCandidateHash) {
    fail('FIXTURE_CONFLICT', 'Fixture lesson candidate hash does not match the stored candidate.');
  }
  if (candidate.record.target !== lessonTarget(options.lesson.scope)) {
    fail('FIXTURE_CONFLICT', 'Fixture lesson scope does not match the candidate target.');
  }
  if (candidate.record.lesson_id !== options.lesson.id) {
    fail('FIXTURE_CONFLICT', 'Fixture lesson identity does not match the stored candidate.');
  }
  const content = renderSeededLesson(options.lesson);
  const scaffolded = scaffoldWorkspace(options.workspaceRoot, {
    kind: 'lesson',
    id: options.lesson.id,
    scope: lessonScope(options.lesson.scope),
    purpose: options.lesson.purpose,
  });
  const before = readWorkspaceFile(options.workspaceRoot, scaffolded.record.path);
  if (scaffolded.status === 'existing') {
    if (!before.equals(Buffer.from(content, 'utf8'))) {
      fail('FIXTURE_CONFLICT', 'Fixture lesson already exists with different bytes.');
    }
  } else if (!before.equals(Buffer.from(content, 'utf8'))) {
    replaceWorkspaceFile(options.workspaceRoot, scaffolded.record.path, content, {
      expectedHash: hashWorkspaceBytes(before),
    });
  }
  const validation = validateWorkspace(options.workspaceRoot, { target: candidate.record.target });
  if (!validation.ok) fail('FIXTURE_INVALID', 'Materialized fixture lesson did not validate with its workspace.');
  return deepFreeze({
    status: scaffolded.status === 'existing' ? 'existing' : 'created',
    qualified_id: scaffolded.record.qualified_id,
    path: scaffolded.record.path,
    source_hash: hashWorkspaceBytes(content),
    content,
  });
}
