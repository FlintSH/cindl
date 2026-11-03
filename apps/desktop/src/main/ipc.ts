import {
  isCindlError,
  isOpName,
  parseOpArgs,
  type CindlClientApi,
  type CindlErrorShape,
  type OpArgs,
  type OpName,
} from '@cindl/contracts'
import { redactText } from '@cindl/hermes-adapter'
import { isEventSignal, type BridgeReply, type EventSignal } from '../shared/bridge.ts'
import type { Logger } from './log.ts'
import { APP_HOST, APP_ORIGIN, APP_SCHEME } from './protocol.ts'

/** The parts of Electron's IPC event that sender validation looks at. */
export interface IpcSenderFrame {
  readonly url: string
  readonly origin: string
  readonly parent: unknown
}
export interface IpcEventLike {
  readonly sender: { readonly id: number }
  readonly senderFrame: IpcSenderFrame | null
}

/**
 * True only for the top-level frame of a page served from `app://cindl`.
 * Subframes, other schemes and hosts, opaque origins and frames that already
 * navigated away (`senderFrame === null`) are all refused.
 */
export function isAppFrame(frame: IpcSenderFrame | null | undefined): boolean {
  if (!frame || frame.parent !== null || frame.origin !== APP_ORIGIN) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.host === APP_HOST &&
    url.username === '' &&
    url.password === ''
  )
}

export function isTrustedSender(
  event: IpcEventLike,
  trustedContentsId: number | undefined,
): boolean {
  return (
    trustedContentsId !== undefined &&
    event.sender.id === trustedContentsId &&
    isAppFrame(event.senderFrame)
  )
}

/** Largest text the renderer may hand to the native save dialog (UTF-16 units). */
export const MAX_SAVE_TEXT_LENGTH = 20_000_000
const MAX_FILE_NAME_LENGTH = 120
const FALLBACK_FILE_NAME = 'cindl-export.txt'

/**
 * Reduces a renderer-suggested file name to a plain base name. The renderer
 * never chooses a directory: the owner does, in the native dialog.
 */
export function sanitizeFileName(input: string): string {
  const base = input.split(/[\\/]/).at(-1) ?? ''
  const cleaned = base
    // Controls, characters Windows forbids, and bidi overrides that could
    // disguise the extension shown in the dialog.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  const trimmed = cleaned.slice(0, MAX_FILE_NAME_LENGTH).trim()
  return trimmed === '' ? FALLBACK_FILE_NAME : trimmed
}

const forbidden: BridgeReply<never> = {
  ok: false,
  error: { code: 'forbidden', message: 'This window may not use Cindl.' },
}

const invalid = (message: string, detail?: string): BridgeReply<never> => ({
  ok: false,
  error:
    detail === undefined
      ? { code: 'invalid', message }
      : { code: 'invalid', message, detail },
})

/** Zod errors are recognised by shape so the desktop app does not depend on zod directly. */
function issuePaths(error: unknown): string | undefined {
  const issues = (error as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return undefined
  return issues
    .slice(0, 5)
    .map((issue: { path?: unknown; code?: unknown }) => {
      const where = Array.isArray(issue.path) ? issue.path.map(String).join('.') : ''
      return `${where || '(root)'}: ${String(issue.code)}`
    })
    .join('; ')
}

/** Converts anything a client throws into the shape the renderer may see. */
export function toErrorShape(error: unknown, log?: Logger): CindlErrorShape {
  if (isCindlError(error)) {
    const shape = error.toJSON()
    return {
      code: shape.code,
      message: redactText(shape.message),
      ...(shape.detail === undefined ? {} : { detail: redactText(shape.detail) }),
    }
  }
  log?.error('Unexpected error in a Cindl operation', error)
  return { code: 'internal', message: 'Cindl could not complete that request.' }
}

export interface IpcDeps {
  /** webContents id of the one window allowed to talk to main. */
  trustedContentsId(): number | undefined
  client: Pick<CindlClientApi, 'call'>
  saveText(fileName: string, content: string): Promise<{ saved: boolean }>
  /** Validates the URL itself (see external.ts); never throws. */
  openExternal(url: unknown): Promise<{ opened: boolean }>
  /** The renderer started or stopped listening on `desktopChannels.event`. */
  onEventSignal(contentsId: number, signal: EventSignal): void
  log: Logger
}

/**
 * Handlers for the desktop channels. Each one checks the sender first, then
 * the exact argument shape; nothing reaches the client unvalidated.
 */
export function createIpcHandlers(deps: IpcDeps) {
  const { log } = deps
  const trusted = (event: IpcEventLike, channel: string): boolean => {
    if (isTrustedSender(event, deps.trustedContentsId())) return true
    log.warn('Refused IPC from an untrusted sender', {
      channel,
      contentsId: event.sender.id,
      origin: event.senderFrame?.origin ?? null,
    })
    return false
  }

  return {
    call: async (
      event: IpcEventLike,
      ...args: unknown[]
    ): Promise<BridgeReply<unknown>> => {
      if (!trusted(event, 'call')) return forbidden
      if (args.length !== 2)
        return invalid('Expected an operation name and its arguments.')
      const [name, input] = args
      if (!isOpName(name)) return invalid('Unknown Cindl operation.')
      let parsed: OpArgs<OpName>
      try {
        // The parsed value, not the raw input, goes on: unknown keys are dropped.
        parsed = parseOpArgs(name, input)
      } catch (error) {
        // Contract v4: parseOpArgs throws CindlError('invalid') whose message
        // says nothing was sent and whose detail names the field, not its value.
        return isCindlError(error)
          ? { ok: false, error: toErrorShape(error, log) }
          : invalid(`Invalid arguments for ${name}.`, issuePaths(error))
      }
      try {
        return { ok: true, value: await deps.client.call(name, parsed) }
      } catch (error) {
        return { ok: false, error: toErrorShape(error, log) }
      }
    },

    saveText: async (
      event: IpcEventLike,
      ...args: unknown[]
    ): Promise<BridgeReply<{ saved: boolean }>> => {
      if (!trusted(event, 'saveText')) return forbidden
      const [name, content] = args
      if (args.length !== 2 || typeof name !== 'string' || typeof content !== 'string')
        return invalid('Expected a file name and text to save.')
      if (content.length > MAX_SAVE_TEXT_LENGTH)
        return invalid('That text is too large to save from Cindl.')
      try {
        return { ok: true, value: await deps.saveText(sanitizeFileName(name), content) }
      } catch (error) {
        log.error('Saving text failed', error)
        return {
          ok: false,
          error: { code: 'internal', message: 'The file could not be saved.' },
        }
      }
    },

    openExternal: async (
      event: IpcEventLike,
      ...args: unknown[]
    ): Promise<BridgeReply<{ opened: boolean }>> => {
      if (!trusted(event, 'openExternal')) return forbidden
      if (args.length !== 1) return invalid('Expected one URL.')
      return { ok: true, value: await deps.openExternal(args[0]) }
    },

    eventSignal: (event: IpcEventLike, ...args: unknown[]): void => {
      if (!trusted(event, 'event')) return
      const [signal] = args
      if (args.length !== 1 || !isEventSignal(signal)) {
        log.warn('Ignored an unknown event signal from the renderer')
        return
      }
      deps.onEventSignal(event.sender.id, signal)
    },
  }
}

export type IpcHandlers = ReturnType<typeof createIpcHandlers>
