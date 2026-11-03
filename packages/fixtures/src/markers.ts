/**
 * Strings that only occur in SYNTHETIC fixture records. A real-flavour build
 * output (web dist, desktop real package, Android release bundle) must contain
 * none of them; the dist gate imports this list. The demo label from
 * @cindl/contracts is deliberately not a marker: it is required UI copy.
 * test/markers.test.ts proves every marker still occurs in the scenario, so
 * the list cannot silently stop matching anything.
 */
export const SYNTHETIC_FIXTURE_MARKERS = [
  'Lumen & Kiln',
  'hermes.synthetic.invalid',
  'srq-00000000dea1',
  'apr-demo-1',
  'demo-main',
  'Harbor Loft (fictional)',
  'export_inventory.py',
  'calendar-triage',
] as const
