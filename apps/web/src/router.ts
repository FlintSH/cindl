import { useEffect, useState } from 'react'

/**
 * Hash routes work unchanged under Electron's app:// protocol, a sub-path
 * mount and local previews. Four destinations; conversation is the anchor.
 */
export type Destination = 'talk' | 'work' | 'library' | 'agent'
export type LibrarySection = 'skills' | 'memory' | 'artifacts'
export type AgentSection =
  'identity' | 'connections' | 'runtime' | 'device' | 'appearance'

export type Route =
  | { view: 'talk'; conversationId?: string }
  | { view: 'work' }
  | { view: 'library'; section: LibrarySection; item?: string }
  | { view: 'agent'; section: AgentSection }

const librarySections: LibrarySection[] = ['skills', 'memory', 'artifacts']
const agentSections: AgentSection[] = [
  'identity',
  'connections',
  'runtime',
  'device',
  'appearance',
]

export function parseRoute(hash: string): Route {
  const [view, a, b] = hash
    .replace(/^#\/?/, '')
    .split('/')
    .map((part) => decodeURIComponent(part))
  switch (view) {
    case 'work':
      return { view: 'work' }
    case 'library': {
      const section = librarySections.includes(a as LibrarySection)
        ? (a as LibrarySection)
        : 'skills'
      return b ? { view: 'library', section, item: b } : { view: 'library', section }
    }
    case 'agent':
      return {
        view: 'agent',
        section: agentSections.includes(a as AgentSection)
          ? (a as AgentSection)
          : 'identity',
      }
    default:
      return a ? { view: 'talk', conversationId: a } : { view: 'talk' }
  }
}

export function formatRoute(route: Route): string {
  const enc = encodeURIComponent
  switch (route.view) {
    case 'talk':
      return route.conversationId ? `#/talk/${enc(route.conversationId)}` : '#/talk'
    case 'work':
      return '#/work'
    case 'library':
      return route.item
        ? `#/library/${route.section}/${enc(route.item)}`
        : `#/library/${route.section}`
    case 'agent':
      return `#/agent/${route.section}`
  }
}

export function navigate(route: Route, options: { replace?: boolean } = {}) {
  const hash = formatRoute(route)
  if (window.location.hash === hash) return
  if (options.replace) window.history.replaceState(null, '', hash)
  else window.history.pushState(null, '', hash)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return route
}
