import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { redactText } from '@cindl/hermes-adapter'
import {
  auditTargets,
  find,
  findTappable,
  keepCapture,
  label,
  onlyApp,
  onlyAppInFront,
  parseKeyboard,
  parseUi,
  rawPixel,
  tapPoint,
  type KeyboardState,
  type Match,
  type TargetAudit,
  type UiNode,
} from './ui.ts'

export const PACKAGE = 'dev.fl1nt.cindl'

/**
 * adb against the single emulator CI starts; `adb` comes from the pinned
 * platform-tools. `scrub` runs over every text taken from the device that the
 * run keeps (UI dumps, log lines in a health report); by default the adapter's
 * redactText.
 */
export function createDevice(options: {
  adb: string
  out: string
  scrub?: (text: string) => string
}) {
  const scrub = options.scrub ?? redactText
  const run = (args: string[], timeoutMs = 60_000) =>
    execFileSync(options.adb, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  const shell = (command: string, timeoutMs?: number) =>
    run(['shell', command], timeoutMs)
  let lastXml = ''
  let lastRoot: UiNode | undefined
  let shots = 0

  /** A uiautomator dump's XML, retried while the device has none to give. */
  const hierarchy = async (flags: string): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        shell(`uiautomator dump ${flags}/sdcard/cindl-ui.xml`, 30_000)
        const xml = run(['exec-out', 'cat', '/sdcard/cindl-ui.xml'])
        if (xml.includes('<hierarchy')) return xml
      } catch (error) {
        if (attempt >= 6) throw error
      }
      if (attempt >= 6) throw new Error('uiautomator dump returned no hierarchy')
      await sleep(1000)
    }
  }

  const dump = async (): Promise<UiNode> => {
    lastXml = await hierarchy('')
    lastRoot = parseUi(lastXml)
    return lastRoot
  }

  /**
   * What TalkBack is given: a dump of only the views important for
   * accessibility (`--compressed`). It is not the last dump the other helpers
   * read, nor the one kept beside a screenshot.
   */
  const accessibilityDump = async (): Promise<{ root: UiNode; xml: string }> => {
    const xml = await hierarchy('--compressed ')
    return { root: parseUi(xml), xml }
  }

  /** A dump as a file in the output directory, scrubbed, only when it shows Cindl alone. */
  const keepDump = (
    name: string,
    { root, xml }: { root: UiNode; xml: string },
  ): string | undefined => {
    if (!onlyApp(root, PACKAGE)) return undefined
    shots += 1
    const file = `${String(shots).padStart(2, '0')}-${name}.xml`
    writeFileSync(join(options.out, file), scrub(xml))
    return file
  }

  /** Slow emulators sometimes show "… isn't responding" for system UI; keep waiting. */
  const dismissNotResponding = async (root: UiNode) => {
    const dialog = find(root, /isn.t responding$/)
    const wait = dialog && find(root, (text, node) => text === 'Wait' && node.clickable)
    if (!dialog || !wait || dialog.pkg === PACKAGE) return false
    await tapNode(wait)
    return true
  }

  const waitFor = async (match: Match, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const root = await dump()
      const node = find(root, match)
      if (node) return { root, node }
      if (await dismissNotResponding(root)) continue
      if (Date.now() > deadline)
        throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`)
      await sleep(750)
    }
  }

  /** Like waitFor, but scrolls the screen's content up step by step to reveal what is below. */
  /**
   * Scrolls the screen's content up in small steps until a node matching
   * `match` can be tapped (visible and not under an overlay), and returns it
   * with the point to tap. Being in the dump is not enough: UI Automator keeps
   * nodes that are scrolled out of view, with empty or inverted bounds.
   */
  const reveal = async (match: Match, what: string) => {
    for (let swipe = 0; swipe <= 10; swipe++) {
      const root = await dump()
      const hit = findTappable(root, match)
      if (hit) return { root, ...hit }
      const { right, bottom } = root.children[0]?.bounds ?? { right: 1080, bottom: 2400 }
      const x = Math.round(right / 2)
      shell(
        `input swipe ${x} ${Math.round(bottom * 0.6)} ${x} ${Math.round(bottom * 0.45)} 400`,
      )
      await sleep(900)
    }
    throw new Error(`Could not scroll ${what} to a place where it can be tapped`)
  }

  const waitUntilGone = async (match: Match, what: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const root = await dump()
      if (!find(root, match)) return root
      if (Date.now() > deadline)
        throw new Error(`${what} still on screen after ${timeoutMs / 1000}s`)
      await sleep(750)
    }
  }

  const tapAt = async (point: { x: number; y: number }) => {
    shell(`input tap ${point.x} ${point.y}`)
    await sleep(900)
  }

  /** Taps a node from the latest dump, only where the tap reaches it. */
  async function tapNode(node: UiNode) {
    const point = lastRoot ? tapPoint(lastRoot, node) : undefined
    if (!point)
      throw new Error(
        `"${label(node)}" is off screen or covered, so nothing was tapped (bounds ${JSON.stringify(node.bounds)})`,
      )
    await tapAt(point)
  }

  /** Waits until a node matching `match` can be tapped, then taps it. */
  const tap = async (match: Match, what: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const root = await dump()
      const hit = findTappable(root, match)
      if (hit) return tapAt(hit.point)
      if (await dismissNotResponding(root)) continue
      if (Date.now() > deadline)
        throw new Error(`Timed out after ${timeoutMs / 1000}s waiting to tap ${what}`)
      await sleep(750)
    }
  }

  /** `input text` needs spaces as %s and shell metacharacters escaped. */
  const type = async (value: string) => {
    if (!/^[\w .:/@-]*$/.test(value))
      throw new Error(`Unsupported characters in "${value}"`)
    shell(`input text '${value.replace(/ /g, '%s')}'`)
    await sleep(600)
  }

  /** Deletes up to `count` characters before the cursor, after moving it to the end. */
  const clearText = async (count: number) => {
    shell('input keyevent KEYCODE_MOVE_END')
    if (count > 0) shell(`input keyevent ${Array(count).fill('KEYCODE_DEL').join(' ')}`)
    await sleep(600)
  }

  const key = async (code: string) => {
    shell(`input keyevent ${code}`)
    await sleep(900)
  }

  /** What has focus (`dumpsys window`); undefined when the device does not say. */
  const focus = () => {
    try {
      return shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp" || true')
    } catch {
      return undefined
    }
  }

  /**
   * A screenshot, as a file in the output directory, only when it can show
   * nothing but Cindl: Cindl's own window in focus just before the capture
   * and, unchanged, just after it (ui.ts keepCapture). Another app in front
   * (the browser during sign-in) can show a sign-in code or state in its
   * address bar and pages. Otherwise, or when the device does not say,
   * nothing is kept and this returns undefined. The last UI dump is kept
   * beside it only when it, too, shows Cindl alone.
   */
  const screenshot = (name: string): string | undefined => {
    const before = focus()
    if (before === undefined || !onlyAppInFront(before, PACKAGE)) return undefined
    const png = execFileSync(options.adb, ['exec-out', 'screencap', '-p'], {
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const after = focus()
    if (after === undefined || !keepCapture(before, after, PACKAGE)) return undefined
    shots += 1
    const file = `${String(shots).padStart(2, '0')}-${name}`
    writeFileSync(join(options.out, `${file}.png`), png)
    if (lastXml && lastRoot && onlyApp(lastRoot, PACKAGE))
      writeFileSync(join(options.out, `${file}.xml`), scrub(lastXml))
    return `${file}.png`
  }

  /** One device pixel, from a raw screen capture (no PNG to decode). */
  const pixel = (x: number, y: number) =>
    rawPixel(
      new Uint8Array(
        execFileSync(options.adb, ['exec-out', 'screencap'], {
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        }),
      ),
      x,
      y,
    )

  const pid = () => shell(`pidof ${PACKAGE} || true`).trim()

  const density = () => {
    const output = shell('wm density')
    const value =
      /Override density: (\d+)/.exec(output) ?? /Physical density: (\d+)/.exec(output)
    return Number(value?.[1] ?? 160)
  }

  const audit = async (root?: UiNode): Promise<TargetAudit> =>
    auditTargets(root ?? (await dump()), { pkg: PACKAGE, density: density() })

  const keyboard = (): KeyboardState =>
    parseKeyboard(shell('dumpsys window InputMethod'), shell('dumpsys input_method'))

  const launch = () => {
    shell(`am start -W -n ${PACKAGE}/.MainActivity`, 90_000)
  }

  /** Crashes of this app (crash buffer) or JavaScript errors it logged since the last clear. */
  const health = (): string[] => {
    const problems: string[] = []
    const crash = shell('logcat -d -b crash')
    if (crash.includes(`Process: ${PACKAGE}`))
      problems.push('the app crashed (logcat crash buffer)')
    const log = shell('logcat -d -s ReactNativeJS:E AndroidRuntime:E')
    for (const line of log.split('\n'))
      if (
        /JavascriptException|TypeError|ReferenceError|RangeError|Invariant Violation|Unhandled promise rejection|FATAL EXCEPTION/.test(
          line,
        )
      )
        problems.push(scrub(line.trim()).slice(0, 300))
    return problems
  }

  return {
    run,
    shell,
    dump,
    accessibilityDump,
    keepDump,
    waitFor,
    reveal,
    tapAt,
    waitUntilGone,
    tap,
    tapNode,
    type,
    clearText,
    key,
    screenshot,
    pixel,
    pid,
    density,
    audit,
    keyboard,
    launch,
    health,
    lastXml: () => lastXml,
  }
}

export type Device = ReturnType<typeof createDevice>
