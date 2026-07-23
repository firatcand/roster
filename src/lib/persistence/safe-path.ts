import { RosterError, EXIT_ERROR } from '../errors.ts';

// A single object-store key / display path segment: alnum start, then alnum/
// dot/dash/underscore, max 128. No '/' (would break the key layout) and no
// '..' (traversal). Applied to every caller-supplied segment before it touches
// a key or filesystem path.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeSegment(label: string, value: string): void {
  if (value.length === 0 || value.length > 128 || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new RosterError({
      header: `Invalid ${label}`,
      body: `'${value}' is not a valid ${label}. Use letters, digits, '.', '-', '_' (max 128, no '/' or '..').`,
      remedy: `Rename it and retry.`,
      exitCode: EXIT_ERROR,
    });
  }
}
