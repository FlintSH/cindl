import { describe, expect, it } from 'vitest'
import { createBackDispatcher } from '../src/nav/back.ts'
import {
  back,
  createNavStore,
  initialNav,
  navigate,
  type NavState,
} from '../src/nav/navigation.ts'

describe('system back order', () => {
  it('closes the skill detail before leaving Library, then returns to Talk', () => {
    let state: NavState = navigate(initialNav, { type: 'skill', name: 'calendar-triage' })
    expect(state).toMatchObject({ destination: 'library', skill: 'calendar-triage' })
    state = back(state) as NavState
    expect(state).toMatchObject({ destination: 'library', skill: undefined })
    state = back(state) as NavState
    expect(state.destination).toBe('talk')
  })

  it('returns from a side conversation to the main one, then lets Android leave the app', () => {
    const side = navigate(initialNav, {
      type: 'conversation',
      conversationId: 'demo-offsite',
    })
    const main = back(side) as NavState
    expect(main).toMatchObject({ destination: 'talk', conversationId: undefined })
    expect(back(main)).toBeUndefined()
  })

  it('goes back to Talk from any other destination without losing their state', () => {
    const agent = navigate(
      navigate(initialNav, { type: 'agent-section', section: 'runtime' }),
      { type: 'go', destination: 'agent' },
    )
    const talk = back(agent) as NavState
    expect(talk.destination).toBe('talk')
    expect(talk.agentSection).toBe('runtime')
  })

  it('reselecting Library returns it to the skill list', () => {
    const detail = navigate(initialNav, { type: 'skill', name: 'draft-replies' })
    expect(navigate(detail, { type: 'go', destination: 'library' }).skill).toBeUndefined()
    expect(navigate(initialNav, { type: 'go', destination: 'talk' })).toBe(initialNav)
  })

  it('switching Library sections drops the stacked skill', () => {
    const detail = navigate(initialNav, { type: 'skill', name: 'draft-replies' })
    const memory = navigate(detail, { type: 'library-section', section: 'memory' })
    expect(memory).toMatchObject({ librarySection: 'memory', skill: undefined })
  })
})

describe('nav store', () => {
  it('notifies only on change and reports when back is exhausted', () => {
    const store = createNavStore()
    let calls = 0
    store.subscribe(() => calls++)
    store.dispatch({ type: 'go', destination: 'talk' })
    expect(calls).toBe(0)
    store.dispatch({ type: 'go', destination: 'work' })
    expect(calls).toBe(1)
    expect(store.back()).toBe(true)
    expect(store.getState().destination).toBe('talk')
    expect(store.back()).toBe(false)
  })
})

describe('back dispatcher', () => {
  it('offers back to the most recently registered handler first', () => {
    const dispatcher = createBackDispatcher()
    const order: string[] = []
    const store = createNavStore(
      navigate(initialNav, { type: 'go', destination: 'work' }),
    )
    dispatcher.push(() => {
      order.push('screen')
      return store.back()
    })
    const removeEditor = dispatcher.push(() => {
      order.push('editor')
      return false
    })
    const removeSheet = dispatcher.push(() => {
      order.push('sheet')
      return true
    })
    expect(dispatcher.dispatch()).toBe(true)
    expect(order).toEqual(['sheet'])
    expect(store.getState().destination).toBe('work')

    removeSheet()
    expect(dispatcher.dispatch()).toBe(true)
    expect(order).toEqual(['sheet', 'editor', 'screen'])
    expect(store.getState().destination).toBe('talk')

    removeEditor()
    expect(dispatcher.dispatch()).toBe(false)
  })

  it('removing a handler twice is harmless', () => {
    const dispatcher = createBackDispatcher()
    const remove = dispatcher.push(() => true)
    remove()
    remove()
    expect(dispatcher.dispatch()).toBe(false)
  })
})
