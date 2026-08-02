import { workspaceFailure } from '../workspace-diagnostics.ts';

declare const CANONICAL_SKILL_REF: unique symbol;

export type CanonicalSkillRef = string & {
  readonly [CANONICAL_SKILL_REF]: true;
};

export type SkillRefValidationOptions = {
  allowRosterPackage?: boolean;
  path?: string;
};

const COMPONENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isCanonicalSkillRef(
  value: unknown,
  options: SkillRefValidationOptions = {},
): value is CanonicalSkillRef {
  if (typeof value !== 'string' || value.length > 127) return false;
  const separator = value.indexOf(':');
  if (separator < 1 || separator !== value.lastIndexOf(':')) return false;
  const packageName = value.slice(0, separator);
  const skillName = value.slice(separator + 1);
  if (packageName.length > 63 || skillName.length < 1 || skillName.length > 63) return false;
  if (!COMPONENT_RE.test(packageName) || !COMPONENT_RE.test(skillName)) return false;
  return options.allowRosterPackage === true || packageName !== 'roster';
}

export function parseSkillRef(
  value: unknown,
  options: SkillRefValidationOptions = {},
): CanonicalSkillRef {
  if (isCanonicalSkillRef(value, options)) return value;
  throw workspaceFailure(
    'SKILL_REF_INVALID',
    'A skill_ref is not a canonical package:skill identity.',
    'Use two lowercase kebab-case components of at most 63 characters separated by one colon; the roster package is reserved for shipped built-ins.',
    {
      ...(options.path === undefined ? {} : { path: options.path }),
      reason: 'canonical-identity-required',
    },
  );
}
