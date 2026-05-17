import { EXIT_OK, EXIT_ERROR, RosterError } from '../lib/errors.ts';
import chalk from 'chalk';

export type ReviewOptions = {
  cwd: string;
  fn?: string;
  json: boolean;
  silent: boolean;
};

export async function executeReview(_opts: ReviewOptions): Promise<number> {
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} review not yet implemented`,
    body: '  ROS-37 step 4 lands the interactive walker.',
    remedy: '',
    exitCode: EXIT_ERROR,
  });
  return EXIT_OK;
}
