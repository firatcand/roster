import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type WrapperKind = 'claude' | 'codex' | 'unknown';

export type ParsedWrapper = {
  wrapperPath: string;
  basename: string;
  promptFilePath: string | null;
  promptBody: string | null;
  kind: WrapperKind;
  usesClaudeMinusP: boolean;
};

export function parseWrapperFile(wrapperPath: string): ParsedWrapper {
  let body = '';
  try {
    body = readFileSync(wrapperPath, 'utf8');
  } catch {
    body = '';
  }
  const base = basename(wrapperPath, '.sh');
  const promptCandidates = [
    join(dirname(wrapperPath), `${base}-prompt.txt`),
    join(dirname(wrapperPath), `${base}.prompt.txt`),
  ];
  const promptFilePath = promptCandidates.find((p) => existsSync(p)) ?? null;
  let promptBody: string | null = null;
  if (promptFilePath !== null) {
    try {
      promptBody = readFileSync(promptFilePath, 'utf8');
    } catch {
      promptBody = null;
    }
  }

  const kind = detectKind(body);
  const usesClaudeMinusP = /\bclaude\s+-p\b/.test(body);

  return {
    wrapperPath,
    basename: base,
    promptFilePath,
    promptBody,
    kind,
    usesClaudeMinusP,
  };
}

function detectKind(body: string): WrapperKind {
  // Detect by command invocation; ignore mentions inside comments/strings best-effort.
  const stripped = body.replace(/#.*$/gm, '');
  const hasClaude = /(^|\s)claude(\s|$)/m.test(stripped);
  const hasCodex = /(^|\s)codex(\s|$)/m.test(stripped);
  if (hasCodex && !hasClaude) return 'codex';
  if (hasClaude && !hasCodex) return 'claude';
  if (hasClaude && hasCodex) return 'claude'; // mixed — prefer Claude as primary
  return 'unknown';
}

export type AgentPlanMapping =
  | { ok: true; function: string; agent: string; plan: string }
  | { ok: false; reason: 'no-match'; basename: string };

export type KnownAgentPath = {
  /** Dot-separated path: 'gtm.sdr' or 'dreamer'. */
  key: string;
  function: string;
  agent: string;
};

export function mapWrapperToAgentPlan(
  wrapperBasename: string,
  known: ReadonlyArray<KnownAgentPath>,
): AgentPlanMapping {
  // Sort longest-prefix first so 'gtm.sdr' beats 'gtm'.
  const sorted = [...known].sort((a, b) => b.key.length - a.key.length);
  const segments = wrapperBasename.split('-');

  for (const entry of sorted) {
    const keyParts = entry.key.split('.');
    if (keyParts.length > segments.length) continue;
    const match = keyParts.every((part, i) => segments[i] === part);
    if (!match) continue;
    const remainder = segments.slice(keyParts.length);
    if (remainder.length === 0) {
      return { ok: true, function: entry.function, agent: entry.agent, plan: 'default' };
    }
    return { ok: true, function: entry.function, agent: entry.agent, plan: remainder.join('-') };
  }

  return { ok: false, reason: 'no-match', basename: wrapperBasename };
}
