/**
 * The Cindl desktop main process (ADR 0009), shared by both flavours. It
 * serves the production web build from app://cindl, keeps Hermes tokens and
 * the Hermes connection here, and answers the renderer only through the
 * validated desktop channels. The flavour entry points (index.ts for the real
 * app, demo.ts for Cindl Demo) only choose the client.
 */
import { desktopChannels, type CindlClientApi, type CindlEvent } from '@cindl/contracts'
import { themes } from '@cindl/tokens'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  webContents,
  type WebContents,
} from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createExternalOpener } from './external.ts'
import {
  createGestureTracker,
  sandboxDisabledBy,
  UNSAFE_NO_SANDBOX_ENV,
} from './guards.ts'
import { createClientHost, type ClientHost, type EventSink } from './host.ts'
import { createIpcHandlers, isAppFrame } from './ipc.ts'
import { createLogger, parseLogLevel, type Logger } from './log.ts'
import { buildMenuTemplate, HANDBOOK_URL } from './menu.ts'
import { PRIVATE_FILE_MODE } from './platform/files.ts'
import { createDesktopPlatform, type DesktopPlatform } from './platform/index.ts'
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
} from './protocol.ts'
import { createTextSaver } from './save-text.ts'
import { hardenSession, hardenWebContents } from './security.ts'
import {
  createWindowStateStore,
  MIN_SIZE,
  placeWindow,
  type WindowState,
} from './window-state.ts'

/** Set by the desktop build from the repository LICENSE (scripts/desktop-build.ts). */
declare const __CINDL_COPYRIGHT__: string | undefined
const copyright =
  typeof __CINDL_COPYRIGHT__ === 'string'
    ? __CINDL_COPYRIGHT__
    : 'Copyright (c) Cindl contributors'

export interface FlavourContext {
  log: Logger
  /** Electron-backed secret store, settings, sign-in and WebSocket pieces. */
  createPlatform: () => Promise<DesktopPlatform>
}

export interface Flavour {
  /** `real` connects to Hermes; `demo` is Cindl Demo with the synthetic scenario. */
  kind: 'real' | 'demo'
  /** A title main keeps on the window whatever the page sets (the demo label). */
  windowTitle?: string
  createClient(context: FlavourContext): Promise<{
    client: CindlClientApi
    /** Events every new subscriber receives after the snapshot. */
    notices?: () => CindlEvent[]
  }>
}

const SANDBOX_HELP = `${HANDBOOK_URL}#chromium-sandbox-on-ubuntu-2310-and-later`

export function runCindl(flavour: Flavour): void {
  const env = process.env
  const log = createLogger({ level: parseLogLevel(env.CINDL_LOG) })
  /** Developer tools only in unpackaged builds, or when explicitly asked for. */
  const devTools = !app.isPackaged || env.CINDL_DEVTOOLS === '1'

  // Agent output must never run outside Chromium's sandbox. AppImage
  // launchers add --no-sandbox on their own when user namespaces are blocked.
  // Check before app.enableSandbox(): it drops the switch from
  // app.commandLine, but Chromium's zygote has already started without the
  // sandbox by then.
  const unsandboxed = sandboxDisabledBy((name) => app.commandLine.hasSwitch(name), env)
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES },
  ])
  // Every renderer is sandboxed, whatever its webPreferences say.
  app.enableSandbox()
  if (unsandboxed && env[UNSAFE_NO_SANDBOX_ENV] !== '1') {
    log.error(
      `Refusing to start: Chromium's sandbox is turned off (${unsandboxed}). See ${SANDBOX_HELP}`,
    )
    void app
      .whenReady()
      .then(() =>
        dialog.showMessageBox({
          type: 'error',
          title: `${app.getName()} cannot start safely`,
          message: `${app.getName()} will not run with Chromium's sandbox turned off.`,
          detail: `The sandbox keeps agent output away from the rest of your system, and it was disabled (${unsandboxed}). On Ubuntu 23.10 and later this happens when unprivileged user namespaces are blocked. How to fix it: ${SANDBOX_HELP}`,
          buttons: ['Quit'],
        }),
      )
      .finally(() => app.exit(1))
    return
  }
  if (unsandboxed)
    log.warn(
      `Running WITHOUT Chromium's sandbox (${unsandboxed}) because ${UNSAFE_NO_SANDBOX_ENV}=1. Agent output is not contained.`,
    )

  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: `${copyright}. MIT licence.`,
    website: 'https://github.com/FlintSH/cindl',
  })

  const gestures = createGestureTracker()
  const external = createExternalOpener({
    open: (url) => shell.openExternal(url),
    consumeGesture: gestures.consume,
    onRejected: (reason) => log.warn('Refused to open a link', { reason }),
  })

  let mainWindow: BrowserWindow | undefined
  let host: ClientHost | undefined

  app.on('web-contents-created', (_event, contents) =>
    hardenWebContents(contents, { external, gestures, log }),
  )

  // main.cjs and preload.cjs sit side by side in dist/ (or dist-demo/), with
  // the renderer next to them when unpacked and in resources/ when packaged.
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'renderer')
    : path.join(__dirname, 'renderer')

  const eventSink = (contents: WebContents): EventSink => ({
    alive: () => !contents.isDestroyed() && isAppFrame(contents.mainFrame),
    send: (event) => contents.send(desktopChannels.event, event),
  })

  /**
   * Creates the one app window and registers it as the trusted IPC sender
   * before it starts loading: the renderer subscribes while it loads.
   */
  async function openMainWindow(
    stateFile: string,
    clientHost: ClientHost,
  ): Promise<void> {
    const store = createWindowStateStore(stateFile)
    const placed = placeWindow(
      await store.load(),
      screen.getAllDisplays().map((display) => display.workArea),
    )
    const theme = nativeTheme.shouldUseDarkColors ? themes.dark : themes.light
    const window = new BrowserWindow({
      width: placed.width,
      height: placed.height,
      ...(placed.x === undefined || placed.y === undefined
        ? {}
        : { x: placed.x, y: placed.y }),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false,
      title: flavour.windowTitle ?? app.getName(),
      backgroundColor: theme.canvas,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        safeDialogs: true,
        devTools,
      },
    })
    if (flavour.windowTitle)
      window.on('page-title-updated', (event) => event.preventDefault())
    if (placed.maximized) window.maximize()

    let saveTimer: NodeJS.Timeout | undefined
    const saveState = () => {
      if (window.isDestroyed()) return
      const bounds = window.getNormalBounds()
      const state: WindowState = { ...bounds, maximized: window.isMaximized() }
      store
        .save(state)
        .catch((error: unknown) => log.warn('Could not save window state', error))
    }
    const scheduleSave = () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(saveState, 500)
    }
    window.on('resize', scheduleSave)
    window.on('move', scheduleSave)
    window.on('close', () => {
      clearTimeout(saveTimer)
      saveState()
    })
    window.once('ready-to-show', () => window.show())
    window.webContents.on('render-process-gone', (_event, details) =>
      log.error('The renderer process stopped', { reason: details.reason }),
    )
    const contentsId = window.webContents.id
    window.on('closed', () => {
      clientHost.detach(contentsId)
      if (mainWindow === window) mainWindow = undefined
    })
    mainWindow = window
    await window.loadURL(APP_ENTRY_URL)
  }

  /** Main-owned confirmation: a compromised renderer cannot start a sign-in silently. */
  async function confirmSignIn(origin: string): Promise<boolean> {
    const options = {
      type: 'question' as const,
      title: 'Sign in to Hermes',
      message: `Sign in to the Hermes backend at ${origin}?`,
      detail:
        'Cindl will open your browser on that address. Continue only if you entered it yourself.',
      buttons: ['Cancel', 'Sign in'],
      defaultId: 0,
      cancelId: 0,
    }
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options)
    return result.response === 1
  }

  async function start(): Promise<void> {
    await hardenSession(session.defaultSession, log)
    protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler({
        root: rendererRoot,
        onRefused: (reason) => log.warn('Refused an app:// request', { reason }),
      }),
    )

    const userData = app.getPath('userData')
    const { client, notices } = await flavour.createClient({
      log,
      createPlatform: () =>
        createDesktopPlatform({
          safeStorage,
          userDataDir: userData,
          platform: process.platform,
          openExternal: (url) => shell.openExternal(url),
          confirmSignIn,
          log,
        }),
    })
    const clientHost = createClientHost({ client, ...(notices ? { notices } : {}) })
    host = clientHost

    const saveText = createTextSaver({
      showSaveDialog: async (defaultPath) => {
        const options = { title: `Save from ${app.getName()}`, defaultPath }
        return mainWindow
          ? dialog.showSaveDialog(mainWindow, options)
          : dialog.showSaveDialog(options)
      },
      writeFile: (filePath, content) =>
        fs.writeFile(filePath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE }),
      defaultDirectory: () => app.getPath('documents'),
    })
    const handlers = createIpcHandlers({
      trustedContentsId: () =>
        mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : undefined,
      client: clientHost,
      saveText,
      consumeGesture: gestures.consume,
      openExternal: (url) => external.open(url),
      onEventSignal: (contentsId, signal) => {
        const contents = webContents.fromId(contentsId)
        if (signal === 'subscribe' && contents)
          clientHost.attach(contentsId, eventSink(contents))
        else clientHost.detach(contentsId)
      },
      log,
    })
    ipcMain.handle(desktopChannels.call, handlers.call)
    ipcMain.handle(desktopChannels.saveText, handlers.saveText)
    ipcMain.handle(desktopChannels.openExternal, handlers.openExternal)
    ipcMain.on(desktopChannels.event, handlers.eventSignal)

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          devTools,
          // A fixed, trusted URL chosen from the native menu.
          openHandbook: () => void shell.openExternal(HANDBOOK_URL),
        }),
      ),
    )

    await openMainWindow(path.join(userData, 'window-state.json'), clientHost)
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => host?.dispose())
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', reason))
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      log.error(`${app.getName()} could not start`, error)
      app.exit(1)
    })
}
