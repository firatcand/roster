import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// The workspace containment boundary. Lives in its own leaf module (node
// builtins only) so every walker over the workspace tree — pending, schedules,
// state.md, the cron evidence channel, the local ops ledger — can share ONE
// definition without an import cycle.

// ── the absolute-path invariant (round-13 finding 1) ─────────────────────────
//
// Confinement used to accept a RELATIVE boundary and resolve a RELATIVE target
// beneath it. Callers build their targets as `join(cwd, …)`, so with process cwd
// `/parent` and `--cwd repo` the already-prefixed target `repo/roster/…` was
// re-prefixed into `/parent/repo/repo/roster/…`: confinement inspected a phantom
// path while every caller afterwards opened `/parent/repo/roster/…`. `run list`
// reported no runs, `run start` saw meta.json as ABSENT and replaced the tree's
// producer identity, and a symlinked component on the REAL path was never walked
// at all — the round-12 class fix silently bypassed.
//
// So the boundary AND the target are absolute here, by contract. Every `--cwd`
// parse site normalizes with resolve() and this module REFUSES a relative input
// rather than resolving it a second time — double-prefixing is now a loud
// programming error instead of a different, unchecked path. The one legitimate
// caller-authored RELATIVE input (pending front-matter `target_on_approve`) goes
// through resolveWorkspaceRelativePath below, where the re-prefixing is the
// documented intent.
export function assertAbsolutePath(role: string, value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(
      `workspace confinement requires an absolute ${role} (got '${String(value)}') — normalize it with path.resolve() at the --cwd boundary`,
    );
  }
  return resolve(value);
}

export function workspaceRelative(absPath: string, cwd: string): string {
  const rel = relative(assertAbsolutePath('workspace root', cwd), assertAbsolutePath('path', absPath));
  return rel === '' ? '.' : rel;
}

// ── the class primitive: component-wise, no-follow confinement ────────────────
//
// Rounds 10, 11 and 12 each produced a finding of the SAME class because the
// read-side boundary was REALPATH CONTAINMENT: resolve the target's whole
// symlink chain, accept it if the result lands under the workspace's real path.
// By construction that ACCEPTS a symlinked ancestor (or final component) whose
// target happens to stay inside — so an agent-planted
// `roster/gtm/pending/acknowledged -> <ws>/archive/acks` classified a REAL
// failed fire as acknowledged and suppressed it, and `roster/ops -> gtm`
// aliased two registry identities onto one directory (`schedule install
// ops/sdr` rewriting `gtm/schedules.yaml`).
//
// The rule is now the one ensureOwnedDir has always enforced on the WRITE side:
// walk EVERY path component strictly below the trusted root with lstat and
// refuse ANY symlink component REGARDLESS of where it points. "The target stays
// inside the workspace, so it is fine" is no longer an accept-path anywhere.
//
// Read-only on purpose: unlike ensureOwnedDir (the WRITE-side boundary) this
// creates no directory and repairs no mode, so inspecting or scanning a
// workspace never mutates it.

export type ConfinementFs = {
  lstatSync: (path: string) => Stats;
  realpathSync: (path: string) => string;
};

export const realConfinementFs: ConfinementFs = { lstatSync, realpathSync };

export type ConfinementRefusal =
  // Lexically outside (absolute elsewhere, `..`, or the root itself), or the
  // realpath belt caught a resolution the component walk could not see.
  | 'outside-boundary'
  // A path component strictly below the root is a symbolic link. Where it
  // points is deliberately NOT consulted.
  | 'symlink-component'
  // A component could not be lstat'd for a reason other than "absent".
  | 'unreadable-component';

export type ConfinedPath =
  | { status: 'ok'; path: string; stat: Stats }
  | { status: 'absent'; path: string }
  | { status: 'refused'; reason: ConfinementRefusal; at: string };

// Lexical decomposition: every path component strictly below `boundary`, from
// outermost to the target itself. `null` when the target is not strictly below
// (equal to the root, an ancestor, or absolute elsewhere). Shared with the
// ledger's write-side walker so both sides split paths identically.
export function pathComponentsBelow(boundary: string, path: string): string[] | null {
  const rel = relative(boundary, path);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return null;
  }
  const out: string[] = [];
  let cur = boundary;
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    out.push(cur);
  }
  return out;
}

type WalkOutcome =
  | { status: 'ok'; stat: Stats; deepest: string }
  | { status: 'absent'; deepest: string }
  | { status: 'refused'; reason: ConfinementRefusal; at: string };

function walkComponents(root: string, parts: readonly string[], fs: ConfinementFs): WalkOutcome {
  let deepest = root;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    let st: Stats;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Absent (or a non-directory ancestor, which POSIX reports as ENOTDIR):
      // nothing below exists, and nothing symlinked was traversed to learn it.
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent', deepest };
      return { status: 'refused', reason: 'unreadable-component', at: p };
    }
    if (st.isSymbolicLink()) return { status: 'refused', reason: 'symlink-component', at: p };
    deepest = p;
    if (i === parts.length - 1) return { status: 'ok', stat: st, deepest };
    if (!st.isDirectory()) return { status: 'absent', deepest };
  }
  return { status: 'absent', deepest };
}

// Belt over the component walk: with no symlink component below the root the
// resolved path is contained by construction, so this only fires where lstat
// cannot see the redirection (platform reparse-point quirks) — it is an extra
// REFUSAL, never an accept-path.
function beltRefusal(root: string, deepest: string, fs: ConfinementFs): ConfinedPath | null {
  let realRoot: string;
  let realDeep: string;
  try {
    realRoot = fs.realpathSync(root);
    realDeep = fs.realpathSync(deepest);
  } catch {
    return { status: 'refused', reason: 'unreadable-component', at: deepest };
  }
  if (realDeep !== realRoot && !realDeep.startsWith(realRoot + sep)) {
    return { status: 'refused', reason: 'outside-boundary', at: deepest };
  }
  return null;
}

// THE primitive. Every confinement helper below routes through it. Both inputs
// are absolute by contract (see assertAbsolutePath) so the path this walks is
// always the path the caller will afterwards open.
export function resolveConfinedPath(
  target: string,
  boundary: string,
  fs: ConfinementFs = realConfinementFs,
): ConfinedPath {
  const root = assertAbsolutePath('boundary', boundary);
  const abs = assertAbsolutePath('target path', target);
  const parts = pathComponentsBelow(root, abs);
  if (parts === null) return { status: 'refused', reason: 'outside-boundary', at: abs };
  const walked = walkComponents(root, parts, fs);
  if (walked.status === 'refused') return walked;
  const belt = beltRefusal(root, walked.deepest, fs);
  if (belt !== null) return belt;
  return walked.status === 'ok'
    ? { status: 'ok', path: abs, stat: walked.stat }
    : { status: 'absent', path: abs };
}

// Ancestor-only flavor for readers that own their final component through
// O_NOFOLLOW (the hardened evidence reader): the file itself may legitimately
// be refused with the reader's own precise taxonomy ('not-a-regular-file'), but
// no DIRECTORY between the boundary and it may be a symlink.
export function ancestorsConfined(
  target: string,
  boundary: string,
  fs: ConfinementFs = realConfinementFs,
): boolean {
  const root = assertAbsolutePath('boundary', boundary);
  const abs = assertAbsolutePath('target path', target);
  const parts = pathComponentsBelow(root, abs);
  if (parts === null) return false;
  const ancestors = parts.slice(0, -1);
  const walked = walkComponents(root, ancestors, fs);
  if (walked.status === 'refused') return false;
  return beltRefusal(root, walked.deepest, fs) === null;
}

// The ONE entry point that accepts a caller-AUTHORED workspace-relative target:
// the pending item's `target_on_approve` front-matter field, which is written
// relative to the workspace by whoever produced the item. Resolution against the
// root is the documented intent HERE, which is exactly why the primitive above
// refuses a relative target everywhere else.
export function resolveWorkspaceRelativePath(
  target: string,
  boundary: string,
  fs: ConfinementFs = realConfinementFs,
): ConfinedPath {
  const root = assertAbsolutePath('boundary', boundary);
  return resolveConfinedPath(isAbsolute(target) ? resolve(target) : resolve(root, target), root, fs);
}

// Reject a target that resolves to the workspace root, an ancestor, anywhere
// outside the workspace, or through ANY symlinked component below the
// workspace. Returns the absolute path for an accepted target — which may not
// exist yet, so the write paths (`schedule install` creating roster/<fn>/, the
// approve destination) can use the same boundary as the read paths.
export function targetWithinWorkspace(target: string, cwd: string): string | null {
  const res = resolveConfinedPath(target, cwd);
  return res.status === 'refused' ? null : res.path;
}

// Directory form, for the READ walkers over the workspace tree (`roster/<fn>/…`,
// `logs/cron/<fn>/…`). Returns null for a refused, missing, or non-directory
// path — the caller keeps its own contract (skip-and-report vs. actionable
// error).
export function confinedWorkspaceDir(path: string, cwd: string): string | null {
  const res = resolveConfinedPath(path, cwd);
  return res.status === 'ok' && res.stat.isDirectory() ? res.path : null;
}

// ── the roster registry boundary (round-11 finding 1) ────────────────────────
//
// A function name is a DIRECTORY name under roster/, so `--function` and the
// `<function>/<agent>` positional are caller-supplied PATH SEGMENTS. Round 10
// confined every resolved path to the WORKSPACE, which `../archive` satisfies
// while leaving the registry tree entirely: with a valid
// <workspace>/archive/schedules.yaml, `roster schedule remove nightly
// --function ../archive --yes` resolved to and REWROTE that archive, and
// status/run consumed it as a registry. Two layers close it — ONE strict
// validator wherever a function name is ACCEPTED, and a resolved-path boundary
// of <workspace>/roster/ rather than merely <workspace>.
const FUNCTION_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_FUNCTION_NAME_LENGTH = 64;

export function isFunctionName(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FUNCTION_NAME_LENGTH &&
    FUNCTION_NAME_RE.test(value)
  );
}

// Shared refusal phrasing for the ARGUMENT boundary, where a parser owes a
// plain message rather than a RosterError.
export function invalidFunctionNameMessage(value: string): string {
  return `invalid function name '${value}' — must be kebab-case (lowercase letters, digits, single hyphens), max ${MAX_FUNCTION_NAME_LENGTH} chars`;
}

export function rosterDirOf(cwd: string): string {
  return join(assertAbsolutePath('workspace root', cwd), 'roster');
}

// READ boundary: the function dir must exist AND be a real directory reached
// without traversing a symlink. Round-12 finding 3: realpath containment
// accepted a WITHIN-roster alias (`roster/ops -> gtm`), so `ops` and `gtm`
// named one registry while the CLI minted ops-qualified state, prompts and cron
// identity around it. The component walk refuses the link outright.
export function confinedFunctionDir(cwd: string, functionName: string): string | null {
  if (!isFunctionName(functionName)) return null;
  const res = resolveFunctionDir(cwd, functionName);
  return res !== null && res.status === 'ok' && res.stat.isDirectory() ? res.path : null;
}

// The raw verdict, so a skip-with-report caller can phrase WHY it refused.
export function resolveFunctionDir(cwd: string, functionName: string): ConfinedPath | null {
  const root = assertAbsolutePath('workspace root', cwd);
  if (!isFunctionName(functionName)) return null;
  return resolveConfinedPath(join(rosterDirOf(root), functionName), root);
}

// WRITE boundary: `schedule install` creates roster/<fn>/ on first use, so the
// directory need not exist yet — but every component that DOES exist between
// the workspace and it must be a real directory.
export function functionDirWithinRoster(cwd: string, functionName: string): string | null {
  const res = resolveFunctionDir(cwd, functionName);
  if (res === null || res.status === 'refused') return null;
  return res.path;
}

// ── confined existence probes (round-11 finding 2) ───────────────────────────
//
// `existsSync` FOLLOWS symlinks and knows no boundary, so an agent-planted
// `roster/gtm/pending/acknowledged -> /tmp/foreign-acks` holding a matching
// sentinel made pending-sync classify a failed fire as acknowledged and
// suppress its decision item — a real failure vanishing from the inbox — and a
// symlinked pending destination produced a wrong already-exists verdict.
// Round-12 finding 1: the same suppression worked with an IN-WORKSPACE link
// (`-> <ws>/archive/acks`) until the probe stopped consulting link targets.
// TRI-STATE so a caller can tell "nothing here" from "something here I refuse
// to trust".
export type ConfinedProbe = 'absent' | 'present' | 'refused';

export function confinedProbeSync(
  path: string,
  boundary: string,
  fs: ConfinementFs = realConfinementFs,
): ConfinedProbe {
  const res = resolveConfinedPath(path, boundary, fs);
  if (res.status === 'refused') return 'refused';
  if (res.status === 'absent') return 'absent';
  // lstat, so a symlink is never a regular file here — the no-follow half.
  return res.stat.isFile() ? 'present' : 'refused';
}
