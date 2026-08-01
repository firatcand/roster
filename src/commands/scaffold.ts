import { EXIT_OK } from '../lib/errors.ts';
import { scaffoldWorkspace } from '../lib/workspace-registry.ts';
import type { WorkspaceRecordKind } from '../lib/workspace-layout.ts';

export type ScaffoldCommandOptions = {
  cwd: string;
  recordKind: WorkspaceRecordKind;
  id: string;
  scope?: string;
  purpose: string;
  json: boolean;
};

export function executeScaffold(options: ScaffoldCommandOptions): number {
  const result = scaffoldWorkspace(options.cwd, {
    kind: options.recordKind,
    id: options.id,
    purpose: options.purpose,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.record.kind} ${result.record.qualified_id} -> ${result.record.path}`);
  }
  return EXIT_OK;
}
