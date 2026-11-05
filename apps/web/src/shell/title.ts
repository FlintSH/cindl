import { SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'

/**
 * The tab's (and the desktop window's) title. While something waits on the
 * owner it leads with the same count as Work's badge, so a background tab or
 * a taskbar entry shows that a decision is waiting.
 */
export function pageTitle(waiting: number, demo: boolean | undefined): string {
  const base = demo ? `Cindl (${SYNTHETIC_DEMO_LABEL.toLowerCase()})` : 'Cindl'
  return waiting > 0 ? `(${waiting > 9 ? '9+' : waiting}) ${base}` : base
}
