import { SYNTHETIC_DEMO_LABEL, SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { describe, expect, it } from 'vitest'
import { SYNTHETIC_FIXTURE_MARKERS, scenarioData } from '../src/index.ts'

const serialized = JSON.stringify(scenarioData)

describe('synthetic fixture markers', () => {
  it.each(SYNTHETIC_FIXTURE_MARKERS)('%s still occurs in the scenario data', (marker) => {
    expect(serialized).toContain(marker)
  })

  it('never treats the required demo label as fixture data', () => {
    for (const marker of SYNTHETIC_FIXTURE_MARKERS) {
      expect(SYNTHETIC_DEMO_LABEL).not.toContain(marker)
      expect(SYNTHETIC_DEMO_NOTICE).not.toContain(marker)
    }
  })
})
