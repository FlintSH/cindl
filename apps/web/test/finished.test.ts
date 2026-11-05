import type { Conversation } from '@cindl/contracts'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetFinished, noteStatuses, useFinished } from '../src/talk/finished.ts'

const conversation = (id: string, status: Conversation['status']): Conversation => ({
  id,
  session: { storedId: id },
  title: id,
  kind: 'side',
  status,
})

/** Notes the statuses as the shell does, and returns what is marked "Done". */
function tracker() {
  const { result } = renderHook(() => useFinished())
  return (list: Conversation[], onScreen?: string) => {
    act(() => noteStatuses(list, onScreen))
    return [...result.current]
  }
}

afterEach(() => act(() => forgetFinished()))

describe('what Hermes finished while the owner looked elsewhere', () => {
  it('is marked once it goes from working to idle off screen, until it is opened', () => {
    const note = tracker()
    expect(note([conversation('a', 'working'), conversation('b', 'idle')], 'b')).toEqual(
      [],
    )
    expect(note([conversation('a', 'idle'), conversation('b', 'idle')], 'b')).toEqual([
      'a',
    ])
    // Still marked while the owner is on another destination.
    expect(note([conversation('a', 'idle'), conversation('b', 'idle')])).toEqual(['a'])
    expect(note([conversation('a', 'idle'), conversation('b', 'idle')], 'a')).toEqual([])
  })

  it('is never marked unless the finish was seen off screen, and clears when Hermes starts again', () => {
    const note = tracker()
    // Idle from the start: no finish was seen.
    expect(note([conversation('a', 'idle')])).toEqual([])
    // Finished on screen.
    note([conversation('a', 'working')], 'a')
    expect(note([conversation('a', 'idle')], 'a')).toEqual([])
    // Waiting on the owner, then done, off screen.
    note([conversation('a', 'waiting-on-you')])
    expect(note([conversation('a', 'idle')])).toEqual(['a'])
    expect(note([conversation('a', 'working')])).toEqual([])
  })

  it('drops conversations that are gone, and forgets everything with the session', () => {
    const note = tracker()
    note([conversation('a', 'working'), conversation('b', 'working')])
    expect(note([conversation('a', 'idle'), conversation('b', 'idle')])).toEqual([
      'a',
      'b',
    ])
    expect(note([conversation('b', 'idle')])).toEqual(['b'])
    act(() => forgetFinished())
    // What it saw before goes too: idle now is not a finish.
    expect(note([conversation('b', 'idle')])).toEqual([])
  })
})
