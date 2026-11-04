import { selectConversationActivity, type ConversationActivity } from '@cindl/client-core'
import { createScenarioClient } from '@cindl/fixtures/scenario'
import type { LinkState } from '@cindl/contracts'
import { fontFamily } from '@cindl/tokens'
import { createStore } from '@cindl/client-core'
import { describe, expect, it } from 'vitest'
import {
  afterSignIn,
  CONNECTING_AFTER_SIGN_IN,
  REFUSED_AFTER_SIGN_IN,
} from '../src/shell/afterSignIn.ts'
import { keyboardOverlap } from '../src/shell/keyboardOverlap.ts'
import {
  clockTime,
  duration,
  elapsed,
  fuzzyScore,
  listTime,
  messageTime,
  momentInSentence,
  routineDetail,
} from '../src/talk/format.ts'
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

  it('writes times like the web client: no padded hour, no seconds', () => {
    const iso = '2026-06-02T08:03:09'
    expect(clockTime(iso)).toBe(
      new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    )
    if (Intl.DateTimeFormat().resolvedOptions().locale === 'en-US')
      expect(clockTime(iso)).toMatch(/^8:03\sAM$/u)
    const now = new Date(2026, 5, 10, 18, 0)
    const at = (days: number) => new Date(2026, 5, 10 - days, 9, 55).toISOString()
    expect(momentInSentence(at(0), now)).toMatch(/^today at \S/)
    expect(momentInSentence(at(1), now)).toMatch(/^yesterday at \S/)
    expect(momentInSentence(at(30), now)).toMatch(/^on \S.* at \S/)
    expect(momentInSentence('not a date', now)).toBeUndefined()
  })

  it('shares the web’s day-aware times, live timer and routine line', () => {
    const now = new Date(2026, 5, 10, 18, 0)
    const at = (days: number, hour = 9) =>
      new Date(2026, 5, 10 - days, hour, 55).toISOString()
    expect(messageTime(at(0), now)).toBe(clockTime(at(0)))
    expect(messageTime(at(1), now)).toBe(`Yesterday, ${clockTime(at(1))}`)
    expect(listTime(at(0), now)).toBe(clockTime(at(0)))
    expect(listTime(at(1), now)).toBe('Yesterday')
    const start = Date.parse('2026-06-10T10:00:00.000Z')
    expect(elapsed(new Date(start).toISOString(), start + 65_000)).toBe('1m 5s')
    expect(elapsed(new Date(start).toISOString(), start - 1_000)).toBeUndefined()
    expect(
      routineDetail(
        {
          schedule: 'Weekdays at 07:30',
          enabled: true,
          lastRun: { at: at(1, 7), status: 'skipped' },
        },
        now,
      ),
    ).toBe(`Weekdays at 07:30 · last run yesterday at ${clockTime(at(1, 7))}, skipped`)
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

describe('after the browser leg of sign-in (review of 636a2dd, N12)', () => {
  it('says it is connecting, then why it could not, and lets the owner leave the sign-in screen', () => {
    expect(afterSignIn(false, { phase: 'offline' })).toEqual({ kind: 'none' })
    expect(afterSignIn(true, { phase: 'online' })).toEqual({ kind: 'none' })
    expect(afterSignIn(true, { phase: 'connecting' })).toEqual({
      kind: 'connecting',
      message: CONNECTING_AFTER_SIGN_IN,
    })
    expect(
      afterSignIn(true, {
        phase: 'reconnecting',
        lastError: { code: 'offline', message: 'The connection to Hermes closed.' },
      }),
    ).toEqual({
      kind: 'stuck',
      message:
        'Signed in, but Cindl could not connect to Hermes: The connection to Hermes closed.',
      canContinue: true,
    })
    expect(afterSignIn(true, { phase: 'incompatible' })).toMatchObject({
      kind: 'stuck',
      canContinue: true,
    })
    // Hermes refused the tokens after all: nothing to continue to.
    expect(afterSignIn(true, { phase: 'signed-out' })).toEqual({
      kind: 'stuck',
      message: REFUSED_AFTER_SIGN_IN,
      canContinue: false,
    })
  })
})
