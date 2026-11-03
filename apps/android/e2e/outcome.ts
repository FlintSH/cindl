/** How an emulator run ends. */
export type StepStatus = 'passed' | 'failed' | 'blocked'

/**
 * The process exit code for a run's steps: green only when every step passed.
 * A blocked step (one that stopped at terms the tests never accept, such as a
 * browser's first-run screen, or one that needed such a step) fails the run
 * like a failed step, so a job can never pass without doing what it tests
 * (review of 636a2dd, S2).
 */
export function runExitCode(steps: ReadonlyArray<{ status: StepStatus }>): number {
  return steps.every((s) => s.status === 'passed') ? 0 : 1
}
