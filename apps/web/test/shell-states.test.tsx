import { CindlProvider } from '@cindl/client-react'
import {
  CindlError,
  type CindlClientApi,
  type CindlEvent,
  type LinkState,
} from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { reviveError } from '../src/platform/client.ts'
import { Notices } from '../src/shell/Notices.tsx'
import { SignIn } from '../src/shell/SignIn.tsx'

afterEach(cleanup)

function testApi(link: Partial<LinkState>, extra: CindlEvent[] = [], fail?: Error) {
  const calls: Array<{ name: string; args: unknown }> = []
  const api: CindlClientApi = {
    call: (name, args) => {
      calls.push({ name, args })
      return fail ? Promise.reject(fail) : Promise.resolve({} as never)
    },
    subscribe(listener) {
      queueMicrotask(() => {
        listener({
          type: 'link.changed',
          link: {
            phase: 'signed-out',
            since: '2026-01-01T00:00:00.000Z',
            connectionEpoch: 0,
            ...link,
          },
        })
        for (const event of extra) listener(event)
      })
      return () => undefined
    },
  }
  return { api, calls }
}
const settle = () =>
  act(async () => {
    await Promise.resolve()
  })

describe('desktop error revival', () => {
  it('turns a plain CindlErrorShape back into a CindlError with its code', () => {
    const revived = reviveError({
      name: 'CindlError',
      code: 'conflict',
      message: 'Changed elsewhere.',
    })
    expect(revived).toBeInstanceOf(CindlError)
    expect((revived as CindlError).code).toBe('conflict')
  })

  it('keeps real errors and wraps anything unrecognised as internal', () => {
    const plain = new Error('boom')
    expect(reviveError(plain)).toBe(plain)
    const unknownShape = reviveError({ code: 'not-a-code', message: 'x' })
    expect(unknownShape).toBeInstanceOf(CindlError)
    expect((unknownShape as CindlError).code).toBe('internal')
  })
})

describe('sign-in screen', () => {
  it('refuses plain http and credentials before contacting anything', async () => {
    const { api, calls } = testApi({})
    render(
      <CindlProvider api={api}>
        <SignIn />
      </CindlProvider>,
    )
    await settle()
    const field = screen.getByRole('textbox', { name: 'Hermes address' })
    for (const value of [
      'http://hermes.example.test',
      'https://user:pw@hermes.example.test',
    ]) {
      fireEvent.change(field, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
      await settle()
      expect(screen.getByRole('alert')).toBeTruthy()
    }
    expect(calls).toEqual([])
  })

  it('sends only the normalised origin', async () => {
    const { api, calls } = testApi({})
    render(
      <CindlProvider api={api}>
        <SignIn />
      </CindlProvider>,
    )
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Hermes address' }), {
      target: { value: 'https://Hermes.Example.Test:443/' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(calls).toEqual([
      { name: 'auth.signIn', args: { origin: 'https://hermes.example.test' } },
    ])
  })
})

describe('notices', () => {
  it('shows client notices until dismissed', async () => {
    const { api } = testApi({ phase: 'online' }, [
      {
        type: 'notice',
        level: 'warning',
        message: 'Secure storage is unavailable; you will need to sign in again.',
      },
    ])
    render(
      <CindlProvider api={api}>
        <Notices />
      </CindlProvider>,
    )
    await settle()
    expect(screen.getByText(/Secure storage is unavailable/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }))
    expect(screen.queryByText(/Secure storage is unavailable/)).toBeNull()
  })
})
