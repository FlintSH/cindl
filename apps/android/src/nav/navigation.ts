/**
 * Navigation state for the four destinations (DESIGN.md: the Conversation
 * Desk). Pure, so the back order is unit-tested; NavProvider wires it to
 * React and to Android's back button.
 */
export type Destination = 'talk' | 'work' | 'library' | 'agent'
export type LibrarySection = 'skills' | 'memory' | 'artifacts'
export type AgentSection =
  'identity' | 'connections' | 'runtime' | 'device' | 'appearance'

export const destinations: readonly Destination[] = ['talk', 'work', 'library', 'agent']
export const librarySections: readonly LibrarySection[] = [
  'skills',
  'memory',
  'artifacts',
]
export const agentSections: readonly AgentSection[] = [
  'identity',
  'connections',
  'runtime',
  'device',
  'appearance',
]

export interface NavState {
  destination: Destination
  /** A side conversation over the main one; undefined shows the main conversation. */
  conversationId: string | undefined
  librarySection: LibrarySection
  /** Skill detail stacked over the skill list. */
  skill: string | undefined
  agentSection: AgentSection
}

export const initialNav: NavState = {
  destination: 'talk',
  conversationId: undefined,
  librarySection: 'skills',
  skill: undefined,
  agentSection: 'identity',
}

export type NavAction =
  | { type: 'go'; destination: Destination }
  | { type: 'conversation'; conversationId: string | undefined }
  | { type: 'library-section'; section: LibrarySection }
  | { type: 'skill'; name: string | undefined }
  | { type: 'agent-section'; section: AgentSection }

export function navigate(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'go':
      if (action.destination !== state.destination)
        return { ...state, destination: action.destination }
      // Reselecting the current destination returns it to its top level.
      return action.destination === 'library' && state.skill !== undefined
        ? { ...state, skill: undefined }
        : state
    case 'conversation':
      return state.destination === 'talk' &&
        state.conversationId === action.conversationId
        ? state
        : { ...state, destination: 'talk', conversationId: action.conversationId }
    case 'library-section':
      return state.destination === 'library' &&
        state.librarySection === action.section &&
        state.skill === undefined
        ? state
        : {
            ...state,
            destination: 'library',
            librarySection: action.section,
            skill: undefined,
          }
    case 'skill':
      return state.destination === 'library' && state.skill === action.name
        ? state
        : {
            ...state,
            destination: 'library',
            librarySection: 'skills',
            skill: action.name,
          }
    case 'agent-section':
      return state.destination === 'agent' && state.agentSection === action.section
        ? state
        : { ...state, destination: 'agent', agentSection: action.section }
  }
}

/**
 * Screen-level system back (overlays and editors handle it before this).
 * Order: skill detail to the list, any destination to Talk, a side
 * conversation to the main one. Undefined means Talk on the main
 * conversation: Android takes over and leaves the app.
 */
export function back(state: NavState): NavState | undefined {
  if (state.destination === 'library' && state.skill !== undefined)
    return { ...state, skill: undefined }
  if (state.destination !== 'talk') return { ...state, destination: 'talk' }
  if (state.conversationId !== undefined) return { ...state, conversationId: undefined }
  return undefined
}

/** Property signatures: every member is safe to pass around unbound. */
export interface NavStore {
  getState: () => NavState
  dispatch: (action: NavAction) => void
  /** Applies screen-level back; false when there is nothing left to go back to. */
  back: () => boolean
  subscribe: (listener: () => void) => () => void
}

export function createNavStore(initial: NavState = initialNav): NavStore {
  let state = initial
  const listeners = new Set<() => void>()
  const set = (next: NavState) => {
    if (next === state) return
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getState: () => state,
    dispatch: (action) => set(navigate(state, action)),
    back() {
      const next = back(state)
      if (!next) return false
      set(next)
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
