import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanForBannedPrimitives, type BanlistViolation, type ToolAuditResult } from './audit.ts';
import { runCodexPreflight, type PreflightFailure, type PreflightResult } from './codex-preflight.ts';
import type { SubscriptionAttestation } from './schedule-schema.ts';
import type { Tool } from './tools.ts';

// =====================================================================
// Banned-pattern static audit (check 6, second part)
// =====================================================================
//
// Scope (per ROS-38 plan D4 + Codex 2nd-pass review [MAJOR/8]):
//   1. ROSTER_ROOT/{skills,agents,templates,src} — roster-owned source
//   2. Per-tool installed skill DIRS (rooted scan)
//   3. Per-tool installed agent FILES — .md for claude/gemini, .toml +
//      .persona.md sidecar for codex. (Codex review #E: previous version
//      relied on auditTool STALE detection alone, which could leave tampered
//      installed agent files un-scanned for banned primitives. walkAllFiles
//      now accepts file roots so we can include them surgically.)
//
// Out of scope: arbitrary skills/agents under the user's tool config dirs.
// Doctor validates roster's own correctness, not the user's other content.

const ROSTER_SOURCE_SUBDIRS = ['skills', 'agents', 'templates', 'src'] as const;

export function resolveBannedPatternRoots(
  rosterRoot: string,
  toolAudits: ReadonlyArray<ToolAuditResult>,
  detectedTools: ReadonlyArray<Tool>,
): string[] {
  const roots: string[] = [];
  for (const sub of ROSTER_SOURCE_SUBDIRS) {
    const full = join(rosterRoot, sub);
    if (existsSync(full)) roots.push(full);
  }

  // Add roster-installed skill DIRS + agent FILES for each detected tool.
  const toolByKey = new Map(detectedTools.map((t) => [t.key, t]));
  for (const audit of toolAudits) {
    const tool = toolByKey.get(audit.tool);
    if (!tool) continue;
    for (const item of audit.items) {
      if (item.status === 'missing') continue;
      if (item.kind === 'skill') {
        if (existsSync(item.targetPath)) roots.push(item.targetPath);
        continue;
      }
      if (item.kind === 'agent') {
        if (existsSync(item.targetPath)) roots.push(item.targetPath);
        // Codex layout: <name>.toml is the targetPath; <name>.persona.md is
        // the sidecar that holds the agent's prose/persona. Both should be
        // scanned. Derive the sidecar from the targetPath shape.
        if (tool.agentsLayout === 'codex-toml' && item.targetPath.endsWith('.toml')) {
          const personaPath = join(
            dirname(item.targetPath),
            item.targetPath.slice(item.targetPath.lastIndexOf('/') + 1).replace(/\.toml$/, '.persona.md'),
          );
          if (existsSync(personaPath)) roots.push(personaPath);
        }
      }
    }
  }
  return roots;
}

export type BannedPatternsAudit = {
  status: 'ok' | 'fail';
  rootsScanned: string[];
  violations: BanlistViolation[];
};

export function auditBannedPatterns(
  rosterRoot: string,
  toolAudits: ReadonlyArray<ToolAuditResult>,
  detectedTools: ReadonlyArray<Tool>,
): BannedPatternsAudit {
  const roots = resolveBannedPatternRoots(rosterRoot, toolAudits, detectedTools);
  const violations = scanForBannedPrimitives(roots);
  return {
    status: violations.length === 0 ? 'ok' : 'fail',
    rootsScanned: roots,
    violations,
  };
}

// =====================================================================
// Codex preflight wrapper (checks 6 first part, 7, 8, 9, 10)
// =====================================================================

export type CodexPreflightAudit =
  | { status: 'skipped'; reason: 'codex-not-detected' }
  | { status: 'ok'; attestation: SubscriptionAttestation }
  | { status: 'fail'; failures: PreflightFailure[] };

export type CodexPreflightOpts = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  codexDetected: boolean;
};

function fromPreflightResult(result: PreflightResult): Exclude<CodexPreflightAudit, { status: 'skipped' }> {
  if (result.ok) {
    return { status: 'ok', attestation: result.attestation };
  }
  return { status: 'fail', failures: result.failures };
}

export function auditCodexPreflight(opts: CodexPreflightOpts): CodexPreflightAudit {
  if (!opts.codexDetected) {
    return { status: 'skipped', reason: 'codex-not-detected' };
  }
  const result = runCodexPreflight({ homeDir: opts.homeDir, env: opts.env });
  return fromPreflightResult(result);
}

// =====================================================================
// Aggregate
// =====================================================================

export type SafetyAuditResult = {
  ok: boolean;
  bannedPatterns: BannedPatternsAudit;
  codexPreflight: CodexPreflightAudit;
};

export type SafetyAuditOpts = {
  rosterRoot: string;
  toolAudits: ReadonlyArray<ToolAuditResult>;
  detectedTools: ReadonlyArray<Tool>;
  homeDir: string;
  env: NodeJS.ProcessEnv;
};

export function runSafetyAudit(opts: SafetyAuditOpts): SafetyAuditResult {
  const bannedPatterns = auditBannedPatterns(opts.rosterRoot, opts.toolAudits, opts.detectedTools);
  const codexDetected = opts.detectedTools.some((t) => t.key === 'codex');
  const codexPreflight = auditCodexPreflight({
    homeDir: opts.homeDir,
    env: opts.env,
    codexDetected,
  });

  const codexOk = codexPreflight.status === 'ok' || codexPreflight.status === 'skipped';
  const ok = bannedPatterns.status === 'ok' && codexOk;

  return { ok, bannedPatterns, codexPreflight };
}
