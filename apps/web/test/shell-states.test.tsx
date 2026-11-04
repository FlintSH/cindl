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
  it('can stop waiting for a sign-in that never comes back', async () => {
    const api: CindlClientApi = {
      call: () => new Promise(() => undefined),
      subscribe(listener) {
        queueMicrotask(() =>
          listener({
            type: 'link.changed',
            link: {
              phase: 'unconfigured',
              since: '2026-01-01T00:00:00.000Z',
              connectionEpoch: 0,
            },
          }),
        )
        return () => undefined
      },
    }
    render(
      <CindlProvider api={api}>
        <SignIn />
      </CindlProvider>,
    )
    await settle()
    fireEvent.change(screen.getByLabelText('Hermes address'), {
      target: { value: 'https://hermes.example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(screen.getByText(/does not cancel the sign-in in your browser/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty(
      'disabled',
      false,
    )
  })

  // Review 91f30e07 N3: main cancels an abandoned attempt when a new one starts;
  // that late rejection must not report an error or unlock the new attempt.
  it('ignores the outcome of an attempt abandoned with Stop waiting', async () => {
    const pending: Array<(error: Error) => void> = []
    const api: CindlClientApi = {
      call: () =>
        new Promise((_resolve, reject) => {
          pending.push(reject)
        }),
      subscribe(listener) {
        queueMicrotask(() =>
          listener({
            type: 'link.changed',
            link: {
              phase: 'unconfigured',
              since: '2026-01-01T00:00:00.000Z',
              connectionEpoch: 0,
            },
          }),
        )
        return () => undefined
      },
    }
    render(
      <CindlProvider api={api}>
        <SignIn />
      </CindlProvider>,
    )
    await settle()
    fireEvent.change(screen.getByLabelText('Hermes address'), {
      target: { value: 'https://hermes.example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(pending).toHaveLength(2)
    pending[0]?.(new CindlError('unauthenticated', 'Sign-in was cancelled.'))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Waiting for the browser…' }),
    ).toHaveProperty('disabled', true)
    // The current attempt still reports its own outcome.
    pending[1]?.(new CindlError('unauthenticated', 'Hermes refused the sign-in.'))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Hermes refused the sign-in.')
  })

  // Review 4ad97d1 N6: the attempt is abandoned at the click, not when the
  // next sign-in starts.
  it('stays quiet when an abandoned attempt fails before any new one', async () => {
    const pending: Array<(error: Error) => void> = []
    const api: CindlClientApi = {
      call: () =>
        new Promise((_resolve, reject) => {
          pending.push(reject)
        }),
      subscribe(listener) {
        queueMicrotask(() =>
          listener({
            type: 'link.changed',
            link: {
              phase: 'unconfigured',
              since: '2026-01-01T00:00:00.000Z',
              connectionEpoch: 0,
            },
          }),
        )
        return () => undefined
      },
    }
    render(
      <CindlProvider api={api}>
        <SignIn />
      </CindlProvider>,
    )
    await settle()
    fireEvent.change(screen.getByLabelText('Hermes address'), {
      target: { value: 'https://hermes.example.test' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
    pending[0]?.(new CindlError('unauthenticated', 'Sign-in was cancelled.'))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty(
      'disabled',
      false,
    )
  })

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

  it('shows a notice that comes again once, and dismisses every copy', async () => {
    const again = 'Hermes did not confirm the sign-out (fixture).'
    const notice = (message: string): CindlEvent => ({
      type: 'notice',
      level: 'warning',
      message,
    })
    const listeners = new Set<(event: CindlEvent) => void>()
    const api: CindlClientApi = {
      call: () => Promise.resolve({} as never),
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    const emit = (event: CindlEvent) =>
      act(async () => {
        for (const listener of listeners) listener(event)
        await Promise.resolve()
      })
    render(
      <CindlProvider api={api}>
        <Notices />
      </CindlProvider>,
    )
    await settle()
    await emit(notice(again))
    await emit(notice('Another notice (fixture).'))
    await emit(notice(again))
    await emit(notice(again))
    expect(screen.getAllByText(again)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Dismiss notice' })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notice' })[1]!)
    expect(screen.queryByText(again)).toBeNull()
    expect(screen.getByText('Another notice (fixture).')).toBeTruthy()
    // Said once more later, it shows again.
    await emit(notice(again))
    expect(screen.getAllByText(again)).toHaveLength(1)
  })
})
