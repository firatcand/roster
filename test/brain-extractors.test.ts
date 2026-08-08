import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  BRAIN_EXTRACTORS,
  COMPILED_ACTIVE_EXTRACTORS,
  deriveChunkId,
  deriveExtractionId,
  extractBrainSourceBytes,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_CHARS,
  MAX_EXTRACTION_BYTES,
  MAX_STRUCTURED_BYTES,
  mediaTypeEssence,
  resolveBrainExtractor,
  type ExtractedChunk,
  type ExtractionOutcome,
} from '../src/lib/brain/extractors.ts';

const VERSION_ID = `sha256:${'a'.repeat(64)}`;

function bytesOf(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

function complete(outcome: ExtractionOutcome): Extract<ExtractionOutcome, { status: 'complete' }> {
  assert.equal(outcome.status, 'complete');
  return outcome as Extract<ExtractionOutcome, { status: 'complete' }>;
}

function unsupported(outcome: ExtractionOutcome): Extract<ExtractionOutcome, { status: 'unsupported' }> {
  assert.equal(outcome.status, 'unsupported');
  return outcome as Extract<ExtractionOutcome, { status: 'unsupported' }>;
}

function assertLocatorsExact(bytes: Uint8Array, chunks: readonly ExtractedChunk[]): void {
  const text = Buffer.from(bytes);
  for (const chunk of chunks) {
    assert.ok(chunk.byteEnd > chunk.byteStart, 'chunk byte range must be non-empty');
    assert.ok(chunk.byteEnd <= bytes.byteLength, 'chunk byte range stays inside the object');
    assert.equal(
      text.subarray(chunk.byteStart, chunk.byteEnd).toString('utf8'),
      chunk.content,
      'chunk content must be the exact byte slice it cites',
    );
    assert.equal(
      chunk.contentSha256,
      createHash('sha256').update(Buffer.from(chunk.content, 'utf8')).digest('hex'),
    );
    assert.ok(chunk.lineStart >= 1);
    assert.ok(chunk.lineEnd >= chunk.lineStart);
    const before = text.subarray(0, chunk.byteStart).toString('utf8');
    assert.equal(chunk.lineStart, before.split('\n').length, 'line_start counts newlines before the chunk');
    const through = text.subarray(0, chunk.byteEnd).toString('utf8');
    assert.equal(chunk.lineEnd, through.split('\n').length, 'line_end counts newlines through the chunk');
    assert.ok(Buffer.byteLength(chunk.content, 'utf8') <= MAX_CHUNK_BYTES);
    assert.ok(chunk.content.length <= MAX_CHUNK_CHARS);
    assert.ok(Buffer.byteLength(chunk.content, 'utf8') >= 1);
  }
  chunks.forEach((chunk, index) => assert.equal(chunk.chunkIndex, index));
}

test('the compiled extractor registry is closed and deterministic', () => {
  assert.deepEqual(
    BRAIN_EXTRACTORS.map((extractor) => [extractor.name, extractor.version]),
    [['roster-structured', 1], ['roster-text', 1]],
  );
  assert.deepEqual([...COMPILED_ACTIVE_EXTRACTORS.entries()].sort(), [
    ['roster-structured', 1],
    ['roster-text', 1],
  ]);
  assert.equal(mediaTypeEssence('Text/Markdown; charset=UTF-8'), 'text/markdown');
  assert.equal(resolveBrainExtractor('application/json').name, 'roster-structured');
  assert.equal(resolveBrainExtractor('application/vnd.roster+json').name, 'roster-structured');
  assert.equal(resolveBrainExtractor('text/plain').name, 'roster-text');
  assert.equal(resolveBrainExtractor('image/png').name, 'roster-text');
});

test('identical bytes produce identical chunks, ids, and locators', () => {
  const bytes = bytesOf('# Title\n\nAlpha paragraph.\n\n## Second\n\nBeta paragraph.\n');
  const first = complete(extractBrainSourceBytes('text/markdown', bytes));
  const second = complete(extractBrainSourceBytes('text/markdown', Buffer.from(bytes)));
  assert.deepEqual(first, second);
  assert.equal(first.extractorName, 'roster-text');
  assert.equal(first.extractorVersion, 1);
  assert.equal(first.structured, null);
  assert.equal(first.textSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(first.chunks.length, 2);
  assert.equal(first.chunks[0]!.content, '# Title\n\nAlpha paragraph.');
  assert.equal(first.chunks[1]!.content, '## Second\n\nBeta paragraph.');
  assertLocatorsExact(bytes, first.chunks);

  const extractionId = deriveExtractionId(VERSION_ID, first.extractorName, first.extractorVersion);
  assert.match(extractionId, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(extractionId, deriveExtractionId(VERSION_ID, 'roster-text', 1));
  assert.notEqual(extractionId, deriveExtractionId(VERSION_ID, 'roster-text', 2));
  assert.notEqual(extractionId, deriveExtractionId(VERSION_ID, 'roster-structured', 1));
  const chunkId = deriveChunkId(extractionId, 0);
  assert.match(chunkId, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(chunkId, deriveChunkId(extractionId, 1));
});

test('markdown chunking splits on headings and plain text on paragraphs', () => {
  const markdown = bytesOf('intro line\n# One\nbody one\n# Two\nbody two\n');
  const md = complete(extractBrainSourceBytes('text/markdown', markdown));
  assert.deepEqual(md.chunks.map((chunk) => chunk.content), [
    'intro line',
    '# One\nbody one',
    '# Two\nbody two',
  ]);
  assertLocatorsExact(markdown, md.chunks);

  const plain = bytesOf('first para line one\nfirst para line two\n\n\nsecond para\n');
  const text = complete(extractBrainSourceBytes('text/plain', plain));
  assert.deepEqual(text.chunks.map((chunk) => chunk.content), [
    'first para line one\nfirst para line two',
    'second para',
  ]);
  assertLocatorsExact(plain, text.chunks);
});

test('locators stay byte-exact under multibyte UTF-8, CRLF, and a BOM', () => {
  const multibyte = bytesOf('héllo wörld — ünïcode\n\n日本語のテキスト\n');
  const decoded = complete(extractBrainSourceBytes('text/plain', multibyte));
  assert.deepEqual(decoded.chunks.map((chunk) => chunk.content), ['héllo wörld — ünïcode', '日本語のテキスト']);
  assertLocatorsExact(multibyte, decoded.chunks);
  assert.equal(decoded.chunks[1]!.byteStart, multibyte.indexOf(Buffer.from('日本語', 'utf8')));

  const crlf = bytesOf('alpha line\r\nbeta line\r\n\r\ngamma line\r\n');
  const windows = complete(extractBrainSourceBytes('text/plain', crlf));
  assert.deepEqual(windows.chunks.map((chunk) => chunk.content), ['alpha line\r\nbeta line', 'gamma line']);
  assertLocatorsExact(crlf, windows.chunks);
  assert.equal(windows.chunks[0]!.lineStart, 1);
  assert.equal(windows.chunks[0]!.lineEnd, 2);
  assert.equal(windows.chunks[1]!.lineStart, 4);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf('bom body\n')]);
  const withBom = complete(extractBrainSourceBytes('text/plain', bom));
  assert.deepEqual(withBom.chunks.map((chunk) => chunk.content), ['bom body']);
  assert.equal(withBom.chunks[0]!.byteStart, 3, 'the BOM stays in the byte accounting');
  assertLocatorsExact(bom, withBom.chunks);
  assert.equal(
    withBom.textSha256,
    createHash('sha256').update(bytesOf('bom body\n')).digest('hex'),
  );

  const astral = bytesOf('emoji 😀 tail\n');
  const emoji = complete(extractBrainSourceBytes('text/plain', astral));
  assertLocatorsExact(astral, emoji.chunks);
});

test('over-long content is windowed inside both the char and byte caps', () => {
  const longLength = MAX_CHUNK_BYTES * 2 + 17;
  const longLine = `${'x'.repeat(longLength)}\n`;
  const windowed = complete(extractBrainSourceBytes('text/plain', bytesOf(longLine)));
  assert.equal(windowed.chunks.length, Math.ceil(longLength / MAX_CHUNK_CHARS));
  assertLocatorsExact(bytesOf(longLine), windowed.chunks);
  assert.equal(windowed.chunks.every((chunk) => chunk.lineStart === 1 && chunk.lineEnd === 1), true);

  const wideChars = `${'é'.repeat(MAX_CHUNK_BYTES)}\n`;
  const wide = complete(extractBrainSourceBytes('text/plain', bytesOf(wideChars)));
  assertLocatorsExact(bytesOf(wideChars), wide.chunks);
  assert.ok(wide.chunks.length >= 2);

  const manyLines = `${Array.from({ length: 4_000 }, (_unused, index) => `line ${index}`).join('\n')}\n`;
  const packed = complete(extractBrainSourceBytes('text/plain', bytesOf(manyLines)));
  assertLocatorsExact(bytesOf(manyLines), packed.chunks);
  assert.ok(packed.chunks.length >= 2);
});

test('empty and whitespace-only content extracts to zero chunks but stays complete', () => {
  const empty = complete(extractBrainSourceBytes('text/plain', bytesOf('')));
  assert.deepEqual(empty.chunks, []);
  assert.equal(empty.textSha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));

  const blank = complete(extractBrainSourceBytes('text/markdown', bytesOf('\n\n   \n\t\n')));
  assert.deepEqual(blank.chunks, []);
});

test('the refusal matrix uses exactly the closed reasons', () => {
  assert.equal(unsupported(extractBrainSourceBytes('image/png', bytesOf('anything'))).reason, 'media-type');
  assert.equal(
    unsupported(extractBrainSourceBytes('application/octet-stream', bytesOf('anything'))).reason,
    'media-type',
  );
  assert.equal(
    unsupported(extractBrainSourceBytes('text/plain', Buffer.from([0x61, 0x00, 0x62]))).reason,
    'binary',
  );
  assert.equal(
    unsupported(extractBrainSourceBytes('text/plain', Buffer.from([0x61, 0x07, 0x62]))).reason,
    'binary',
  );
  assert.equal(
    unsupported(extractBrainSourceBytes('text/plain', Buffer.from([0x61, 0xff, 0xfe, 0x62]))).reason,
    'invalid-utf8',
  );
  assert.equal(
    unsupported(extractBrainSourceBytes('text/plain', Buffer.alloc(MAX_EXTRACTION_BYTES + 1, 0x61))).reason,
    'too-large',
  );
  const unsupportedOutcome = unsupported(extractBrainSourceBytes('image/png', bytesOf('anything')));
  assert.equal(unsupportedOutcome.extractorName, 'roster-text');
  assert.equal(unsupportedOutcome.extractorVersion, 1);
});

test('structured extraction renders deterministic text and cites the source document', () => {
  const record = '{\n  "beta": [1, 2],\n  "alpha": {"nested": "value"},\n  "empty": {}\n}\n';
  const bytes = bytesOf(record);
  const outcome = complete(extractBrainSourceBytes('application/json', bytes));
  assert.equal(outcome.extractorName, 'roster-structured');
  assert.deepEqual(outcome.structured, { beta: [1, 2], alpha: { nested: 'value' }, empty: {} });
  assert.equal(outcome.chunks.length, 1);
  assert.equal(
    outcome.chunks[0]!.content,
    '$.alpha.nested: value\n$.beta[0]: 1\n$.beta[1]: 2\n$.empty: {}',
  );
  assert.equal(outcome.chunks[0]!.byteStart, 0);
  assert.equal(outcome.chunks[0]!.byteEnd, bytes.byteLength);
  assert.equal(outcome.chunks[0]!.lineStart, 1);
  assert.equal(outcome.chunks[0]!.lineEnd, 5);
  assert.equal(
    outcome.chunks[0]!.contentSha256,
    createHash('sha256').update(bytesOf(outcome.chunks[0]!.content)).digest('hex'),
  );

  const reordered = bytesOf('{"alpha":{"nested":"value"},"empty":{},"beta":[1,2]}');
  const again = complete(extractBrainSourceBytes('application/json', reordered));
  assert.equal(again.chunks[0]!.content, outcome.chunks[0]!.content);
  assert.equal(again.textSha256, outcome.textSha256);
});

test('structured extraction refuses non-strict JSON and out-of-bounds records', () => {
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf('{"a":1'))).reason, 'media-type');
  assert.equal(
    unsupported(extractBrainSourceBytes('application/json', bytesOf('{"a":1} trailing'))).reason,
    'media-type',
  );
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf('NaN'))).reason, 'media-type');
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf('42'))).reason, 'media-type');
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf('"text"'))).reason, 'media-type');

  const oversized = JSON.stringify({ blob: 'z'.repeat(MAX_STRUCTURED_BYTES) });
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf(oversized))).reason, 'too-large');

  let deep: unknown = 'leaf';
  for (let level = 0; level < 40; level += 1) deep = { deep };
  assert.equal(
    unsupported(extractBrainSourceBytes('application/json', bytesOf(JSON.stringify(deep)))).reason,
    'too-large',
  );

  const wide = JSON.stringify(Array.from({ length: 30_000 }, (_unused, index) => index));
  assert.equal(unsupported(extractBrainSourceBytes('application/json', bytesOf(wide))).reason, 'too-large');
});

test('a BOM-prefixed structured record parses and cites the whole document', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytesOf('{"a":1}')]);
  const outcome = complete(extractBrainSourceBytes('application/json', bytes));
  assert.deepEqual(outcome.structured, { a: 1 });
  assert.equal(outcome.chunks[0]!.byteStart, 0);
  assert.equal(outcome.chunks[0]!.byteEnd, bytes.byteLength);
});
