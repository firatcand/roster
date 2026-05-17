import type { HooksTarget } from '../lib/hooks-args.ts';
import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';
import chalk from 'chalk';

export type HooksInstallOptions = {
  target: HooksTarget;
  silent: boolean;
};

export async function executeHooksInstall(_opts: HooksInstallOptions): Promise<number> {
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} hooks install not yet implemented`,
    body: '  ROS-37 step 5 lands the SessionStart hook installer.',
    remedy: '',
    exitCode: EXIT_ERROR,
  });
  return EXIT_OK;
}
