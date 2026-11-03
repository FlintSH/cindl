import { createContext, useContext } from 'react'
import type { ClientResolution } from './client.ts'

/** Which client this page runs: it decides how signing in works. */
export type ClientKind = Exclude<ClientResolution['kind'], 'unavailable'>

export const ClientKindContext = createContext<ClientKind>('desktop')

export const useClientKind = () => useContext(ClientKindContext)
