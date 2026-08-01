import { EXIT_ERROR, RosterError } from './errors.ts';

export const WORKSPACE_DIAGNOSTIC_CODES = [
  'WORKSPACE_NOT_FOUND',
  'LEGACY_WORKSPACE',
  'MIXED_WORKSPACE',
  'UNSAFE_WORKSPACE_MARKER',
  'IDENTITY_INVALID',
  'IDENTITY_AMBIGUOUS',
  'PARENT_NOT_FOUND',
  'DUPLICATE_IDENTITY',
  'PATH_ESCAPE',
  'PATH_OVERLAP',
  'RESERVED_PATH',
  'SYMLINK_COMPONENT',
  'NOT_REGULAR_FILE',
  'READ_LIMIT_EXCEEDED',
  'SCHEMA_VERSION_UNSUPPORTED',
  'UNKNOWN_FIELD',
  'IDENTITY_PATH_MISMATCH',
  'GENERATED_FILE_EDITED',
  'ATOMIC_PUBLICATION_UNSUPPORTED',
  'FILESYSTEM_WRITE_FAILED',
  'WORKSPACE_BUSY',
  'UNREGISTERED_RECORD',
  'YAML_INVALID',
  'WRITE_CONFLICT',
  'PLAN_DRAFT_INCOMPLETE',
  'PLAN_SCHEMA_INVALID',
  'PLAN_FIELD_FORBIDDEN',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_APPLICABLE',
  'REFERENCE_CYCLE',
] as const;

export type WorkspaceDiagnosticCode = (typeof WORKSPACE_DIAGNOSTIC_CODES)[number];

const WORKSPACE_DIAGNOSTIC_CODE_SET: ReadonlySet<string> = new Set(WORKSPACE_DIAGNOSTIC_CODES);

export type WorkspaceDiagnosticSeverity = 'error' | 'warning' | 'info';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WorkspaceDiagnostic = {
  code: WorkspaceDiagnosticCode;
  severity: WorkspaceDiagnosticSeverity;
  message: string;
  path?: string;
  remedy?: string;
  details: Record<string, JsonValue>;
};

export function workspaceDiagnostic(
  code: WorkspaceDiagnosticCode,
  message: string,
  options: {
    severity?: WorkspaceDiagnosticSeverity;
    path?: string;
    remedy?: string;
    details?: Record<string, JsonValue>;
  } = {},
): WorkspaceDiagnostic {
  return {
    code,
    severity: options.severity ?? 'error',
    message,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.remedy === undefined ? {} : { remedy: options.remedy }),
    details: options.details ?? {},
  };
}

export type WorkspaceRosterError = RosterError & {
  readonly code: WorkspaceDiagnosticCode;
  readonly details: Record<string, JsonValue>;
};

export function workspaceFailure(
  code: WorkspaceDiagnosticCode,
  message: string,
  remedy: string,
  details: Record<string, JsonValue> = {},
): WorkspaceRosterError {
  const error = new RosterError({
    header: `roster: ${message}`,
    body: '',
    remedy,
    exitCode: EXIT_ERROR,
    code,
    details,
  }) as WorkspaceRosterError;
  return error;
}

export function isWorkspaceFailure(error: unknown): error is WorkspaceRosterError {
  return error instanceof RosterError && WORKSPACE_DIAGNOSTIC_CODE_SET.has(error.code);
}

export function diagnosticFromFailure(error: WorkspaceRosterError): WorkspaceDiagnostic {
  const path = typeof error.details['path'] === 'string' ? error.details['path'] : undefined;
  return workspaceDiagnostic(error.code, error.header.replace(/^roster:\s*/, ''), {
    remedy: error.remedy,
    ...(path === undefined ? {} : { path }),
    details: error.details,
  });
}

export function jsonFailureEnvelope(error: WorkspaceRosterError): {
  ok: false;
  code: WorkspaceDiagnosticCode;
  message: string;
  remedy: string;
  details: Record<string, JsonValue>;
} {
  return {
    ok: false,
    code: error.code,
    message: error.header.replace(/^roster:\s*/, ''),
    remedy: error.remedy,
    details: error.details,
  };
}
