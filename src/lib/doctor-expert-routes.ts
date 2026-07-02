import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { founderManifestSchema, normalizeManifest } from './founder-skills/manifest-schema.ts';
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
      warnings.push({
        file: `${entry.name}/EXPERT.md`,
        route,
        message: `${entry.name}/EXPERT.md routes to '${route}' — not covered by founder-skills.yaml; \`roster skills sync\` installs nothing for it`,
      });
    }
  }

  return { status: 'checked', warnings };
}
