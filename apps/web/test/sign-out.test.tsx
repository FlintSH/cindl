import { CindlProvider } from '@cindl/client-react'
import { CindlError, type CindlClientApi, type CindlEvent } from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentView } from '../src/agent/AgentView.tsx'

afterEach(cleanup)

const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

describe('sign-out on this device', () => {
  it('shows only the latest outcome', async () => {
    let attempts = 0
    const api: CindlClientApi = {
      call: (name) => {
        if (name !== 'auth.signOut')
          return Promise.reject(new Error(`unexpected ${name}`))
        attempts += 1
        return attempts === 1
          ? Promise.reject(new CindlError('unavailable', 'Keychain locked.'))
          : Promise.resolve({} as never)
      },
      subscribe(listener: (event: CindlEvent) => void) {
        queueMicrotask(() =>
          listener({
            type: 'link.changed',
            link: {
              phase: 'online',
              since: '2026-01-01T00:00:00.000Z',
              connectionEpoch: 1,
            },
          }),
        )
        return () => undefined
      },
    }
    render(
      <CindlProvider api={api}>
        <AgentView section="device" />
      </CindlProvider>,
    )
    await settle()
    const button = screen.getByRole('button', { name: 'Sign out on this device' })
    fireEvent.click(button)
    await settle()
    expect(screen.getByRole('alert').textContent).toMatch(/did not complete/)
    fireEvent.click(button)
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Signed out on this device.')).toBeTruthy()
  })
})
