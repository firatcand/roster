import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageJson = { name?: string; version?: string };

// Locate the roster package root regardless of whether this module is
// running from src/lib (dev via tsx) or bundled into bin/roster.js
// (installed via npm). package.json sits one or two dirs up.
function findRosterRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', '..'), resolve(here, '..'), here];
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as PackageJson;
      if (pkg.name === '@firatcand/roster') return dir;
    } catch {
      continue;
    }
  }
  throw new Error('roster: could not locate package.json');
}

export const ROSTER_ROOT: string = findRosterRoot();

export function getPackageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(ROSTER_ROOT, 'package.json'), 'utf8'),
  ) as PackageJson;
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('roster: package.json has no version field');
  }
  return pkg.version;
}
