import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostAdapterCapabilityStatus } from './generated-artifacts.ts';
import { toolForScope } from './install-scope.ts';
import { getToolByKey } from './tools.ts';
import { confinedProbeSync } from './workspace-path.ts';

export type DreamerActivationHost = 'claude' | 'codex';

export type DreamerActivationVerdict =
  | 'blocked'
  | 'inactive'
  | 'files-only'
  | 'drifted'
  | 'files-missing'
  | 'static-coherent';

export type DreamerActivationHostReport = Readonly<{
  activation: HostAdapterCapabilityStatus;
  skill_files: 'present' | 'absent';
}>;

export type DreamerActivationInputs = Readonly<{
  brain: 'absent' | 'partial' | 'declared';
  structural_ok: boolean;
  instructions: 'missing' | 'drifted' | 'current';
  hosts: Readonly<Partial<Record<DreamerActivationHost, DreamerActivationHostReport>>>;
}>;

export type DreamerActivationReport = DreamerActivationInputs & Readonly<{
  verdict: DreamerActivationVerdict;
  runtime_verified: false;
  detail: string;
}>;

// This audit reads tracked and generated FILES. It never opens the Brain, never
// launches a host, and therefore never observes a host actually reflecting --
// which is why the verdict vocabulary describes file coherence and the report
// says so in its own words.
const DETAIL = 'Static file audit only: run roster brain doctor for schema, the dream broker grants,'
  + ' and lesson drift, and read the workspace fixtures and host certification for whether a host'
  + ' actually records evidence, checks readiness, and presents a candidate.';

// First match wins. Every workspace state reaches exactly one row, so two
// verdicts can never both be true and no state falls through unnamed.
export function deriveDreamerActivation(inputs: DreamerActivationInputs): DreamerActivationReport {
  const hosts = Object.values(inputs.hosts).filter((host): host is DreamerActivationHostReport =>
    host !== undefined);
  const base = { ...inputs, runtime_verified: false as const, detail: DETAIL };
  // The two blocking states come first because both of them ALSO empty the host
  // set -- a half-declared brain and a broken registry are the same parse
  // failure -- and answering `inactive` there would report "no host is enabled"
  // for a workspace whose host declarations simply could not be read.
  if (inputs.brain === 'partial') return { ...base, verdict: 'blocked' };
  if (!inputs.structural_ok) return { ...base, verdict: 'blocked' };
  // Then the empty host set, before any quantifier: over no hosts "some host is
  // broken" is false and "every host is fine" is true, so a workspace that
  // enables no host would otherwise report itself coherent.
  if (hosts.length === 0) return { ...base, verdict: 'inactive' };
  const nothingActivates = inputs.instructions === 'missing'
    || hosts.some((host) => host.activation === 'missing');
  if (nothingActivates) {
    return hosts.some((host) => host.skill_files === 'present')
      ? { ...base, verdict: 'files-only' }
      : { ...base, verdict: 'inactive' };
  }
  if (inputs.instructions === 'drifted' || hosts.some((host) => host.activation === 'drifted')) {
    return { ...base, verdict: 'drifted' };
  }
  if (hosts.some((host) => host.skill_files === 'absent')) {
    return { ...base, verdict: 'files-missing' };
  }
  return { ...base, verdict: 'static-coherent' };
}

// A skill is effective for a host when it loads from EITHER scope, so both are
// probed and either one counts. The project probe is confined -- a symlinked
// `.claude/skills` must not let a foreign tree answer for this workspace --
// while the user scope is the caller's own home configuration and is read as
// the host itself would read it.
export function probeDreamerSkillFiles(cwd: string, host: DreamerActivationHost): 'present' | 'absent' {
  const tool = getToolByKey(host);
  if (tool === undefined) return 'absent';
  const project = join(toolForScope(tool, 'project', cwd).skillsTarget, 'dreamer', 'SKILL.md');
  if (confinedProbeSync(project, cwd) === 'present') return 'present';
  return existsSync(join(tool.skillsTarget, 'dreamer', 'SKILL.md')) ? 'present' : 'absent';
}

export function renderDreamerActivationLines(report: DreamerActivationReport): string[] {
  return [
    `  dreamer activation: ${report.verdict}`,
    `    ${DETAIL}`,
  ];
}
