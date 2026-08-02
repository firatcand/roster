import { EXIT_ERROR, EXIT_OK } from '../lib/errors.ts';
import { discoverWorkspace } from '../lib/workspace-registry.ts';
import type { WorkspaceRecordKind } from '../lib/workspace-layout.ts';

export type DiscoverCommandOptions = {
  cwd: string;
  query?: string;
  recordKind?: WorkspaceRecordKind;
  scope?: string;
  exact: boolean;
  full: boolean;
  json: boolean;
};

export function executeDiscover(options: DiscoverCommandOptions): number {
  const result = discoverWorkspace(options.cwd, {
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.recordKind === undefined ? {} : { kind: options.recordKind }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    exact: options.exact,
    full: options.full,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    for (const diagnostic of result.diagnostics) {
      console.error(`${diagnostic.code}: ${diagnostic.message}`);
      if (diagnostic.remedy !== undefined) console.error(`  ${diagnostic.remedy}`);
    }
    if (result.records.length === 0 && !hasError) console.log('No matching Roster records.');
    for (const record of result.records) {
      console.log(`${record.kind} ${record.qualified_id} -> ${record.path}`);
      if (options.full && record.content !== undefined) console.log(record.content.trimEnd());
    }
  }
  return result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? EXIT_ERROR
    : EXIT_OK;
}
