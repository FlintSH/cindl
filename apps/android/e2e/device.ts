import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  auditTargets,
  center,
  find,
  parseKeyboard,
  parseUi,
  tapTarget,
  type KeyboardState,
  type Match,
  type TargetAudit,
  type UiNode,
} from './ui.ts'

export const PACKAGE = 'dev.fl1nt.cindl'

/** adb against the single emulator CI starts; `adb` comes from the pinned platform-tools. */
export function createDevice(options: { adb: string; out: string }) {
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
  let shots = 0

  const dump = async (): Promise<UiNode> => {
    for (let attempt = 1; ; attempt++) {
      try {
        shell('uiautomator dump /sdcard/cindl-ui.xml', 30_000)
        lastXml = run(['exec-out', 'cat', '/sdcard/cindl-ui.xml'])
        if (lastXml.includes('<hierarchy')) return parseUi(lastXml)
      } catch (error) {
        if (attempt >= 6) throw error
      }
      if (attempt >= 6) throw new Error('uiautomator dump returned no hierarchy')
      await sleep(1000)
    }
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
  const reveal = async (match: Match, what: string) => {
    for (let swipe = 0; swipe <= 6; swipe++) {
      const root = await dump()
      const node = find(root, match)
      if (node) return { root, node }
      const { right, bottom } = root.children[0]?.bounds ?? { right: 1080, bottom: 2400 }
      const x = Math.round(right / 2)
      shell(
        `input swipe ${x} ${Math.round(bottom * 0.62)} ${x} ${Math.round(bottom * 0.38)} 400`,
      )
      await sleep(900)
    }
    return waitFor(match, what, 5_000)
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

  async function tapNode(node: UiNode) {
    const { x, y } = center(tapTarget(node).bounds)
    shell(`input tap ${x} ${y}`)
    await sleep(900)
  }

  const tap = async (match: Match, what: string, timeoutMs?: number) => {
    const { node } = await waitFor(match, what, timeoutMs)
    await tapNode(node)
  }

  /** `input text` needs spaces as %s and shell metacharacters escaped. */
  const type = async (value: string) => {
    if (!/^[\w .:/@-]*$/.test(value))
      throw new Error(`Unsupported characters in "${value}"`)
    shell(`input text '${value.replace(/ /g, '%s')}'`)
    await sleep(600)
  }

  const key = async (code: string) => {
    shell(`input keyevent ${code}`)
    await sleep(900)
  }

  const screenshot = (name: string): string => {
    shots += 1
    const file = `${String(shots).padStart(2, '0')}-${name}`
    const png = execFileSync(options.adb, ['exec-out', 'screencap', '-p'], {
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    writeFileSync(join(options.out, `${file}.png`), png)
    if (lastXml) writeFileSync(join(options.out, `${file}.xml`), lastXml)
    return `${file}.png`
  }

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
        problems.push(line.trim().slice(0, 300))
    return problems
  }

  return {
    run,
    shell,
    dump,
    waitFor,
    reveal,
    waitUntilGone,
    tap,
    tapNode,
    type,
    key,
    screenshot,
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
