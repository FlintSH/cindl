/**
 * Every keyboard shortcut, in one registry used by the handlers, the
 * shortcuts dialog and the keyboard table in
 * docs/handbook/clients/web.md (a coverage check is planned). Add a shortcut here, not
 * inline in a component.
 */
export interface Shortcut {
  id: ShortcutId
  keys: readonly string[]
  label: string
  /** Fires even while typing in an input. */
  global?: boolean
}

export type ShortcutId =
  | 'palette'
  | 'switch-conversation'
  | 'new-side'
  | 'focus-composer'
  | 'toggle-margin'
  | 'go-talk'
  | 'go-work'
  | 'go-library'
  | 'go-agent'
  | 'help'

export const shortcuts: readonly Shortcut[] = [
  { id: 'palette', keys: ['Mod', 'K'], label: 'Open the command palette', global: true },
  {
    id: 'switch-conversation',
    keys: ['Mod', 'J'],
    label: 'Switch conversation',
    global: true,
  },
  {
    id: 'new-side',
    keys: ['Mod', 'Shift', 'O'],
    label: 'Start a side conversation',
    global: true,
  },
  {
    id: 'toggle-margin',
    keys: ['Mod', '.'],
    label: 'Show or hide the working margin',
    global: true,
  },
  { id: 'go-talk', keys: ['Alt', '1'], label: 'Go to Talk', global: true },
  { id: 'go-work', keys: ['Alt', '2'], label: 'Go to Work', global: true },
  { id: 'go-library', keys: ['Alt', '3'], label: 'Go to Library', global: true },
  { id: 'go-agent', keys: ['Alt', '4'], label: 'Go to Agent', global: true },
  { id: 'focus-composer', keys: ['/'], label: 'Focus the message box' },
  { id: 'help', keys: ['?'], label: 'Show keyboard shortcuts' },
]

export const isMac = () =>
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function keyLabel(key: string): string {
  if (key === 'Mod') return isMac() ? '⌘' : 'Ctrl'
  if (key === 'Alt') return isMac() ? '⌥' : 'Alt'
  if (key === 'Shift') return isMac() ? '⇧' : 'Shift'
  return key
}

/** A shortcut as tooltips write it: "Ctrl+Shift+O", or "⌘⇧O" on a Mac. */
export function shortcutText(id: ShortcutId): string {
  const keys = shortcuts.find((shortcut) => shortcut.id === id)?.keys ?? []
  return keys.map(keyLabel).join(isMac() ? '' : '+')
}

function matches(shortcut: Shortcut, event: KeyboardEvent): boolean {
  const wantMod = shortcut.keys.includes('Mod')
  const wantAlt = shortcut.keys.includes('Alt')
  const wantShift = shortcut.keys.includes('Shift')
  const mod = isMac() ? event.metaKey : event.ctrlKey
  const key = shortcut.keys.at(-1) as string
  const code = /^\d$/.test(key) ? `Digit${key}` : undefined
  const keyMatches =
    (code !== undefined && event.code === code) ||
    event.key.toLowerCase() === key.toLowerCase()
  if (!keyMatches || mod !== wantMod || event.altKey !== wantAlt) return false
  // '?' is Shift+/ on most layouts; only enforce Shift where the shortcut names it.
  return key === '?' || event.shiftKey === wantShift
}

const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function matchShortcut(event: KeyboardEvent): ShortcutId | undefined {
  const typing = typingTarget(event.target)
  for (const shortcut of shortcuts) {
    if (typing && !shortcut.global) continue
    if (matches(shortcut, event)) return shortcut.id
  }
  return undefined
}
