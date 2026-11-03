import { selectConversationActivity, type ConversationActivity } from '@cindl/client-core'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import type { LinkState } from '@cindl/contracts'
import { fontFamily } from '@cindl/tokens'
import { createStore } from '@cindl/client-core'
import { describe, expect, it } from 'vitest'
import { keyboardOverlap } from '../src/shell/keyboardOverlap.ts'
import { duration, fuzzyScore } from '../src/talk/format.ts'
import { composerHint, linkCopy, presenceCopy } from '../src/talk/presence.ts'
import { buildTheme, resolveThemeName } from '../src/theme/model.ts'

const online: LinkState = {
  phase: 'online',
  since: '2026-06-02T08:00:00.000Z',
  connectionEpoch: 1,
}
const idle: ConversationActivity = {
  phase: 'idle',
  openRequests: [],
  executingTools: [],
  blockedToolIds: new Set(),
  queuedPrompts: 0,
  turnOpen: false,
  otherExecuting: 0,
}

describe('presence line', () => {
  it('names what the synthetic main conversation waits on, and nothing spins while it waits', async () => {
    const store = createStore(online)
    const client = createScenarioClient({ speed: 0 })
    client.subscribe((event) => store.dispatch(event))
    client.start()
    await Promise.resolve()
    const activity = selectConversationActivity(store.getState(), 'demo-main')
    expect(activity.phase).toBe('waiting-on-you')
    expect(activity.executingTools).toEqual([])
    expect(activity.blockedToolIds.has('tool-sheet')).toBe(true)
    expect(presenceCopy(store.getState().link, activity)).toMatchObject({
      tone: 'accent',
      text: 'Waiting on you: 1 approval, 1 question',
    })
    expect(composerHint(activity)).toBe(
      'Hermes is waiting for your answer above. You can still send a message.',
    )
  })

  it('counts prompts Cindl does not answer as waiting on the owner, outside Cindl', async () => {
    const store = createStore(online)
    const client = createScenarioClient({ speed: 0 })
    client.subscribe((event) => store.dispatch(event))
    client.start()
    await Promise.resolve()
    const activity = selectConversationActivity(store.getState(), 'demo-inventory')
    expect(activity.phase).toBe('waiting-on-you')
    expect(presenceCopy(online, activity).text).toBe(
      'Waiting on you: 1 prompt outside Cindl',
    )
    expect(composerHint(activity)).toBe(
      'Hermes is waiting for an answer outside Cindl. You can still send a message.',
    )
    const main = selectConversationActivity(store.getState(), 'demo-main')
    expect(
      presenceCopy(online, {
        ...main,
        openRequests: [...main.openRequests, ...activity.openRequests],
      }).text,
    ).toBe('Waiting on you: 1 approval, 1 question, 1 prompt outside Cindl')
  })

  it('reports the connection when it is not online, and the demo honestly', () => {
    expect(presenceCopy({ ...online, phase: 'reconnecting' }, idle).text).toBe(
      'Reconnecting',
    )
    expect(linkCopy('online', true).label).toBe('Synthetic demo, not connected')
  })

  it('shows queued messages and other working conversations', () => {
    expect(
      presenceCopy(online, {
        ...idle,
        phase: 'queued',
        queuedPrompts: 2,
        otherExecuting: 1,
      }),
    ).toEqual({
      tone: 'info',
      text: '2 messages queued',
      aside: '1 other conversation working',
    })
    expect(presenceCopy(online, { ...idle, phase: 'unknown' }).text).toBe(
      'Status unknown',
    )
    expect(composerHint(idle)).toBeUndefined()
  })
})

describe('formatting shared with web', () => {
  it('formats durations and fuzzy search like the web client', () => {
    expect(duration('2026-06-02T08:00:00.000Z', '2026-06-02T08:01:05.000Z')).toBe('1m 5s')
    expect(duration('2026-06-02T08:00:00.000Z', '2026-06-02T08:00:00.300Z')).toBe('<1s')
    expect(fuzzyScore('kiln', 'Kiln inventory sheet')).toBeLessThan(0)
    expect(fuzzyScore('xyz', 'Kiln inventory sheet')).toBeUndefined()
  })
})

describe('native theme from @cindl/tokens', () => {
  it('follows the system unless the owner chose a theme', () => {
    expect(resolveThemeName('system', 'dark')).toBe('dark')
    expect(resolveThemeName('system', null)).toBe('light')
    expect(resolveThemeName('light', 'dark')).toBe('light')
  })

  it('selects weight by font family, never by fontWeight', () => {
    const theme = buildTheme('dark')
    expect(theme.text.title.fontFamily).toBe(fontFamily.native.sans[600])
    expect(theme.text.code.fontFamily).toBe(fontFamily.native.mono[400])
    for (const style of Object.values(theme.text))
      expect(style).not.toHaveProperty('fontWeight')
    expect(theme.layout.touchTarget).toBe(48)
  })
})

describe('keyboard overlap', () => {
  it('pads by the part of the app the keyboard covers, whether or not the window shrank', () => {
    // Edge to edge: the app runs to the bottom of the screen (2400) and the keyboard starts at 1500.
    expect(keyboardOverlap(2400, 1500)).toBe(900)
    // A window that already shrank to the keyboard's edge needs no padding.
    expect(keyboardOverlap(1500, 1500)).toBe(0)
    expect(keyboardOverlap(1480, 1500)).toBe(0)
    expect(keyboardOverlap(2400, undefined)).toBe(0)
  })
})
