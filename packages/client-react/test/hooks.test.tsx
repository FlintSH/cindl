import { createScenarioClient } from '@cindl/fixtures/scenario'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CindlProvider,
  useCindlApi,
  useCindlState,
  useConversationActivity,
  useConversations,
  useOpenRequests,
  useUncertainPrompts,
} from '../src/index.ts'

afterEach(cleanup)

// Regression: a selector that builds a new array on every call made
// useSyncExternalStore re-render forever (React error #185 in the web app).
describe('hooks return stable snapshots', () => {
  it('settles with inline array-building selectors and every derived hook', async () => {
    let renders = 0
    const seen: unknown[] = []
    function Probe() {
      renders++
      const upper = useCindlState((state) =>
        Object.keys(state.conversations).map((id) => id.toUpperCase()),
      )
      const uncertain = useUncertainPrompts('demo-main')
      const open = useOpenRequests('demo-main')
      const conversations = useConversations()
      const activity = useConversationActivity('demo-main')
      seen.push(uncertain, activity)
      return (
        <p>
          {upper.length}:{uncertain.length}:{open.length}:{conversations.length}:
          {activity.phase}
        </p>
      )
    }
    const client = createScenarioClient({ speed: 0 })
    render(
      <CindlProvider api={client}>
        <Probe />
      </CindlProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(renders).toBeLessThan(25)
  })

  it('keeps derived values identical across unrelated state changes', async () => {
    const values: Array<{ uncertain: unknown; activity: unknown; display: unknown }> = []
    let change: (() => Promise<unknown>) | undefined
    function Probe() {
      const api = useCindlApi()
      values.push({
        uncertain: useUncertainPrompts('demo-main'),
        activity: useConversationActivity('demo-main'),
        display: useCindlState((state) => state.display),
      })
      // Taking control changes the display state only: unrelated to the main
      // conversation's prompts and activity.
      change = () => api.call('display.acquireControl', { confirm: true })
      return null
    }
    const client = createScenarioClient({ speed: 0 })
    render(
      <CindlProvider api={client}>
        <Probe />
      </CindlProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    const before = values.at(-1)
    await act(async () => {
      await change?.()
    })
    const after = values.at(-1)
    expect(after?.display).not.toBe(before?.display)
    expect(after?.uncertain).toBe(before?.uncertain)
    expect(after?.activity).toBe(before?.activity)
  })
})
