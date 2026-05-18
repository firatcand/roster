import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shellEscape } from '../src/lib/shell-escape.ts';

test('shellEscape: simple alphanumeric is single-quoted', () => {
  assert.equal(shellEscape('simple'), "'simple'");
});

test('shellEscape: empty string yields empty pair', () => {
  assert.equal(shellEscape(''), "''");
});

test("shellEscape: single quote becomes the POSIX close-escape-reopen idiom", () => {
  // it's  →  'it'\''s'
  assert.equal(shellEscape("it's"), "'it'\\''s'");
});

test('shellEscape: multiple internal single quotes', () => {
  assert.equal(shellEscape("a'b'c"), "'a'\\''b'\\''c'");
});

const adversarialInputs: ReadonlyArray<{ name: string; input: string }> = [
  { name: 'dollar-paren', input: '$(date)' },
  { name: 'backtick', input: '`whoami`' },
  { name: 'semicolon-rm', input: '; rm -rf /' },
  { name: 'and-and', input: '&& echo pwned' },
  { name: 'pipe', input: '| cat /etc/passwd' },
  { name: 'star-glob', input: '* *' },
  { name: 'backslash', input: 'a\\b' },
  { name: 'newline', input: 'line1\nline2' },
  { name: 'double-quote', input: 'has "double" quotes' },
  { name: 'mixed', input: `\${HOME}/path with spaces 'and quotes'` },
];

for (const c of adversarialInputs) {
  test(`shellEscape: bash round-trip is byte-identical (${c.name})`, () => {
    // Feed `printf %s <escaped>` to bash. If the escape works, printf emits the
    // raw input verbatim. If anything inside expands, the bytes diverge.
    const cmd = `printf %s ${shellEscape(c.input)}`;
    const out = execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
    assert.equal(out, c.input);
  });
}
