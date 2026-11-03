import type { WebSocketFactory, WebSocketLike } from '@cindl/client-core'
import { GATEWAY_SUBPROTOCOL, ticketSubprotocol } from '@cindl/hermes-adapter'
import { isAllowedHermesUrl } from './origin.ts'

export type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike

/**
 * WebSocketFactory on React Native's WebSocket (OkHttp). The Hermes ticket
 * travels as a subprotocol (`hermes-gateway-ticket.<ticket>`), never in the
 * URL, so it stays out of access logs; treat both protocol strings as
 * secrets in diagnostics (redact with @cindl/hermes-adapter).
 */
export function createWebSocketFactory(Socket: WebSocketConstructor): WebSocketFactory {
  return (url, protocols) => {
    if (!isAllowedHermesUrl(url))
      throw new Error('Refusing a WebSocket to a non-https, non-loopback address.')
    return new Socket(url, protocols)
  }
}

/** Subprotocols for Hermes `/api/ws` with a freshly minted single-use ticket. */
export function gatewayProtocols(ticket: string): string[] {
  return [GATEWAY_SUBPROTOCOL, ticketSubprotocol(ticket)]
}
