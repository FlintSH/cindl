import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi, DisplayView } from '@cindl/contracts'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScreenView } from '../src/work/ScreenView.tsx'

afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })

/** A client whose watch resolves when the test says so; frames never arrive. */
function client() {
  let resolveWatch: ((view: DisplayView) => void) | undefined
  const unwatched: unknown[] = []
  const api: CindlClientApi = {
    call: ((name: string, args: unknown) => {
      if (name === 'display.watch')
        return new Promise<DisplayView>((resolve) => (resolveWatch = resolve))
      if (name === 'display.unwatch') {
        unwatched.push(args)
        return Promise.resolve({ stopped: true })
      }
      return new Promise(() => undefined)
    }) as CindlClientApi['call'],
    subscribe: () => () => undefined,
  }
  const view = { viewId: 'view-test0001', width: 4, height: 3 }
  return { api, unwatched, open: () => resolveWatch?.(view) }
}

describe('screen view', () => {
  it('ends the view when the screen closes', async () => {
    const { api, unwatched, open } = client()
    const shown = render(
      <CindlProvider api={api}>
        <ScreenView controlling={false} />
      </CindlProvider>,
    )
    open()
    await settle()
    shown.unmount()
    await settle()
    expect(unwatched).toEqual([{ viewId: 'view-test0001' }])
  })

  // Review fbf44d4 SF5: a watch that resolved after the screen closed left its
  // view (and Hermes's screen socket) open.
  it('ends a view whose watch resolves after the screen closed', async () => {
    const { api, unwatched, open } = client()
    const shown = render(
      <CindlProvider api={api}>
        <ScreenView controlling={false} />
      </CindlProvider>,
    )
    shown.unmount()
    open()
    await settle()
    expect(unwatched).toEqual([{ viewId: 'view-test0001' }])
  })
})
