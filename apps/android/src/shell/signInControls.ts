import { createContext, useContext } from 'react'

/** What the sign-in screen may do besides calling the client: stop waiting for the browser. */
export interface SignInControls {
  cancel: () => void
}

const SignInControlsContext = createContext<SignInControls | undefined>(undefined)

export const SignInControlsProvider = SignInControlsContext.Provider

/** Undefined in the demo, which never signs in. */
export const useSignInControls = () => useContext(SignInControlsContext)
