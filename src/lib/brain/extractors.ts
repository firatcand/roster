import { createHash } from 'node:crypto';
import { canonicalSourceJson, type SourceJsonValue } from './source-contracts.ts';

export const SOURCE_EXTRACTION_DOMAIN = 'roster.brain.source-extraction.v1';
export const SOURCE_CHUNK_DOMAIN = 'roster.brain.source-chunk.v1';

export const MAX_EXTRACTION_BYTES = 4 * 1024 * 1024;
export const MAX_CHUNK_CHARS = 8_192;
export const MAX_CHUNK_BYTES = 16_384;
export const MAX_CHUNK_INDEX = 65_535;
export const MAX_STRUCTURED_BYTES = 262_144;
export const MAX_STRUCTURED_DEPTH = 24;
export const MAX_STRUCTURED_NODES = 20_000;

export const EXTRACTION_REFUSAL_REASONS = [
  'media-type',
  'invalid-utf8',
  'binary',
  'too-large',
] as const;
export type ExtractionRefusalReason = (typeof EXTRACTION_REFUSAL_REASONS)[number];

export type ExtractedChunk = Readonly<{
  chunkIndex: number;
  content: string;
  contentSha256: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
}>;

export type ExtractionOutcome =
  | Readonly<{
      status: 'complete';
      extractorName: string;
      extractorVersion: number;
      textSha256: string;
      structured: SourceJsonValue | null;
      chunks: readonly ExtractedChunk[];
    }>
  | Readonly<{
      status: 'unsupported';
      extractorName: string;
      extractorVersion: number;
      reason: ExtractionRefusalReason;
    }>;

type ExtractionBody =
  | { status: 'complete'; textSha256: string; structured: SourceJsonValue | null; chunks: ExtractedChunk[] }
  | { status: 'unsupported'; reason: ExtractionRefusalReason };

export type BrainExtractor = Readonly<{
  name: string;
  version: number;
  supports: (mediaTypeEssence: string) => boolean;
  run: (bytes: Uint8Array, mediaTypeEssence: string) => ExtractionBody;
}>;

type ByteLine = Readonly<{
  number: number;
  start: number;
  contentEnd: number;
  end: number;
  chars: number;
  contentChars: number;
  blank: boolean;
}>;

const HEADING = /^#{1,6}\s/u;
const BOM = [0xef, 0xbb, 0xbf] as const;

function hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function mediaTypeEssence(mediaType: string): string {
  const separator = mediaType.indexOf(';');
  return (separator === -1 ? mediaType : mediaType.slice(0, separator)).trim().toLowerCase();
}

function decodeStrict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

function slice(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes.subarray(start, end));
}

// Binary refusal is a byte test, not a decode test: NUL and the other C0/DEL
// control bytes never appear in extractable prose, and a lexical index over
// them is meaningless.
function hasControlBytes(bytes: Uint8Array, from: number): boolean {
  for (let index = from; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return true;
  }
  return false;
}

function bomLength(bytes: Uint8Array): number {
  return bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2] ? 3 : 0;
}

function indexLines(bytes: Uint8Array, from: number): ByteLine[] {
  const lines: ByteLine[] = [];
  let start = from;
  let number = 1;
  const push = (contentEnd: number, end: number): void => {
    const content = slice(bytes, start, contentEnd);
    lines.push({
      number,
      start,
      contentEnd,
      end,
      chars: slice(bytes, start, end).length,
      contentChars: content.length,
      blank: content.trim().length === 0,
    });
    number += 1;
  };
  for (let index = from; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const contentEnd = index > start && bytes[index - 1] === 0x0d ? index - 1 : index;
    push(contentEnd, index + 1);
    start = index + 1;
  }
  if (start < bytes.length) push(bytes.length, bytes.length);
  return lines;
}

function chunkOf(
  bytes: Uint8Array,
  byteStart: number,
  byteEnd: number,
  lineStart: number,
  lineEnd: number,
  chunks: ExtractedChunk[],
): void {
  const content = slice(bytes, byteStart, byteEnd);
  if (content.trim().length === 0) return;
  chunks.push(Object.freeze({
    chunkIndex: chunks.length,
    content,
    contentSha256: hex(Buffer.from(content, 'utf8')),
    byteStart,
    byteEnd,
    lineStart,
    lineEnd,
  }));
}

// Splits one over-long byte range at UTF-8 code-point boundaries so neither the
// character cap nor the byte cap is ever crossed and no code point is severed.
function splitCodePoints(
  bytes: Uint8Array,
  from: number,
  to: number,
  lineNumber: number,
  chunks: ExtractedChunk[],
): void {
  let start = from;
  let cursor = from;
  let chars = 0;
  while (cursor < to) {
    let width = 1;
    while (cursor + width < to && (bytes[cursor + width]! & 0xc0) === 0x80) width += 1;
    const units = width >= 4 ? 2 : 1;
    if (cursor > start && (cursor + width - start > MAX_CHUNK_BYTES || chars + units > MAX_CHUNK_CHARS)) {
      chunkOf(bytes, start, cursor, lineNumber, lineNumber, chunks);
      start = cursor;
      chars = 0;
    }
    chars += units;
    cursor += width;
  }
  if (start < to) chunkOf(bytes, start, to, lineNumber, lineNumber, chunks);
}

function emitLineRange(
  bytes: Uint8Array,
  lines: readonly ByteLine[],
  first: number,
  last: number,
  chunks: ExtractedChunk[],
): void {
  let head = first;
  let tail = last;
  while (head <= tail && lines[head]!.blank) head += 1;
  while (tail >= head && lines[tail]!.blank) tail -= 1;
  if (head > tail) return;

  let openIndex = -1;
  let openChars = 0;
  const flush = (endIndex: number): void => {
    if (openIndex === -1) return;
    chunkOf(
      bytes,
      lines[openIndex]!.start,
      lines[endIndex]!.contentEnd,
      lines[openIndex]!.number,
      lines[endIndex]!.number,
      chunks,
    );
    openIndex = -1;
    openChars = 0;
  };

  for (let index = head; index <= tail; index += 1) {
    const line = lines[index]!;
    const alone = line.contentEnd - line.start > MAX_CHUNK_BYTES || line.contentChars > MAX_CHUNK_CHARS;
    if (alone) {
      flush(index - 1);
      splitCodePoints(bytes, line.start, line.contentEnd, line.number, chunks);
      continue;
    }
    if (openIndex === -1) {
      openIndex = index;
      openChars = line.contentChars;
      continue;
    }
    const bytesWith = line.contentEnd - lines[openIndex]!.start;
    const charsWith = openChars + (lines[index - 1]!.chars - lines[index - 1]!.contentChars) + line.contentChars;
    if (bytesWith > MAX_CHUNK_BYTES || charsWith > MAX_CHUNK_CHARS) {
      flush(index - 1);
      openIndex = index;
      openChars = line.contentChars;
      continue;
    }
    openChars = charsWith;
  }
  flush(tail);
}

function sectionBoundaries(bytes: Uint8Array, lines: readonly ByteLine[], markdown: boolean): number[][] {
  const sections: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (markdown) {
      const text = slice(bytes, line.start, line.contentEnd);
      if (HEADING.test(text) && current.length > 0) {
        sections.push(current);
        current = [];
      }
      current.push(index);
      continue;
    }
    if (line.blank) {
      if (current.length > 0) sections.push(current);
      current = [];
      continue;
    }
    current.push(index);
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

function extractText(bytes: Uint8Array, markdown: boolean): ExtractionBody {
  if (bytes.byteLength > MAX_EXTRACTION_BYTES) return { status: 'unsupported', reason: 'too-large' };
  if (decodeStrict(bytes) === null) return { status: 'unsupported', reason: 'invalid-utf8' };
  const contentStart = bomLength(bytes);
  if (hasControlBytes(bytes, contentStart)) return { status: 'unsupported', reason: 'binary' };

  const lines = indexLines(bytes, contentStart);
  const chunks: ExtractedChunk[] = [];
  for (const section of sectionBoundaries(bytes, lines, markdown)) {
    emitLineRange(bytes, lines, section[0]!, section[section.length - 1]!, chunks);
    if (chunks.length > MAX_CHUNK_INDEX + 1) return { status: 'unsupported', reason: 'too-large' };
  }
  return {
    status: 'complete',
    textSha256: hex(bytes.subarray(contentStart)),
    structured: null,
    chunks,
  };
}

function jsonWithinBounds(value: unknown, depth: number, budget: { nodes: number }): boolean {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > MAX_STRUCTURED_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => jsonWithinBounds(entry, depth + 1, budget));
  if (typeof value !== 'object') return false;
  return Object.keys(value as Record<string, unknown>)
    .every((key) => jsonWithinBounds((value as Record<string, unknown>)[key], depth + 1, budget));
}

function renderScalar(value: SourceJsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function renderStructured(value: SourceJsonValue, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}: []`);
      return;
    }
    value.forEach((entry, index) => renderStructured(entry, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      out.push(`${path}: {}`);
      return;
    }
    for (const key of keys) renderStructured(value[key]!, `${path}.${key}`, out);
    return;
  }
  out.push(`${path}: ${renderScalar(value)}`);
}

function extractStructured(bytes: Uint8Array): ExtractionBody {
  if (bytes.byteLength > MAX_EXTRACTION_BYTES) return { status: 'unsupported', reason: 'too-large' };
  const decoded = decodeStrict(bytes);
  if (decoded === null) return { status: 'unsupported', reason: 'invalid-utf8' };
  const contentStart = bomLength(bytes);
  if (hasControlBytes(bytes, contentStart)) return { status: 'unsupported', reason: 'binary' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(contentStart === 0 ? decoded : decoded.slice(1));
  } catch {
    // Content that does not parse as the structured record its media type
    // declares is refused as a media-type mismatch — the closed refusal set has
    // no separate "malformed payload" reason by design.
    return { status: 'unsupported', reason: 'media-type' };
  }
  if (parsed === null || typeof parsed !== 'object') return { status: 'unsupported', reason: 'media-type' };
  if (!jsonWithinBounds(parsed, 0, { nodes: MAX_STRUCTURED_NODES })) {
    return { status: 'unsupported', reason: 'too-large' };
  }
  const structured = parsed as SourceJsonValue;
  if (Buffer.byteLength(canonicalSourceJson(structured), 'utf8') > MAX_STRUCTURED_BYTES) {
    return { status: 'unsupported', reason: 'too-large' };
  }

  const rendered: string[] = [];
  renderStructured(structured, '$', rendered);
  const text = rendered.join('\n');
  const textBytes = Buffer.from(text, 'utf8');
  if (textBytes.byteLength > MAX_EXTRACTION_BYTES) return { status: 'unsupported', reason: 'too-large' };

  // Every rendered chunk cites the byte and line range of the source JSON it was
  // rendered from — the projection is not a byte slice of the source, so the
  // whole immutable document is the exact citable region.
  const sourceLines = Math.max(indexLines(bytes, 0).length, 1);
  const projected: ExtractedChunk[] = [];
  const renderedLines = indexLines(textBytes, 0);
  const window: ExtractedChunk[] = [];
  for (const section of sectionBoundaries(textBytes, renderedLines, false)) {
    emitLineRange(textBytes, renderedLines, section[0]!, section[section.length - 1]!, window);
  }
  for (const chunk of window) {
    projected.push(Object.freeze({
      chunkIndex: projected.length,
      content: chunk.content,
      contentSha256: chunk.contentSha256,
      byteStart: 0,
      byteEnd: bytes.byteLength,
      lineStart: 1,
      lineEnd: sourceLines,
    }));
  }
  if (projected.length > MAX_CHUNK_INDEX + 1) return { status: 'unsupported', reason: 'too-large' };
  return {
    status: 'complete',
    textSha256: hex(textBytes),
    structured,
    chunks: projected,
  };
}

const MARKDOWN_ESSENCES = new Set(['text/markdown', 'text/x-markdown']);

export const TEXT_EXTRACTOR: BrainExtractor = Object.freeze({
  name: 'roster-text',
  version: 1,
  supports: (essence: string) => essence.startsWith('text/'),
  run: (bytes: Uint8Array, essence: string) => extractText(bytes, MARKDOWN_ESSENCES.has(essence)),
});

export const STRUCTURED_EXTRACTOR: BrainExtractor = Object.freeze({
  name: 'roster-structured',
  version: 1,
  supports: (essence: string) => essence === 'application/json' || essence.endsWith('+json'),
  run: (bytes: Uint8Array) => extractStructured(bytes),
});

export const BRAIN_EXTRACTORS: readonly BrainExtractor[] = Object.freeze([
  STRUCTURED_EXTRACTOR,
  TEXT_EXTRACTOR,
]);

export const COMPILED_ACTIVE_EXTRACTORS: ReadonlyMap<string, number> = new Map(
  BRAIN_EXTRACTORS.map((extractor) => [extractor.name, extractor.version]),
);

export function resolveBrainExtractor(mediaType: string): BrainExtractor {
  const essence = mediaTypeEssence(mediaType);
  return BRAIN_EXTRACTORS.find((extractor) => extractor.supports(essence)) ?? TEXT_EXTRACTOR;
}

export function extractBrainSourceBytes(mediaType: string, bytes: Uint8Array): ExtractionOutcome {
  const essence = mediaTypeEssence(mediaType);
  const extractor = resolveBrainExtractor(mediaType);
  const identity = { extractorName: extractor.name, extractorVersion: extractor.version };
  if (!extractor.supports(essence)) {
    return Object.freeze({ status: 'unsupported', ...identity, reason: 'media-type' as const });
  }
  const body = extractor.run(bytes, essence);
  if (body.status === 'unsupported') {
    return Object.freeze({ status: 'unsupported', ...identity, reason: body.reason });
  }
  return Object.freeze({
    status: 'complete',
    ...identity,
    textSha256: body.textSha256,
    structured: body.structured,
    chunks: Object.freeze(body.chunks),
  });
}

function canonicalDigest(domain: string, value: SourceJsonValue): string {
  return `sha256:${hex(canonicalSourceJson({ domain, value }))}`;
}

export function deriveExtractionId(
  sourceVersionId: string,
  extractorName: string,
  extractorVersion: number,
): string {
  return canonicalDigest(SOURCE_EXTRACTION_DOMAIN, {
    source_version_id: sourceVersionId,
    extractor_name: extractorName,
    extractor_version: extractorVersion,
  });
}

export function deriveChunkId(extractionId: string, chunkIndex: number): string {
  return canonicalDigest(SOURCE_CHUNK_DOMAIN, {
    extraction_id: extractionId,
    chunk_index: chunkIndex,
  });
}
