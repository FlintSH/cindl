import { CindlProvider } from '@cindl/client-react'
import { useEffect, useState } from 'react'
import { resolveClient, type ClientResolution } from './platform/client.ts'
import { ClientKindContext } from './platform/clientKind.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ErrorBoundary } from './shell/ErrorBoundary.tsx'
import { Checking, NotConnected } from './shell/NotConnected.tsx'

export function App() {
  const [client, setClient] = useState<ClientResolution>()
  // Bumped by "Try again" after Hermes did not answer.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    resolveClient().then(
      (resolved) => {
        if (current) setClient(resolved)
      },
      () => {
        if (current) setClient({ kind: 'unavailable', reason: 'no-answer' })
      },
    )
    return () => {
      current = false
    }
  }, [attempt])
  // Mounted under Hermes: connect if this browser's Hermes session is signed
  // in; otherwise the link says signed-out and sign-in shows. This effect runs
  // after CindlProvider's (a child's effects run first), so the store has
  // subscribed before the client reports anything. A failure to start shows
  // on the link, not here.
  useEffect(() => {
    if (client?.kind !== 'hermes') return
    const api = client.api
    api.start().catch(() => undefined)
    return () => api.stop()
  }, [client])
  if (!client) return <Checking />
  if (client.kind === 'unavailable')
    return (
      <NotConnected
        reason={client.reason}
        onRetry={() => {
          setClient(undefined)
          setAttempt((n) => n + 1)
        }}
      />
    )
  return (
    <ErrorBoundary label="Cindl">
      <ClientKindContext value={client.kind}>
        <CindlProvider api={client.api}>
          <AppShell />
        </CindlProvider>
      </ClientKindContext>
    </ErrorBoundary>
  )
}
