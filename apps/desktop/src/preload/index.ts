/**
 * Sandboxed preload. Exposes exactly one object, `window.cindlDesktop`
 * (`DesktopBridge`), and only on the app's own origin. It forwards calls on
 * the desktop channels; the main process validates every one of them. No
 * Node or Electron API is reachable from the renderer.
 */
import {
  desktopChannels,
  type CindlErrorShape,
  type CindlEvent,
  type DesktopBridge,
} from '@cindl/contracts'
import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeReply } from '../shared/bridge.ts'
import { APP_HOST, APP_SCHEME } from '../shared/origin.ts'

type Listener = (event: CindlEvent) => void
const listeners = new Set<Listener>()

ipcRenderer.on(desktopChannels.event, (_event, payload: CindlEvent) => {
  for (const listener of [...listeners]) {
    try {
      listener(payload)
    } catch (error) {
      // One failing listener must not stop delivery to the others.
      queueMicrotask(() => {
        throw error
      })
    }
  }
})

/**
 * A failed call rejects with a plain `CindlErrorShape`, not an Error:
 * contextBridge copies Error objects with their message only (name, code,
 * detail and cause are dropped), and the renderer needs the code, e.g. to
 * tell an edit conflict from a failure. The renderer revives it into a
 * CindlError.
 */
function rejection(shape: CindlErrorShape): CindlErrorShape & { name: 'CindlError' } {
  return {
    name: 'CindlError',
    code: shape.code,
    message: shape.message,
    ...(shape.detail === undefined ? {} : { detail: shape.detail }),
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as BridgeReply<T>
  if (reply.ok) return reply.value
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- see `rejection`
  throw rejection(reply.error)
}

const platform: DesktopBridge['platform'] =
  process.platform === 'darwin' || process.platform === 'win32'
    ? process.platform
    : 'linux'

const bridge: DesktopBridge = {
  kind: 'cindl-desktop',
  bridgeVersion: 1,
  platform,
  call: (name, args) => invoke(desktopChannels.call, name, args),
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    listeners.add(listener)
    // Main answers with a snapshot of the current state, then live events.
    ipcRenderer.send(desktopChannels.event, 'subscribe')
    return () => {
      if (listeners.delete(listener) && listeners.size === 0)
        ipcRenderer.send(desktopChannels.event, 'unsubscribe')
    }
  },
  saveText: (suggestedName, content) =>
    invoke(desktopChannels.saveText, suggestedName, content),
  openExternal: (url) => invoke(desktopChannels.openExternal, url),
}

if (location.protocol === `${APP_SCHEME}:` && location.host === APP_HOST) {
  contextBridge.exposeInMainWorld('cindlDesktop', bridge)
  // Cindl uses no WebRTC, and the CSP cannot restrict it: take it away from
  // page script before any runs. (Main also routes it to a dead proxy.)
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
          Reflect.deleteProperty(globalThis, name)
      },
    })
  } catch {
    // Older Electron without executeInMainWorld: the dead proxy still applies.
  }
}
