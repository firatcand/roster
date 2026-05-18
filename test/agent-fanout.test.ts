import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFanout, DEFAULT_DEPTH_CAP } from '../src/lib/agent-fanout.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'agent-fanout-'));
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

test('walkFanout: missing file → 0 fanout + warning', () => {
  const dir = tmp();
  try {
    const r = walkFanout(join(dir, 'missing.md'));
    assert.equal(r.fanoutCount, 0);
    assert.equal(r.depth, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /agent file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: no ## Subagents section → 0 fanout + warning', () => {
  const dir = tmp();
  try {
    write(dir, 'agent.md', '# Lonely\n\n## Purpose\nA bare agent.\n');
    const r = walkFanout(join(dir, 'agent.md'));
    assert.equal(r.fanoutCount, 0);
    assert.equal(r.depth, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /no '## Subagents' section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: flat agent with 3 subagents → fanout 3, depth 1', () => {
  const dir = tmp();
  try {
    write(
      dir,
      'agent.md',
      '# Root\n\n## Subagents\n\n- `a.md` — first\n- `b.md` — second\n- `c.md` — third\n',
    );
    write(dir, 'a.md', '# A\n');
    write(dir, 'b.md', '# B\n');
    write(dir, 'c.md', '# C\n');
    const r = walkFanout(join(dir, 'agent.md'));
    assert.equal(r.fanoutCount, 3);
    assert.equal(r.depth, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: nested tree → recurses and reports depth', () => {
  const dir = tmp();
  try {
    write(
      dir,
      'agent.md',
      '# Root\n\n## Subagents\n\n- `a.md` — first child\n- `b.md` — second child\n',
    );
    write(
      dir,
      'a.md',
      '# A\n\n## Subagents\n\n- `a1.md` — grandchild 1\n- `a2.md` — grandchild 2\n',
    );
    write(dir, 'b.md', '# B\n');
    write(dir, 'a1.md', '# A1\n');
    write(dir, 'a2.md', '# A2\n');
    const r = walkFanout(join(dir, 'agent.md'));
    // a + b + a1 + a2 = 4 distinct subagent files reached from root.
    assert.equal(r.fanoutCount, 4);
    assert.equal(r.depth, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: cyclic graph → cycle detected at back-edge, all preceding edges counted', () => {
  const dir = tmp();
  try {
    write(dir, 'agent.md', '# Root\n\n## Subagents\n\n- `a.md` — first\n');
    write(dir, 'a.md', '# A\n\n## Subagents\n\n- `b.md` — back-edge attempt\n');
    write(dir, 'b.md', '# B\n\n## Subagents\n\n- `a.md` — cycle\n');
    const r = walkFanout(join(dir, 'agent.md'));
    // 3 edges traversed before the cycle short-circuits: root→a, a→b, b→a.
    assert.equal(r.fanoutCount, 3);
    assert.ok(r.warnings.some((w) => /cycle detected/.test(w)), `expected cycle warning, got: ${r.warnings.join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: subagent file missing → counted but not recursed, with warning', () => {
  const dir = tmp();
  try {
    write(dir, 'agent.md', '# Root\n\n## Subagents\n\n- `ghost.md` — never created\n');
    const r = walkFanout(join(dir, 'agent.md'));
    // Edge from root→ghost is counted even though ghost.md doesn't exist on disk.
    assert.equal(r.fanoutCount, 1);
    assert.equal(r.depth, 1);
    assert.ok(r.warnings.some((w) => /'ghost\.md' not found/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: diamond graph → shared subagent counted once per invocation, no cycle warning', () => {
  const dir = tmp();
  try {
    write(dir, 'agent.md', '# Root\n\n## Subagents\n\n- `a.md`\n- `b.md`\n');
    write(dir, 'a.md', '# A\n\n## Subagents\n\n- `critic.md`\n');
    write(dir, 'b.md', '# B\n\n## Subagents\n\n- `critic.md`\n');
    write(dir, 'critic.md', '# C\n');
    const r = walkFanout(join(dir, 'agent.md'));
    // 4 edges: root→a, root→b, a→critic, b→critic.
    assert.equal(r.fanoutCount, 4);
    assert.equal(
      r.warnings.filter((w) => /cycle detected/.test(w)).length,
      0,
      `diamond should NOT trigger cycle warning, got: ${r.warnings.join(' | ')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: depth cap respected', () => {
  const dir = tmp();
  try {
    // Chain root → a → b → c → d → e; cap at 2 should stop after a/b.
    write(dir, 'agent.md', '# Root\n\n## Subagents\n\n- `a.md`\n');
    write(dir, 'a.md', '# A\n\n## Subagents\n\n- `b.md`\n');
    write(dir, 'b.md', '# B\n\n## Subagents\n\n- `c.md`\n');
    write(dir, 'c.md', '# C\n');
    const r = walkFanout(join(dir, 'agent.md'), 2);
    // root visited (depth 0), a visited (depth 1), b NOT recursed (depth 2 >= cap).
    // But b is still listed under a, so depth records 2 (the listing depth).
    assert.ok(r.warnings.some((w) => /depth >= 2/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: default cap is 4', () => {
  assert.equal(DEFAULT_DEPTH_CAP, 4);
});

test('walkFanout: parses both backtick and bare list-item formats', () => {
  const dir = tmp();
  try {
    write(
      dir,
      'agent.md',
      '# Root\n\n## Subagents\n\n- `backticked.md` — one\n- bare.md — two\n* `starred.md` — three\n',
    );
    write(dir, 'backticked.md', '# B\n');
    write(dir, 'bare.md', '# Bare\n');
    write(dir, 'starred.md', '# S\n');
    const r = walkFanout(join(dir, 'agent.md'));
    assert.equal(r.fanoutCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('walkFanout: stops at next H2 heading', () => {
  const dir = tmp();
  try {
    write(
      dir,
      'agent.md',
      '# Root\n\n## Subagents\n\n- `a.md` — first\n\n## Tools\n\n- `not-a-subagent.md` — should be ignored\n',
    );
    write(dir, 'a.md', '# A\n');
    const r = walkFanout(join(dir, 'agent.md'));
    assert.equal(r.fanoutCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
