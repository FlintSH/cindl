import { CindlProvider } from '@cindl/client-react'
import { useEffect, useState } from 'react'
import { resolveClient, type ClientResolution } from './platform/client.ts'
import { AppShell } from './shell/AppShell.tsx'
import { ErrorBoundary } from './shell/ErrorBoundary.tsx'
import { NotConnected } from './shell/NotConnected.tsx'

export function App() {
  const [client, setClient] = useState<ClientResolution>()
  useEffect(() => {
    void resolveClient().then(setClient)
  }, [])
  if (!client) return null
  if (client.kind === 'unavailable') return <NotConnected />
  return (
    <ErrorBoundary label="Cindl">
      <CindlProvider api={client.api}>
        <AppShell />
      </CindlProvider>
    </ErrorBoundary>
  )
}
