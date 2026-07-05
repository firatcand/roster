import { z } from 'zod';
import type { ToolKey } from '../tools.ts';

// Reviewer stdout is untrusted: the reviewed artifact itself may contain decoy
// ```json blocks trying to spoof the verdict (Codex 2nd-pass ③, ROS-155). The
// verdict is therefore framed by a per-run nonce sentinel that only the wrapper
// and the reviewer's prompt know; anything outside the frame is ignored.
export function verdictSentinelOpen(nonce: string): string {
  return `<<<ROSTER-VERDICT-${nonce}>>>`;
}

export function verdictSentinelClose(nonce: string): string {
  return `<<<END-ROSTER-VERDICT-${nonce}>>>`;
}

// Keep only the stdout tail: the sentinel/verdict is instructed to be emitted
// last, so a runaway reviewer that floods stdout loses noise, not the verdict.
export const RAW_TAIL_CAP_BYTES = 262_144; // 256 KiB

export const SEVERITIES = ['major', 'minor', 'nit', 'praise'] as const;
export type Severity = (typeof SEVERITIES)[number];

const findingSchema = z.object({
  severity: z.enum(SEVERITIES),
  message: z.string().min(1),
  location: z.string().optional(),
  confidence: z.number().optional(),
});

const verdictPayloadSchema = z.object({
  summary: z.string(),
  findings: z.array(findingSchema).default([]),
});

export type Finding = z.infer<typeof findingSchema>;

export type SecondOpinionResult = {
  summary: string;
  findings: Finding[];
  raw: string;
  host: ToolKey;
  structured: boolean;
};

function capTail(stdout: string): string {
  if (Buffer.byteLength(stdout, 'utf8') <= RAW_TAIL_CAP_BYTES) return stdout;
  // Slice by bytes from the end; tolerate a clipped leading code point.
  const buf = Buffer.from(stdout, 'utf8');
  return buf.subarray(buf.length - RAW_TAIL_CAP_BYTES).toString('utf8');
}

// Strip an optional markdown fence the reviewer may wrap the json in.
function unfence(block: string): string {
  const trimmed = block.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fenced !== null ? fenced[1]! : trimmed;
}

export function extractVerdict(stdout: string, nonce: string, host: ToolKey): SecondOpinionResult {
  const raw = capTail(stdout);
  const fallback: SecondOpinionResult = { summary: '', findings: [], raw, host, structured: false };

  const open = verdictSentinelOpen(nonce);
  const close = verdictSentinelClose(nonce);

  // Last complete frame wins (a reviewer may retry / re-emit its verdict).
  const start = raw.lastIndexOf(open);
  if (start === -1) return fallback;
  const end = raw.indexOf(close, start + open.length);
  if (end === -1) return fallback;

  const inner = unfence(raw.slice(start + open.length, end));

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return fallback;
  }

  const result = verdictPayloadSchema.safeParse(parsed);
  if (!result.success) return fallback;

  return {
    summary: result.data.summary,
    findings: result.data.findings,
    raw,
    host,
    structured: true,
  };
}
