import { createStore, type ClientState } from '@cindl/client-core'
import type { CindlClientApi, CindlEvent, LinkState } from '@cindl/contracts'
import { snapshotEvents } from './snapshot.ts'

export interface EventSink {
  send(event: CindlEvent): void
  /** False once the window is gone or no longer shows the app origin. */
  alive(): boolean
}

export interface ClientHost {
  call: CindlClientApi['call']
  /** Starts delivery to a renderer: snapshot first, then live events. */
  attach(id: number, sink: EventSink): void
  detach(id: number): void
  getState(): ClientState
  dispose(): void
}

const bootLink = (now: () => number): LinkState => ({
  phase: 'connecting',
  since: new Date(now()).toISOString(),
  connectionEpoch: 0,
})

/**
 * Owns the main process's CindlClientApi (the direct Hermes client, or the
 * labelled demo) and fans its events out to subscribed windows. A mirror
 * store, fed by the same pure reducer the renderer uses, provides snapshots.
 */
export function createClientHost(options: {
  client: CindlClientApi
  /** Extra events every new subscriber receives after the snapshot (e.g. platform warnings). */
  notices?: () => CindlEvent[]
  now?: () => number
}): ClientHost {
  const store = createStore(bootLink(options.now ?? Date.now))
  const sinks = new Map<number, EventSink>()

  const deliver = (sink: EventSink, event: CindlEvent) => {
    if (sink.alive()) sink.send(event)
  }

  const stop = options.client.subscribe((event) => {
    store.dispatch(event)
    for (const [id, sink] of sinks) {
      if (!sink.alive()) sinks.delete(id)
      else sink.send(event)
    }
  })

  return {
    call: (name, args) => options.client.call(name, args),
    attach(id, sink) {
      sinks.set(id, sink)
      for (const event of snapshotEvents(store.getState())) deliver(sink, event)
      for (const event of options.notices?.() ?? []) deliver(sink, event)
    },
    detach(id) {
      sinks.delete(id)
    },
    getState: () => store.getState(),
    dispose() {
      stop()
      sinks.clear()
    },
  }
}
