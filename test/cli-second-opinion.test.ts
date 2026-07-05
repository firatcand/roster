import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSecondOpinion, type ExecuteSecondOpinionOpts } from '../src/commands/second-opinion.ts';
import type { RunSecondOpinionOpts, RunSecondOpinionResult } from '../src/lib/second-opinion/run.ts';

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'roster-so-cli-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureLogs(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
  return {
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

const OK_RESULT: RunSecondOpinionResult = {
  ok: true,
  result: {
    summary: 'Strong draft; intro drags.',
    findings: [
      { severity: 'major', message: 'Intro buries the lede', location: 'para 1', confidence: 8 },
      { severity: 'praise', message: 'Great CTA' },
    ],
    raw: 'full text',
    host: 'codex',
    structured: true,
  },
};

function makeOpts(dir: string, overrides: Partial<ExecuteSecondOpinionOpts>): ExecuteSecondOpinionOpts {
  return {
    files: [],
    stdin: false,
    timeoutSec: 180,
    json: false,
    cwd: dir,
    runFn: async () => OK_RESULT,
    ...overrides,
  };
}

test('cli: file input is read and passed to run as labeled artifact', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'artifact body');
    let seen: RunSecondOpinionOpts | undefined;
    const cap = captureLogs();
    try {
      const code = await executeSecondOpinion(
        makeOpts(dir, {
          files: ['a.md'],
          runFn: async (o) => {
            seen = o;
            return OK_RESULT;
          },
        }),
      );
      assert.equal(code, 0);
    } finally {
      cap.restore();
    }
    assert.ok(seen);
    assert.equal(seen!.inputs.length, 1);
    assert.equal(seen!.inputs[0]!.label, 'a.md');
    assert.equal(seen!.inputs[0]!.content, 'artifact body');
  });
});

test('cli: unreadable file → error before run, no spawn', async () => {
  await withTmpDir(async (dir) => {
    let called = false;
    const cap = captureLogs();
    try {
      await assert.rejects(
        executeSecondOpinion(
          makeOpts(dir, {
            files: ['missing.md'],
            runFn: async () => {
              called = true;
              return OK_RESULT;
            },
          }),
        ),
        /missing\.md/,
      );
    } finally {
      cap.restore();
    }
    assert.equal(called, false);
  });
});

test('cli: stdin content becomes an artifact', async () => {
  await withTmpDir(async (dir) => {
    let seen: RunSecondOpinionOpts | undefined;
    const cap = captureLogs();
    try {
      await executeSecondOpinion(
        makeOpts(dir, {
          stdin: true,
          readStdin: async () => 'piped words',
          runFn: async (o) => {
            seen = o;
            return OK_RESULT;
          },
        }),
      );
    } finally {
      cap.restore();
    }
    assert.equal(seen!.inputs[0]!.label, 'stdin');
    assert.equal(seen!.inputs[0]!.content, 'piped words');
  });
});

test('cli: empty stdin with --stdin → error', async () => {
  await withTmpDir(async (dir) => {
    const cap = captureLogs();
    try {
      await assert.rejects(
        executeSecondOpinion(makeOpts(dir, { stdin: true, readStdin: async () => '' })),
        /stdin/i,
      );
    } finally {
      cap.restore();
    }
  });
});

test('cli: diff artifact via git seam', async () => {
  await withTmpDir(async (dir) => {
    let seen: RunSecondOpinionOpts | undefined;
    const cap = captureLogs();
    try {
      await executeSecondOpinion(
        makeOpts(dir, {
          diff: 'HEAD',
          gitDiff: () => ({ ok: true, diff: '+ added line' }),
          runFn: async (o) => {
            seen = o;
            return OK_RESULT;
          },
        }),
      );
    } finally {
      cap.restore();
    }
    assert.equal(seen!.inputs[0]!.label, 'git diff HEAD');
    assert.equal(seen!.inputs[0]!.content, '+ added line');
  });
});

test('cli: empty diff → error', async () => {
  await withTmpDir(async (dir) => {
    const cap = captureLogs();
    try {
      await assert.rejects(
        executeSecondOpinion(makeOpts(dir, { diff: 'HEAD', gitDiff: () => ({ ok: true, diff: '' }) })),
        /no changes/i,
      );
    } finally {
      cap.restore();
    }
  });
});

test('cli: git failure (not a repo) → error', async () => {
  await withTmpDir(async (dir) => {
    const cap = captureLogs();
    try {
      await assert.rejects(
        executeSecondOpinion(
          makeOpts(dir, { diff: 'HEAD', gitDiff: () => ({ ok: false, message: 'not a git repository' }) }),
        ),
        /not a git repository/,
      );
    } finally {
      cap.restore();
    }
  });
});

test('cli: --json success emits the full envelope on stdout', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'x');
    const cap = captureLogs();
    let code: number;
    try {
      code = await executeSecondOpinion(makeOpts(dir, { files: ['a.md'], json: true }));
    } finally {
      cap.restore();
    }
    assert.equal(code, 0);
    const parsed = JSON.parse(cap.logs.join('\n')) as Record<string, unknown>;
    assert.equal(parsed['ok'], true);
    assert.equal(parsed['host'], 'codex');
    assert.equal(parsed['structured'], true);
    assert.equal((parsed['findings'] as unknown[]).length, 2);
  });
});

test('cli: --json failure envelope carries code + failures, exit 1', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'x');
    const cap = captureLogs();
    let code: number;
    try {
      code = await executeSecondOpinion(
        makeOpts(dir, {
          files: ['a.md'],
          json: true,
          runFn: async () => ({
            ok: false,
            code: 'HOST_NOT_SUBSCRIPTION',
            host: 'claude',
            message: 'refused',
            failures: [{ check: 'env_anthropic_api_key', actual: 'exported', expected: 'unset', remedy: 'unset it' }],
          }),
        }),
      );
    } finally {
      cap.restore();
    }
    assert.equal(code, 1);
    const parsed = JSON.parse(cap.logs.join('\n')) as Record<string, unknown>;
    assert.equal(parsed['ok'], false);
    assert.equal(parsed['code'], 'HOST_NOT_SUBSCRIPTION');
    assert.equal((parsed['failures'] as unknown[]).length, 1);
  });
});

test('cli: human render groups findings by severity and shows summary', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'x');
    const cap = captureLogs();
    try {
      await executeSecondOpinion(makeOpts(dir, { files: ['a.md'] }));
    } finally {
      cap.restore();
    }
    const out = cap.logs.join('\n');
    assert.match(out, /Strong draft; intro drags\./);
    assert.match(out, /major/i);
    assert.match(out, /praise/i);
    assert.match(out, /Intro buries the lede/);
    assert.match(out, /para 1/);
  });
});

test('cli: human render of unstructured result prints raw with a note', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'x');
    const cap = captureLogs();
    try {
      await executeSecondOpinion(
        makeOpts(dir, {
          files: ['a.md'],
          runFn: async () => ({
            ok: true,
            result: { summary: '', findings: [], raw: 'plain prose review', host: 'gemini', structured: false },
          }),
        }),
      );
    } finally {
      cap.restore();
    }
    const out = cap.logs.join('\n');
    assert.match(out, /plain prose review/);
    assert.match(out, /unstructured/i);
  });
});

test('cli: human failure prints failures with remedies, exit 1', async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, 'a.md'), 'x');
    const cap = captureLogs();
    let code: number;
    try {
      code = await executeSecondOpinion(
        makeOpts(dir, {
          files: ['a.md'],
          runFn: async () => ({
            ok: false,
            code: 'HOST_NOT_SUBSCRIPTION',
            host: 'claude',
            message: 'claude failed the subscription preflight',
            failures: [{ check: 'env_anthropic_api_key', actual: 'exported', expected: 'unset', remedy: 'Unset ANTHROPIC_API_KEY' }],
          }),
        }),
      );
    } finally {
      cap.restore();
    }
    assert.equal(code, 1);
    const err = cap.errors.join('\n');
    assert.match(err, /subscription preflight/);
    assert.match(err, /Unset ANTHROPIC_API_KEY/);
  });
});

test('cli: --json input-gathering failures emit the {ok:false,code} envelope (round-6 fix)', async () => {
  await withTmpDir(async (dir) => {
    const cases: Array<{ opts: Partial<ExecuteSecondOpinionOpts>; code: string }> = [
      { opts: { files: ['missing.md'] }, code: 'FILE_READ' },
      { opts: { stdin: true, readStdin: async () => '' }, code: 'NO_STDIN' },
      { opts: { diff: 'HEAD', gitDiff: () => ({ ok: false, message: 'not a git repository' }) }, code: 'GIT_DIFF_FAILED' },
      { opts: { diff: 'HEAD', gitDiff: () => ({ ok: true, diff: '' }) }, code: 'EMPTY_DIFF' },
    ];
    for (const c of cases) {
      const cap = captureLogs();
      let code: number;
      try {
        code = await executeSecondOpinion(makeOpts(dir, { ...c.opts, json: true }));
      } finally {
        cap.restore();
      }
      assert.equal(code, 1, c.code);
      const parsed = JSON.parse(cap.logs.join('\n')) as Record<string, unknown>;
      assert.equal(parsed['ok'], false, c.code);
      assert.equal(parsed['code'], c.code);
      assert.ok(String(parsed['message']).length > 0, c.code);
    }
  });
});
