import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  founderManifestSchema,
  isSafeSkillName,
  normalizeManifest,
} from './founder-skills/manifest-schema.ts';
import { manifestPath } from './founder-skills/sync.ts';
import { BUILTIN_SKILL_EXCEPTIONS, parseExpertRoutes } from './founder-skills/expert-routes.ts';

export type ExpertRouteWarning = {
  file: string;
  route: string;
  message: string;
};

export type ExpertRoutesAuditResult =
  | { status: 'not-applicable'; reason: 'no-manifest' | 'invalid-manifest' }
  | { status: 'checked'; warnings: ExpertRouteWarning[] };

const MAX_ROUTE_DISPLAY = 60;

// Route text comes from a workspace-authored (possibly copied-in) EXPERT.md,
// so it is untrusted terminal/JSON output. Kebab-safe names pass through
// verbatim; anything else gets control chars (incl. ANSI escapes, newlines)
// hex-escaped and is truncated. Warnings carry ONLY the sanitized form — both
// the doctor text render and the --json payload.
export function sanitizeRouteForDisplay(route: string): string {
  // Widened local: isSafeSkillName is a type guard, and guarding `route`
  // directly would narrow it to `never` in the fall-through branch.
  const candidate: unknown = route;
  if (isSafeSkillName(candidate)) return route;
  let out = '';
  for (const ch of route) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : ch;
  }
  return out.length > MAX_ROUTE_DISPLAY ? `${out.slice(0, MAX_ROUTE_DISPLAY)}…` : out;
}

// Warning-ONLY by owner decision (ROS-129) — unlike auditFounderSkillsDrift
// this never feeds doctor's exit-code aggregate: a user may intentionally trim
// the manifest below what the hand-authored EXPERT.md tables route to. An
// invalid manifest is drift.ts's fail-loud problem; here it degrades to
// not-applicable so the error is reported exactly once. Never touches the
// network — workspace-local cross-reference only.
export function auditExpertRoutes(cwd: string): ExpertRoutesAuditResult {
  if (!existsSync(manifestPath(cwd))) {
    return { status: 'not-applicable', reason: 'no-manifest' };
  }

  let declared: Set<string>;
  try {
    const raw = parseYaml(readFileSync(manifestPath(cwd), 'utf8')) as unknown;
    declared = new Set(
      normalizeManifest(founderManifestSchema.parse(raw ?? {})).skills.map((s) => s.name),
    );
  } catch {
    return { status: 'not-applicable', reason: 'invalid-manifest' };
  }

  const covered = new Set([...declared, ...BUILTIN_SKILL_EXCEPTIONS]);
  const warnings: ExpertRouteWarning[] = [];

  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return { status: 'checked', warnings };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const file = join(cwd, entry.name, 'EXPERT.md');
    if (!existsSync(file)) continue;
    let markdown: string;
    try {
      markdown = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const route of parseExpertRoutes(markdown)) {
      if (covered.has(route)) continue;
      const safeRoute = sanitizeRouteForDisplay(route);
      warnings.push({
        file: `${entry.name}/EXPERT.md`,
        route: safeRoute,
        message: `${entry.name}/EXPERT.md routes to '${safeRoute}' — not covered by founder-skills.yaml; \`roster skills sync\` installs nothing for it`,
      });
    }
  }

  return { status: 'checked', warnings };
}
