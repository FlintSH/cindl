import { describe, expect, it } from 'vitest'
import { paletteGroups } from '../src/shell/CommandPalette.tsx'
import { isMac, matchShortcut } from '../src/shortcuts.ts'

describe('the keys and the palette, after T3 Code', () => {
  const key = (init: KeyboardEventInit) =>
    ({
      target: null,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: '',
      code: '',
      ...init,
    }) as unknown as KeyboardEvent

  it('reads Ctrl/⌘ Shift [ and ] by key position, whatever character Shift makes', () => {
    const mod = isMac() ? { metaKey: true } : { ctrlKey: true }
    expect(
      matchShortcut(key({ ...mod, shiftKey: true, key: '{', code: 'BracketLeft' })),
    ).toBe('previous-conversation')
    expect(
      matchShortcut(key({ ...mod, shiftKey: true, key: '}', code: 'BracketRight' })),
    ).toBe('next-conversation')
    // Without Shift it is not the shortcut.
    expect(matchShortcut(key({ ...mod, key: '[', code: 'BracketLeft' }))).toBeUndefined()
  })

  it('leaves the conversation on screen out of the recent ones, and last among matches', () => {
    const row = (id: string, label: string, current = false) => ({
      id,
      label,
      group: 'conversations' as const,
      current,
      run: () => undefined,
    })
    const rows = [row('a', 'Kiln sheet', true), row('b', 'Kiln trip')]
    const recent = paletteGroups([], rows, '')
    expect(recent[0]?.items.map((c) => c.id)).toEqual(['b'])
    const typed = paletteGroups([], rows, 'kiln')
    expect(typed[0]?.items.map((c) => c.id)).toEqual(['b', 'a'])
  })
})
