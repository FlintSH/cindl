import { CindlProvider } from '@cindl/client-react'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { WorkView } from '../src/work/WorkView.tsx'

afterEach(cleanup)

// "Needs you" holds Cindl's own approvals and questions and also prompts
// Hermes waits on elsewhere that Cindl can only show; the note says both, and
// that it is no gate on everything Hermes does.
it('says what Needs you covers, including prompts Cindl can only show', async () => {
  render(
    <CindlProvider api={createScenarioClient({ speed: 0 })}>
      <WorkView />
    </CindlProvider>,
  )
  const note = await screen.findByText(
    /^Covers command approvals and questions Hermes asks Cindl/,
  )
  expect(note.textContent).toMatch(
    /prompts it is\s+waiting on elsewhere that Cindl can only show/,
  )
  expect(note.textContent).toMatch(/not a gate on every\s+action Hermes can take/)
})
