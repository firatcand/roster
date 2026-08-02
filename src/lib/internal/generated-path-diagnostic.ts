import {
  isWorkspaceFailure,
  workspaceDiagnostic,
  type JsonValue,
  type WorkspaceDiagnostic,
  type WorkspaceDiagnosticCode,
} from '../workspace-diagnostics.ts';

function sanitizedFailureToken(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 96
    && /^[a-zA-Z0-9][a-zA-Z0-9 .:_-]*$/.test(value)
    ? value
    : null;
}

function sanitizedPathFailureDetails(
  details: Readonly<Record<string, JsonValue>>,
  path: string,
): Record<string, JsonValue> {
  const sanitized: Record<string, JsonValue> = { path };
  for (const key of ['cause', 'operation'] as const) {
    const value = sanitizedFailureToken(details[key]);
    if (value !== null) sanitized[key] = value;
  }
  for (const key of ['maxBytes', 'size', 'maxEntries', 'entries'] as const) {
    const value = details[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizedPathFailureRecovery(
  code: WorkspaceDiagnosticCode,
  path: string,
): { message: string; remedy: string } {
  switch (code) {
    case 'PARENT_NOT_FOUND':
      return {
        message: `Generated path '${path}' or its parent is missing.`,
        remedy: 'Restore the expected parent directory or generated file, then run roster update.',
      };
    case 'PATH_ESCAPE':
      return {
        message: `Generated path '${path}' failed workspace-confinement validation.`,
        remedy: 'Use only the canonical generated path inside the workspace, without links or traversal, then retry.',
      };
    case 'SYMLINK_COMPONENT':
      return {
        message: `Generated path '${path}' contains or resolves through a symlink.`,
        remedy: 'Replace the link with the expected real workspace directory or regular file, then retry.',
      };
    case 'NOT_REGULAR_FILE':
      return {
        message: `Generated path '${path}' is not the expected regular file or directory.`,
        remedy: 'Replace the conflicting entry with the expected regular file or directory, then retry.',
      };
    case 'READ_LIMIT_EXCEEDED':
      return {
        message: `Generated path '${path}' exceeds its bounded read limit.`,
        remedy: 'Reduce the file to the reported limit, preserve any authored bytes separately, then retry.',
      };
    case 'ATOMIC_PUBLICATION_UNSUPPORTED':
      return {
        message: `The filesystem cannot atomically publish generated path '${path}'.`,
        remedy: 'Move the workspace to a filesystem that supports the required atomic publication and durability operations, then retry.',
      };
    case 'FILESYSTEM_WRITE_FAILED':
      return {
        message: `The filesystem could not durably update generated path '${path}'.`,
        remedy: 'Resolve the reported write cause, such as permissions, capacity, or I/O; preserve existing bytes; then retry.',
      };
    case 'WORKSPACE_BUSY':
      return {
        message: `Generated path '${path}' could not be updated because the workspace is busy.`,
        remedy: 'Wait for the active Roster writer to finish, then retry; inspect a stale lock before removing it.',
      };
    case 'WRITE_CONFLICT':
      return {
        message: `Generated path '${path}' changed during safe inspection or update.`,
        remedy: 'Preserve the concurrent bytes, stop the other writer, re-read the workspace, then retry.',
      };
    case 'YAML_INVALID':
      return {
        message: `Workspace path '${path}' contains invalid YAML.`,
        remedy: 'Repair the YAML syntax while preserving authored data, then retry.',
      };
    case 'SCHEMA_VERSION_UNSUPPORTED':
      return {
        message: `Workspace path '${path}' uses an unsupported schema version.`,
        remedy: 'Use a Roster release that supports this schema or follow the documented migration path.',
      };
    default:
      return {
        message: `Workspace path '${path}' could not be processed safely (${code}).`,
        remedy: `Resolve the reported ${code} condition without following links or discarding authored bytes, then retry.`,
      };
  }
}

export function diagnosticForPathFailure(error: unknown, path: string): WorkspaceDiagnostic {
  if (isWorkspaceFailure(error)) {
    const details = sanitizedPathFailureDetails(error.details, path);
    const cause = sanitizedFailureToken(details['cause']);
    const atomicPrimitiveUnavailable = error.code === 'ATOMIC_PUBLICATION_UNSUPPORTED'
      && !Object.hasOwn(error.details, 'operation');
    if (
      (cause === 'EACCES' || cause === 'EPERM')
      && !atomicPrimitiveUnavailable
    ) {
      return workspaceDiagnostic(
        'FILESYSTEM_ACCESS_FAILED',
        `Generated path '${path}' could not be inspected or updated safely (${cause}).`,
        {
          path,
          remedy: 'Restore safe read and write access to the generated path, then retry.',
          details,
        },
      );
    }
    const recovery = sanitizedPathFailureRecovery(error.code, path);
    return workspaceDiagnostic(error.code, recovery.message, {
      path,
      remedy: recovery.remedy,
      details,
    });
  }
  const rawCause = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
  if (rawCause === null) throw error;
  const cause = sanitizedFailureToken(rawCause) ?? 'unknown';
  return workspaceDiagnostic(
    'FILESYSTEM_ACCESS_FAILED',
    `Generated path '${path}' could not be inspected or updated safely (${cause}).`,
    {
      path,
      remedy: 'Inspect the reported cause, restore safe path components or resolve the underlying I/O failure, then retry.',
      details: { path, cause },
    },
  );
}
