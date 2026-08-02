import { workspaceFailure } from '../workspace-diagnostics.ts';
import { withWorkspaceLock } from '../workspace-io.ts';

declare const WORKSPACE_UPDATE_LOCK: unique symbol;

export type WorkspaceUpdateLockToken = {
  readonly [WORKSPACE_UPDATE_LOCK]: true;
};

const TOKENS = new WeakMap<object, string>();

export function withWorkspaceUpdateLock<T>(
  root: string,
  operation: (token: WorkspaceUpdateLockToken) => T,
): T {
  return withWorkspaceLock(root, () => {
    const token = Object.freeze({}) as WorkspaceUpdateLockToken;
    TOKENS.set(token, root);
    try {
      return operation(token);
    } finally {
      TOKENS.delete(token);
    }
  });
}

export function assertWorkspaceUpdateLock(
  root: string,
  token: WorkspaceUpdateLockToken,
): void {
  if (TOKENS.get(token) !== root) {
    throw workspaceFailure(
      'WRITE_CONFLICT',
      'Generated activation synchronization requires the active workspace update lock.',
      'Run the operation through the roster update transaction boundary.',
      { requirement: 'workspace-update-lock' },
    );
  }
}
