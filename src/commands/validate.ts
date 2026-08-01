import { EXIT_ERROR, EXIT_OK } from '../lib/errors.ts';
import { validateWorkspace } from '../lib/workspace-registry.ts';

export type ValidateCommandOptions = {
  cwd: string;
  target?: string;
  json: boolean;
};

export function executeValidate(options: ValidateCommandOptions): number {
  const result = validateWorkspace(options.cwd, {
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const check of result.checks) {
      console.log(`${check.status === 'pass' ? 'pass' : 'fail'} ${check.name}`);
    }
    for (const diagnostic of result.diagnostics) {
      console.log(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
      if (diagnostic.remedy !== undefined) console.log(`  ${diagnostic.remedy}`);
    }
  }
  return result.ok ? EXIT_OK : EXIT_ERROR;
}
