import { CindlProvider } from '@cindl/client-react'
import { useEffect, useState } from 'react'
import { resolveClient, type ClientResolution } from './platform/client.ts'
import { ClientKindContext } from './platform/clientKind.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ErrorBoundary } from './shell/ErrorBoundary.tsx'
import { NotConnected } from './shell/NotConnected.tsx'

export function App() {
  const [client, setClient] = useState<ClientResolution>()
  useEffect(() => {
    void resolveClient().then((resolved) => {
      // Mounted under Hermes: connect if this browser's Hermes session is
      // signed in; otherwise the link says signed-out and sign-in shows.
      // A failure to start shows on the link, not here.
      if (resolved.kind === 'hermes') resolved.api.start().catch(() => undefined)
      setClient(resolved)
    })
  }, [])
  if (!client) return null
  if (client.kind === 'unavailable') return <NotConnected />
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
