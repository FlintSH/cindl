/**
 * Launch smoke tests of both desktop flavours, driven by Playwright.
 *
 *   CINDL_SMOKE_REAL         packaged real app (AppImage or binary) to launch;
 *                            unset = the unpacked build in apps/desktop/dist
 *   CINDL_SMOKE_DEMO         packaged Cindl Demo; unset = apps/desktop/dist-demo
 *   CINDL_SMOKE_HEADLESS=1   add --ozone-platform=headless and a 1440x900 screen
 *                            (no X server needed)
 *   CINDL_SMOKE_SANDBOX=1    keep Chromium's OS sandbox on (Playwright otherwise
 *                            adds --no-sandbox on Linux, and the app then needs
 *                            CINDL_UNSAFE_NO_SANDBOX=1, which these tests set)
 *   CINDL_SMOKE_ARTIFACTS    directory for the reviewed demo screenshot
 *
 * Every launch gets a fresh --user-data-dir, so it never touches a real profile.
 * Data shown is the SYNTHETIC scenario (Cindl Demo) or the signed-out state.
 */
import {
  DEMO_PRODUCT_NAME,
  SYNTHETIC_DEMO_LABEL,
  SYNTHETIC_DEMO_NOTICE,
} from '@cindl/contracts'
import { SYNTHETIC_FIXTURE_MARKERS } from '@cindl/fixtures/markers'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as Electron from 'electron'

const appDir = path.resolve(import.meta.dirname, '..')
const env = process.env
const sandboxed = env.CINDL_SMOKE_SANDBOX === '1'
const BRIDGE_KEYS = [
  'bridgeVersion',
  'call',
  'kind',
  'openExternal',
  'platform',
  'saveText',
  'subscribe',
]

/** What the renderer sees on `window`, as far as these tests use it. */
interface BridgeWindow {
  cindlDesktop: {
    call(name: string, args: unknown): Promise<unknown>
    openExternal(url: string): Promise<{ opened: boolean }>
  }
}

type Flavour = 'real' | 'demo'

function target(flavour: Flavour) {
  const packaged = flavour === 'real' ? env.CINDL_SMOKE_REAL : env.CINDL_SMOKE_DEMO
  if (packaged)
    return { executablePath: packaged, appArgs: [] as string[], packaged: true }
  return {
    executablePath: createRequire(import.meta.url)('electron') as string,
    appArgs: [flavour === 'real' ? 'dist' : 'dist-demo'],
    packaged: false,
  }
}

const displayArgs = () =>
  // Headless ozone reports a 1x1 screen unless told otherwise, and has no GL
  // display: software compositing avoids a failing GPU process start.
  env.CINDL_SMOKE_HEADLESS === '1'
    ? [
        '--ozone-platform=headless',
        '--ozone-override-screen-size=1440,900',
        '--disable-gpu',
      ]
    : []

function childEnv(executablePath: string, options: { allowUnsandboxed: boolean }) {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !key.startsWith('CINDL_')) result[key] = value
  if (env.CINDL_LOG) result.CINDL_LOG = env.CINDL_LOG
  if (options.allowUnsandboxed) result.CINDL_UNSAFE_NO_SANDBOX = '1'
  // AppImages normally mount with FUSE; extracting avoids needing it on CI.
  if (executablePath.endsWith('.AppImage')) result.APPIMAGE_EXTRACT_AND_RUN = '1'
  return result
}

interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
  packaged: boolean
}

async function launch(flavour: Flavour): Promise<Launched> {
  const userData = mkdtempSync(path.join(tmpdir(), 'cindl-smoke-'))
  const { executablePath, appArgs, packaged } = target(flavour)
  const app = await electron.launch({
    executablePath,
    args: [...appArgs, `--user-data-dir=${userData}`, ...displayArgs()],
    cwd: appDir,
    // Without the OS sandbox (no user namespaces here) Playwright passes
    // --no-sandbox, which the app refuses unless explicitly allowed.
    env: childEnv(executablePath, { allowUnsandboxed: !sandboxed }),
    chromiumSandbox: sandboxed,
    // An AppImage extracts itself (about 120 MB) on every start.
    timeout: 120_000,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData, packaged }
}

async function close(launched: Launched | undefined) {
  if (!launched) return
  await launched.app.close()
  rmSync(launched.userData, { recursive: true, force: true })
}

const filesUnder = (target: string): string[] =>
  statSync(target).isFile()
    ? [target]
    : readdirSync(target, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))

test.describe('Cindl (real flavour)', () => {
  let launched: Launched | undefined
  test.beforeAll(async () => {
    launched = await launch('real')
  })
  test.afterAll(() => close(launched))

  test('shows the honest signed-out state from app://cindl, without demo labels', async () => {
    const { app, page } = launched as Launched
    expect(page.url()).toBe('app://cindl/index.html')
    await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible()
    await expect(page.getByText(SYNTHETIC_DEMO_NOTICE)).toHaveCount(0)
    const identity = await app.evaluate(
      ({ app: electronApp, BrowserWindow }: typeof Electron) => ({
        name: electronApp.getName(),
        title: BrowserWindow.getAllWindows()[0]?.getTitle(),
      }),
    )
    expect(identity).toEqual({ name: 'Cindl', title: 'Cindl' })
    const state = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as BridgeWindow).cindlDesktop
      const link = (await bridge.call('link.get', {})) as {
        phase: string
        demo?: boolean
      }
      const capabilities = (await bridge.call('capabilities.get', {})) as Record<
        string,
        { state: string }
      >
      const code = async (name: string, args: unknown) => {
        try {
          await bridge.call(name, args)
          return 'resolved'
        } catch (error) {
          return (error as { code?: string }).code ?? 'no-code'
        }
      }
      return {
        phase: link.phase,
        demo: link.demo ?? false,
        states: [...new Set(Object.values(capabilities).map((c) => c.state))],
        signIn: await code('auth.signIn', { origin: 'https://hermes.example.test' }),
        plainHttp: await code('auth.signIn', { origin: 'http://hermes.example.test' }),
        signOut: await bridge.call('auth.signOut', {}),
      }
    })
    expect(state).toEqual({
      phase: 'unconfigured',
      demo: false,
      states: ['unknown'],
      signIn: 'unavailable',
      plainHttp: 'invalid',
      signOut: { localOnly: true },
    })
  })

  test('ships no synthetic fixture records, and keeps the label copy', async () => {
    const { app, packaged } = launched as Launched
    const where = await app.evaluate(({ app: electronApp }: typeof Electron) => ({
      resources: process.resourcesPath,
      appPath: electronApp.getAppPath(),
    }))
    const mainFiles = packaged
      ? [path.join(where.resources, 'app.asar')]
      : [path.join(where.appPath, 'main.cjs'), path.join(where.appPath, 'preload.cjs')]
    const renderer = packaged
      ? path.join(where.resources, 'renderer')
      : path.join(where.appPath, 'renderer')
    const scanned = [...mainFiles, ...filesUnder(renderer)]
    const hits = scanned.flatMap((file) => {
      const text = readFileSync(file).toString('latin1')
      return SYNTHETIC_FIXTURE_MARKERS.filter((marker) => text.includes(marker)).map(
        (marker) => `${file}: ${marker}`,
      )
    })
    const labelled = filesUnder(renderer).some((file) =>
      readFileSync(file, 'utf8').includes(SYNTHETIC_DEMO_NOTICE),
    )
    const directory = env.CINDL_SMOKE_ARTIFACTS ?? test.info().outputPath()
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      path.join(directory, 'marker-scan-real.json'),
      `${JSON.stringify({ packaged, scanned, markers: SYNTHETIC_FIXTURE_MARKERS, hits, labelled }, null, 2)}\n`,
    )
    expect(hits).toEqual([])
    expect(labelled).toBe(true)
  })

  test('captures the reviewed real-app screenshot', async () => {
    const { page } = launched as Launched
    await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible()
    await page.waitForTimeout(500)
    const scroll = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    }))
    expect(scroll.document).toBeLessThanOrEqual(scroll.viewport)
    const directory = env.CINDL_SMOKE_ARTIFACTS ?? test.info().outputPath()
    mkdirSync(directory, { recursive: true })
    await page.screenshot({ path: path.join(directory, 'desktop-real.png') })
  })

  test('exposes only window.cindlDesktop and no Node or Electron globals', async () => {
    const { page } = launched as Launched
    const globals = await page.evaluate(() => {
      const scope = globalThis as Record<string, unknown>
      const bridge = scope.cindlDesktop as Record<string, unknown> | undefined
      return {
        bridgeKeys: bridge ? Object.keys(bridge).sort() : null,
        kind: bridge?.kind,
        version: bridge?.bridgeVersion,
        require: typeof scope.require,
        process: typeof scope.process,
        module: typeof scope.module,
        buffer: typeof scope.Buffer,
        global: typeof scope.global,
        ipcRenderer: typeof scope.ipcRenderer,
        electron: typeof scope.electron,
      }
    })
    expect(globals).toEqual({
      bridgeKeys: BRIDGE_KEYS,
      kind: 'cindl-desktop',
      version: 1,
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      buffer: 'undefined',
      global: 'undefined',
      ipcRenderer: 'undefined',
      electron: 'undefined',
    })
  })

  test('runs with Chromium’s sandbox on', async () => {
    test.skip(!sandboxed, 'This host cannot start the sandbox; CI runs this with it on.')
    const { app } = launched as Launched
    const switches = await app.evaluate(({ app: electronApp }: typeof Electron) => ({
      noSandbox: electronApp.commandLine.hasSwitch('no-sandbox'),
      noZygote: electronApp.commandLine.hasSwitch('no-zygote-sandbox'),
    }))
    expect(switches).toEqual({ noSandbox: false, noZygote: false })
  })

  test('keeps developer tools closed in a packaged build', async () => {
    const { app, packaged } = launched as Launched
    test.skip(!packaged, 'Unpacked development builds allow developer tools.')
    const opened = await app.evaluate(async ({ BrowserWindow }: typeof Electron) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents) return 'no window'
      // Developer tools open asynchronously: isDevToolsOpened() straight after
      // openDevTools() is false even when they are allowed. Wait for them.
      const settled = new Promise<boolean>((resolve) => {
        contents.once('devtools-opened', () => resolve(true))
        setTimeout(() => resolve(contents.isDevToolsOpened()), 3_000)
      })
      contents.openDevTools({ mode: 'detach' })
      return settled
    })
    expect(opened).toBe(false)
  })

  test('serves the entry document with the strict CSP header and enforces it', async () => {
    const { app, page } = launched as Launched
    const headers = await app.evaluate(async ({ net }: typeof Electron) => {
      const response = await net.fetch('app://cindl/index.html')
      return Object.fromEntries(response.headers.entries())
    })
    const csp = headers['content-security-policy'] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-dns-prefetch-control']).toBe('off')
    const enforced = await page.evaluate(async (policy) => {
      const violations: string[] = []
      document.addEventListener('securitypolicyviolation', (event) =>
        violations.push(
          `${event.effectiveDirective} ${event.originalPolicy === policy ? 'header' : 'other'}`,
        ),
      )
      let fetched = 'allowed'
      try {
        await fetch('https://example.test/beacon')
      } catch {
        fetched = 'blocked'
      }
      // An injected inline script must not run (script-src 'self', no 'unsafe-inline').
      const injected = document.createElement('script')
      injected.textContent = 'document.documentElement.dataset.injected = "ran"'
      document.head.append(injected)
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        fetched,
        inline: document.documentElement.dataset.injected ?? 'blocked',
        violations,
      }
    }, csp)
    expect(enforced.fetched).toBe('blocked')
    expect(enforced.inline).toBe('blocked')
    expect(enforced.violations).toContain('connect-src header')
    expect(enforced.violations).toContain('script-src-elem header')
  })

  test('keeps WebRTC and other side channels away from the network', async () => {
    const { app, page } = launched as Launched
    const webrtc = await page.evaluate(() => ({
      peerConnection: typeof (globalThis as Record<string, unknown>).RTCPeerConnection,
      webkit: typeof (globalThis as Record<string, unknown>).webkitRTCPeerConnection,
    }))
    expect(webrtc).toEqual({ peerConnection: 'undefined', webkit: 'undefined' })
    // A same-origin child frame never gets the bridge. It does hand WebRTC
    // back: Electron runs no preload in about:blank child frames (a known gap,
    // docs/handbook/clients/desktop.md). This pins that, so a change in either
    // direction shows up here and the docs get updated.
    const framed = await page.evaluate(() => {
      const probe = (frame: HTMLIFrameElement) => {
        const child = frame.contentWindow as unknown as Record<string, unknown> | null
        return {
          peerConnection: typeof child?.RTCPeerConnection,
          webkit: typeof child?.webkitRTCPeerConnection,
          bridge: typeof child?.cindlDesktop,
        }
      }
      const frame = document.createElement('iframe')
      document.body.append(frame)
      const inner = frame.contentDocument?.createElement('iframe')
      if (inner) frame.contentDocument?.body.append(inner)
      const result = { child: probe(frame), grandchild: inner ? probe(inner) : 'none' }
      frame.remove()
      return result
    })
    const child = { peerConnection: 'function', webkit: 'function', bridge: 'undefined' }
    expect(framed).toEqual({ child, grandchild: child })
    // Anything the renderer's session still reaches goes to a proxy that cannot connect.
    const proxy = await app.evaluate(async ({ session }: typeof Electron) => ({
      remote: await session.defaultSession.resolveProxy('https://turn.example.test:3478'),
      loopback: await session.defaultSession.resolveProxy('https://127.0.0.1:3478'),
    }))
    expect(proxy).toEqual({ remote: 'PROXY 127.0.0.1:9', loopback: 'PROXY 127.0.0.1:9' })
  })

  test('denies permission requests', async () => {
    const { page } = launched as Launched
    expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
  })

  test('main rejects unknown operations, bad arguments and hostile ids', async () => {
    const { page } = launched as Launched
    const results = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as BridgeWindow).cindlDesktop
      const outcome = async (name: string, args: unknown) => {
        try {
          await bridge.call(name, args)
          return 'resolved'
        } catch (error) {
          return (error as { code?: string }).code ?? 'no-code'
        }
      }
      return {
        unknown: await outcome('shell.exec', { command: 'id' }),
        proto: await outcome('__proto__', {}),
        badArgs: await outcome('prompt.submit', { text: 5 }),
        hostileId: await outcome('conversations.history', { conversationId: '../x' }),
        valid: await outcome('link.get', {}),
      }
    })
    expect(results).toEqual({
      unknown: 'invalid',
      proto: 'invalid',
      badArgs: 'invalid',
      hostileId: 'invalid',
      valid: 'resolved',
    })
  })

  test('opens https links only after a real click, one per click', async () => {
    const { app, page } = launched as Launched
    await app.evaluate(({ shell }: typeof Electron) => {
      const opened: string[] = []
      ;(globalThis as Record<string, unknown>).__cindlOpened = opened
      shell.openExternal = (url: string) => {
        opened.push(url)
        return Promise.resolve()
      }
    })
    // Without a gesture: script-driven opens are refused.
    const scripted = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as BridgeWindow).cindlDesktop
      const popup = window.open('https://example.test/scripted-window')
      return {
        popupBlocked: popup === null,
        bridge: await bridge.openExternal('https://example.test/scripted-bridge'),
      }
    })
    expect(scripted).toEqual({ popupBlocked: true, bridge: { opened: false } })
    // With a real click (input main saw arrive): one link opens.
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.id = 'smoke-link'
      link.href = 'https://example.test/clicked-link'
      link.target = '_blank'
      link.textContent = 'smoke link'
      link.style.cssText = 'position:fixed;top:120px;left:120px;z-index:99999'
      const button = document.createElement('button')
      button.id = 'smoke-button'
      button.textContent = 'smoke button'
      button.style.cssText = 'position:fixed;top:160px;left:120px;z-index:99999'
      button.addEventListener('click', () => {
        const bridge = (globalThis as unknown as BridgeWindow).cindlDesktop
        void bridge
          .openExternal('javascript:alert(1)')
          .then(() => bridge.openExternal('https://example.test/clicked-button'))
      })
      document.body.append(link, button)
    })
    await page.click('#smoke-link')
    await page.click('#smoke-button')
    await page.waitForTimeout(500)
    const opened = await app.evaluate(
      () => (globalThis as Record<string, unknown>).__cindlOpened,
    )
    expect(opened).toEqual([
      'https://example.test/clicked-link',
      'https://example.test/clicked-button',
    ])
    await page.evaluate(() => {
      document.getElementById('smoke-link')?.remove()
      document.getElementById('smoke-button')?.remove()
    })
  })

  // Last: Playwright keeps waiting on the cancelled navigation afterwards.
  test('blocks navigation away from the app', async () => {
    const { app, page } = launched as Launched
    await page.evaluate(() => {
      window.location.href = 'https://example.test/phish'
    })
    await page.waitForTimeout(500)
    expect(page.url()).toBe('app://cindl/index.html')
    const state = await app.evaluate(({ BrowserWindow }: typeof Electron) => ({
      windows: BrowserWindow.getAllWindows().length,
      url: BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
    }))
    expect(state).toEqual({ windows: 1, url: 'app://cindl/index.html' })
  })
})

test.describe('Cindl refuses to run without the sandbox', () => {
  test('exits with an explanation when --no-sandbox is passed', async () => {
    const { executablePath, appArgs } = target('real')
    const userData = mkdtempSync(path.join(tmpdir(), 'cindl-smoke-'))
    const child = spawn(
      executablePath,
      [...appArgs, '--no-sandbox', `--user-data-dir=${userData}`, ...displayArgs()],
      {
        cwd: appDir,
        env: childEnv(executablePath, { allowUnsandboxed: false }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    try {
      await expect
        .poll(() => output, { timeout: 90_000, intervals: [250] })
        .toContain("Refusing to start: Chromium's sandbox is turned off (--no-sandbox)")
      expect(output).not.toContain('Hermes tokens will be kept')
    } finally {
      if (child.pid !== undefined && child.exitCode === null)
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

test.describe('Cindl Demo (demo flavour)', () => {
  let launched: Launched | undefined
  test.beforeAll(async () => {
    launched = await launch('demo')
  })
  test.afterAll(() => close(launched))

  test('is labelled by its notice, window title and product name', async () => {
    const { app, page } = launched as Launched
    expect(page.url()).toBe('app://cindl/index.html')
    await expect(page.getByRole('note')).toHaveText(SYNTHETIC_DEMO_NOTICE)
    const identity = await app.evaluate(
      ({ app: electronApp, BrowserWindow }: typeof Electron) => ({
        name: electronApp.getName(),
        title: BrowserWindow.getAllWindows()[0]?.getTitle(),
      }),
    )
    expect(identity.name).toBe(DEMO_PRODUCT_NAME)
    expect(identity.title).toContain(DEMO_PRODUCT_NAME)
    expect(identity.title?.toLowerCase()).toContain(SYNTHETIC_DEMO_LABEL.toLowerCase())
    const link = await page.evaluate(() =>
      (globalThis as unknown as BridgeWindow).cindlDesktop.call('link.get', {}),
    )
    expect(link).toMatchObject({ phase: 'online', demo: true })
  })

  test('captures the reviewed demo screenshot', async () => {
    const { page } = launched as Launched
    await expect(page.getByRole('note')).toHaveText(SYNTHETIC_DEMO_NOTICE)
    await page.waitForTimeout(500)
    const scroll = await page.evaluate(() => ({
      document: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    }))
    expect(scroll.document).toBeLessThanOrEqual(scroll.viewport)
    const directory = env.CINDL_SMOKE_ARTIFACTS ?? test.info().outputPath()
    mkdirSync(directory, { recursive: true })
    await page.screenshot({ path: path.join(directory, 'desktop-demo.png') })
  })

  test('re-subscribes after a reload and keeps the label', async () => {
    const { app, page } = launched as Launched
    await page.reload()
    await expect(page.getByRole('note')).toHaveText(SYNTHETIC_DEMO_NOTICE)
    const title = await app.evaluate(({ BrowserWindow }: typeof Electron) =>
      BrowserWindow.getAllWindows()[0]?.getTitle(),
    )
    expect(title).toContain(DEMO_PRODUCT_NAME)
  })
})
