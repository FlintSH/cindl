import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeHermes } from '@cindl/fixtures/fake-hermes'
import { redactText } from '@cindl/hermes-adapter'

/** A value the run hands out or receives that must not leave the runner. */
export type SecretKind =
  'access token' | 'refresh token' | 'ticket' | 'code' | 'state' | 'verifier'

/**
 * The run's secrets: every token, ticket and sign-in code the fake Hermes and
 * the auth stand-in issue, and every state and PKCE verifier they receive
 * (all synthetic, and all still values a run must not publish). Text that
 * leaves the runner (device logs, UI dumps, report lines) goes through `scrub`
 * first: each value becomes a placeholder naming its kind, then the adapter's
 * redactText masks anything else shaped like a credential.
 */
export class RunSecrets {
  readonly #kinds = new Map<string, SecretKind>()

  add(kind: SecretKind, value: string | null | undefined): void {
    // These servers issue long random values; a short string would match ordinary text.
    if (value && value.length >= 8) this.#kinds.set(value, kind)
  }

  get size(): number {
    return this.#kinds.size
  }

  /** The values of these kinds, for searching the app's storage. */
  values(...kinds: SecretKind[]): string[] {
    return [...this.#kinds].flatMap(([value, kind]) =>
      kinds.includes(kind) ? [value] : [],
    )
  }

  /** The kinds of secret `text` holds, once each, sorted. */
  found(text: string): SecretKind[] {
    const kinds = new Set<SecretKind>()
    for (const [value, kind] of this.#kinds) if (text.includes(value)) kinds.add(kind)
    return [...kinds].sort()
  }

  /**
   * `text` with every secret replaced by `[issued-<kind>]` (no spaces, so it
   * stays one word in a URL, an XML attribute or JSON), then through redactText.
   */
  scrub(text: string): string {
    let out = text
    // Longest first, so a value inside another never leaves part of it behind.
    for (const [value, kind] of [...this.#kinds].sort(([a], [b]) => b.length - a.length))
      out = out.replaceAll(value, `[issued-${kind.replaceAll(' ', '-')}]`)
    return redactText(out)
  }
}

/**
 * The UID a `logcat -v threadtime -v uid` line was logged under (Android
 * prints it before the pid as a number, or a short user name such as
 * `root`), or undefined when the line has another shape.
 */
export function logcatUid(line: string): string | undefined {
  return /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+([\w-]+):\s*\d+\s+\d+\s+[VDIWEFAS]\s/.exec(
    line,
  )?.[1]
}

/**
 * The lines of a device log that count as the app's: those logged under its
 * UID, and any line whose UID cannot be read (logcat's `--------- beginning
 * of` headers aside), so a line of an unknown shape is never let through.
 * Without the UID, every line counts.
 */
export function ownLines(raw: string, uid: string | undefined): string[] {
  const lines = raw.split('\n')
  if (uid === undefined) return lines
  return lines.filter((line) => {
    if (line.startsWith('--------- ')) return false
    const of = logcatUid(line)
    return of === undefined ? line.trim().length > 0 : of === uid
  })
}

/**
 * The device logs of a run. Each is written only scrubbed, every line of it,
 * and kept raw in memory (never on disk), so the run can say which held a
 * secret in the app's own lines (`ownLines`), including one learned after the
 * log was written; `rewrite` then scrubs the files again with everything
 * known. Other processes' lines do not count: Android's window manager logs
 * the link the app opened in the browser, state and all (CI run 41656607631).
 */
export class DeviceLogs {
  readonly #dir: string
  readonly #secrets: RunSecrets
  readonly #logs: Array<{ file: string; raw: string; uid: string | undefined }> = []

  constructor(dir: string, secrets: RunSecrets) {
    this.#dir = dir
    this.#secrets = secrets
  }

  get count(): number {
    return this.#logs.length
  }

  /** Keeps a log read with `-v uid`; `uid` is the app's (undefined: every line counts). */
  keep(file: string, raw: string, uid?: string): void {
    this.#logs.push({ file, raw, uid })
    writeFileSync(join(this.#dir, file), this.#secrets.scrub(raw))
  }

  /** Each log whose own lines held a secret, with the kinds (never the values). */
  holding(): Array<{ file: string; kinds: SecretKind[] }> {
    return this.#logs.flatMap(({ file, raw, uid }) => {
      const kinds = this.#secrets.found(ownLines(raw, uid).join('\n'))
      return kinds.length ? [{ file, kinds }] : []
    })
  }

  /** How many lines the logs hold under the app's UID (none means nothing was checked). */
  attributed(): number {
    return this.#logs.reduce(
      (sum, { raw, uid }) =>
        sum +
        (uid === undefined
          ? 0
          : raw.split('\n').filter((line) => logcatUid(line) === uid).length),
      0,
    )
  }

  rewrite(): void {
    for (const { file, raw } of this.#logs)
      writeFileSync(join(this.#dir, file), this.#secrets.scrub(raw))
  }
}

/**
 * Adds every secret the fake Hermes issues or receives to `secrets`: sessions
 * (sign-in and each refresh), gateway and screen tickets, the app's state and
 * the fake's broker state, sign-in codes, and the PKCE verifier the app sends
 * with the code. The fake keeps working as before.
 */
export function watchFakeHermes(auth: FakeHermes['auth'], secrets: RunSecrets): void {
  const mintSession = auth.mintSession.bind(auth)
  auth.mintSession = () => {
    const session = mintSession()
    secrets.add('access token', session.accessToken)
    secrets.add('refresh token', session.refreshToken)
    return session
  }
  const mintTicket = auth.mintTicket.bind(auth)
  auth.mintTicket = (info) => {
    const ticket = mintTicket(info)
    secrets.add('ticket', ticket)
    return ticket
  }
  const registerPending = auth.registerPending.bind(auth)
  auth.registerPending = (challenge, redirectUri, clientState) => {
    secrets.add('state', clientState)
    const brokerState = registerPending(challenge, redirectUri, clientState)
    secrets.add('state', brokerState)
    return brokerState
  }
  const completePending = auth.completePending.bind(auth)
  auth.completePending = (brokerState) => {
    const location = completePending(brokerState)
    if (location !== undefined)
      secrets.add('code', new URL(location).searchParams.get('code'))
    return location
  }
  const redeem = auth.redeem.bind(auth)
  auth.redeem = (code, verifier) => {
    secrets.add('verifier', verifier)
    return redeem(code, verifier)
  }
}
