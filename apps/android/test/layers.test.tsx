/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Button } from '../src/ui/primitives.tsx'
import { Layer } from '../src/views/Layer.tsx'
import { nativeLog, resetNative } from './render/react-native.tsx'

// A destination stays mounted while another is shown (AppShell's layers). It
// was hidden by opacity alone, so Tab could reach its controls unseen (delta
// check of 7dab9fe, note 9): a hidden layer is closed to a keyboard's focus.

beforeEach(() => resetNative())
afterEach(() => cleanup())

function layers(shown: 'talk' | 'work') {
  return (
    <>
      <Layer visible={shown === 'talk'}>
        <Button label="Send" onPress={() => undefined} />
      </Layer>
      <Layer visible={shown === 'work'}>
        <Button label="Take control…" onPress={() => undefined} />
      </Layer>
    </>
  )
}

/** The layer holding a control, and what was asked of the focus module for each layer. */
const layerOf = (container: HTMLElement, label: string) =>
  container.querySelector(`[aria-label="${label}"]`)?.parentElement
const blocks = (layer: Element | null | undefined) =>
  nativeLog.flatMap((entry) =>
    entry.kind === 'keyboard-block' && entry.node === layer ? [entry.blocked] : [],
  )

describe('a destination hidden behind another', () => {
  it("is closed to a keyboard's focus while hidden, and opened again when shown", () => {
    const view = render(layers('talk'))
    const talk = layerOf(view.container, 'Send')
    const work = layerOf(view.container, 'Take control…')
    // Mounted hidden: blocked at once; the one shown asks nothing.
    expect(blocks(work)).toEqual([true])
    expect(blocks(talk)).toEqual([])
    view.rerender(layers('work'))
    expect(blocks(talk)).toEqual([true])
    expect(blocks(work)).toEqual([true, false])
    // Hidden from TalkBack as before.
    expect(talk?.getAttribute('aria-hidden')).toBe('true')
    expect(work?.getAttribute('aria-hidden')).toBeNull()
  })
})
