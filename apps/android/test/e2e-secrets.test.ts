import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { base64Url } from '@cindl/hermes-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeHermes, harness } from '../../../packages/client-core/test/direct-harness.ts'
import { createDevice } from '../e2e/device.ts'
import { startFakeHermesAuth, type FakeHermesAuth } from '../e2e/fakeHermesAuth.ts'
import {
  DeviceLogs,
  isUid,
  logcatUid,
  RunSecrets,
  watchFakeHermes,
  type SecretKind,
} from '../e2e/secrets.ts'
import { focusedPackage, keepCapture, onlyAppInFront } from '../e2e/ui.ts'

// What the emulator runs write about sign-in values (delta check of
// 94df18b..e0bc0ce, S1, N3, N4): device logs, UI dumps and report lines hold
// no token, ticket, code, state or verifier the run issued or received, and
// the browser is never captured. SYNTHETIC values only.

// Secret-shaped strings are assembled at runtime so secret scanners (pnpm
// check:privacy) do not flag the test itself.
const fake = (...parts: string[]) => parts.join('')
const ACCESS = 'synthetic-access-7b1d55aa94c3'
const TICKET = 'synthetic-ticket-2c8e4f6a1b9d'
const CODE = 'synthetic-code-91ad7e3c5f02'
const STATE = 'synthetic-state-4e6b0d2a8c17'
const VERIFIER = 'synthetic-verifier-0f3a9c7e5b18'
/** A credential the run never issued: only the adapter's redaction removes it. */
const PROXY = fake('AbCdEfGhIjKlMn', 'OpQrStUv0123')

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cindl-e2e-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the values a run must not publish', () => {
  it('replaces each with its kind, then redacts whatever else looks like a credential', () => {
    const secrets = new RunSecrets()
    secrets.add('access token', ACCESS)
    secrets.add('ticket', TICKET)
    secrets.add('code', CODE)
    secrets.add('state', STATE)
    secrets.add('verifier', VERIFIER)
    // Shorter than anything these servers issue: never searched for.
    secrets.add('state', 'short')
    const log = [
      `I ReactNativeJS: tokens ${ACCESS}`,
      `D OkHttp: --> GET http://127.0.0.1:8642/api/ws?ticket=${TICKET}`,
      `W chromium: http://127.0.0.1:41234/callback?code=${CODE}&state=${STATE}`,
      `D Cindl: verifier ${VERIFIER}`,
      `D Proxy: Authorization: Bearer ${PROXY}`,
      'I Short: short',
    ].join('\n')
    expect(secrets.found(log)).toEqual([
      'access token',
      'code',
      'state',
      'ticket',
      'verifier',
    ])
    const out = secrets.scrub(log)
    for (const value of [ACCESS, TICKET, CODE, STATE, VERIFIER, PROXY])
      expect(out).not.toContain(value)
    expect(out).toContain('I ReactNativeJS: tokens [issued-access-token]')
    expect(out).toContain('D Cindl: verifier [issued-verifier]')
    expect(out).toContain('D Proxy: Authorization: [redacted]')
    expect(out).toContain('I Short: short')
    expect(secrets.values('access token', 'ticket')).toEqual([ACCESS, TICKET])
  })

  it('writes device logs scrubbed, keeps them raw in memory only, and finds a value learned later', () => {
    const dir = scratch()
    const secrets = new RunSecrets()
    secrets.add('access token', ACCESS)
    const logs = new DeviceLogs(dir, secrets)
    logs.keep('logcat-01-sign-in.txt', `I ReactNativeJS: ${ACCESS}`)
    logs.keep('logcat-02-chat.txt', 'I ReactNativeJS: nothing to see')
    expect(readFileSync(join(dir, 'logcat-01-sign-in.txt'), 'utf8')).toBe(
      'I ReactNativeJS: [issued-access-token]',
    )
    expect(logs.holding()).toEqual([
      { file: 'logcat-01-sign-in.txt', kinds: ['access token'] },
    ])
    // The verifier reaches the fake only with the code exchange, after this log.
    logs.keep('logcat-03-browser.txt', `D Cindl: ${VERIFIER}`)
    secrets.add('verifier', VERIFIER)
    expect(
      logs.holding().map(({ file, kinds }) => `${file}: ${kinds.join(',')}`),
    ).toEqual(['logcat-01-sign-in.txt: access token', 'logcat-03-browser.txt: verifier'])
    logs.rewrite()
    expect(readFileSync(join(dir, 'logcat-03-browser.txt'), 'utf8')).toBe(
      'D Cindl: [issued-verifier]',
    )
    expect(logs.count).toBe(3)
    expect(readdirSync(dir).sort()).toEqual([
      'logcat-01-sign-in.txt',
      'logcat-02-chat.txt',
      'logcat-03-browser.txt',
    ])
  })
})

describe('the device log lines that count (CI runs 41656607631 and 41681122382)', () => {
  // `logcat -v threadtime -v uid` lines as run 41681122382's signin logs have
  // them: the UID column holds a user name of up to five letters (root), else
  // the number (system_server 1000, SystemUI 10124, Cindl 10151), with no
  // colon after it. SystemUI and system_server log the browser task Cindl
  // opened, with the link's state (`capturedLink=`).
  const LINK = `http://127.0.0.1:38457/auth/native/authorize?code_challenge=synthetic-challenge&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A39957%2Fcallback&state=${STATE}`
  const SHELL = `11-03 17:26:38.172 10124  1008  1100 V WindowManagerShell: Transition requested (#21): android.os.BinderProxy@f15e604 TransitionRequestInfo { type = OPEN, triggerTask = TaskInfo{userId=0 taskId=10 effectiveUid=10151 displayId=0 isRunning=true baseIntent=Intent { act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE] flg=0x10000000 capturedLink=${LINK} capturedLinkTimestamp=0 }`
  const SERVER = `11-03 17:26:38.392  1000   635   672 V WindowManager: Sent Transition (#21) createdAt=11-03 17:26:38.167 via request=TransitionRequestInfo { type = OPEN, triggerTask = TaskInfo{userId=0 taskId=10 baseIntent=Intent { capturedLink=${LINK} capturedLinkTimestamp=0 }`
  const APP = '11-03 17:26:27.989 10151  6292  6312 I ReactNativeJS: Running "main"'
  const ROOT =
    "11-03 17:26:25.182  root     0     0 I init    : Service 'adbd' (pid 525) exited with status 0"

  it('reads the uid of a line as logcat prints it, and nothing from a line without one', () => {
    expect(logcatUid(SHELL)).toBe('10124')
    expect(logcatUid(SERVER)).toBe('1000')
    expect(logcatUid(APP)).toBe('10151')
    expect(logcatUid(ROOT)).toBe('root')
    // Older releases print a colon after it.
    expect(logcatUid('11-03 15:03:23.500 10151:  4321  4321 I ReactNativeJS: x')).toBe(
      '10151',
    )
    // Without -v uid: a pid and a tid only.
    expect(
      logcatUid('11-03 15:03:23.182  1001  1092 V WindowManagerShell: x'),
    ).toBeUndefined()
  })

  it("knows Cindl's uid by its number and by its user name, and no one else's", () => {
    expect(isUid('10151', '10151')).toBe(true)
    expect(isUid('u0_a151', '10151')).toBe(true)
    expect(isUid('u10_a151', '1010151')).toBe(true)
    expect(isUid('u0_a124', '10151')).toBe(false)
    expect(isUid('10124', '10151')).toBe(false)
    for (const name of ['root', 'system', 'shell', 'radio'])
      expect(isUid(name, '10151')).toBe(false)
    // A system uid has no app name.
    expect(isUid('u0_a-9000', '1000')).toBe(false)
  })

  it("attributes lines to Cindl in either form, and fails closed when none is Cindl's", () => {
    const secrets = new RunSecrets()
    secrets.add('state', STATE)
    secrets.add('access token', ACCESS)
    const logs = new DeviceLogs(scratch(), secrets)
    logs.keep('logcat-01.txt', [ROOT, SERVER, SHELL, APP].join('\n'), '10151')
    expect(logs.attributed()).toBe(1)
    expect(logs.holding()).toEqual([])
    // A release that prints names: system_server as `system`, Cindl as `u0_a151`.
    const named = new DeviceLogs(scratch(), secrets)
    named.keep(
      'logcat-02.txt',
      [
        SERVER.replace(/^(\S+ \S+)\s+1000 /, '$1 system '),
        APP.replace(' 10151 ', ' u0_a151 '),
        `11-03 17:26:40.000 u0_a151  6292  6312 D ReactNativeJS: capturedLink=${LINK}`,
      ].join('\n'),
      '10151',
    )
    expect(named.attributed()).toBe(2)
    // The state in Cindl's own line counts; in the system's record of the link, it does not.
    expect(named.holding()).toEqual([{ file: 'logcat-02.txt', kinds: ['state'] }])
    // Only root's and the system's lines: nothing is Cindl's, and the run's step fails.
    const none = new DeviceLogs(scratch(), secrets)
    none.keep('logcat-03.txt', [ROOT, SERVER, SHELL].join('\n'), '10151')
    expect(none.attributed()).toBe(0)
  })

  it("does not count the state in the system's record of the link Cindl opened; it is scrubbed", () => {
    const dir = scratch()
    const secrets = new RunSecrets()
    secrets.add('state', STATE)
    secrets.add('access token', ACCESS)
    const logs = new DeviceLogs(dir, secrets)
    logs.keep('logcat-02-sign-in.txt', [SHELL, SERVER, APP].join('\n'), '10151')
    expect(logs.holding()).toEqual([])
    expect(logs.attributed()).toBe(1)
    const written = readFileSync(join(dir, 'logcat-02-sign-in.txt'), 'utf8')
    expect(written).not.toContain(STATE)
    expect(written).toContain('capturedLink=http://127.0.0.1:38457/auth/native/authorize')
    // A value on a line of Cindl's own counts.
    logs.keep(
      'logcat-03-chat.txt',
      `11-03 15:04:00.000 10151:  4321  4400 D ReactNativeJS: tokens ${ACCESS}`,
      '10151',
    )
    expect(logs.holding()).toEqual([
      { file: 'logcat-03-chat.txt', kinds: ['access token'] },
    ])
  })

  it("counts every other value in other processes' lines, and the state anywhere but that record", () => {
    const secrets = new RunSecrets()
    for (const [kind, value] of [
      ['access token', ACCESS],
      ['ticket', TICKET],
      ['code', CODE],
      ['state', STATE],
      ['verifier', VERIFIER],
    ] as const)
      secrets.add(kind, value)
    const held = (line: string) => {
      const logs = new DeviceLogs(scratch(), secrets)
      logs.keep('logcat.txt', line, '10151')
      return logs.holding().flatMap(({ kinds }) => kinds)
    }
    // A value Cindl handed to another process that the system logged.
    expect(
      held(`11-03 15:04:00.000  1000:   638   659 I ActivityManager: extra ${ACCESS}`),
    ).toEqual(['access token'])
    expect(
      held(`11-03 15:04:00.000 10102:  1001  1092 D Browser: ticket=${TICKET}`),
    ).toEqual(['ticket'])
    // In the captured link itself: a code or verifier counts, the state does not.
    expect(held(SHELL.replace(LINK, `${LINK}&code=${CODE}`))).toEqual(['code'])
    expect(held(SERVER.replace(LINK, `${LINK}&v=${VERIFIER}`))).toEqual(['verifier'])
    // The state on another process's line, outside a captured link.
    expect(
      held(`11-03 15:04:00.000  1000:   638   659 I ActivityManager: state ${STATE}`),
    ).toEqual(['state'])
    expect(held(`${SERVER} returned=${STATE}`)).toEqual(['state'])
    // And on Cindl's own line, captured link or not.
    expect(
      held(`11-03 15:04:00.000 10151:  4321  4400 D ReactNativeJS: capturedLink=${LINK}`),
    ).toEqual(['state'])
  })

  it("counts a line it cannot place, and every line when Cindl's uid is unknown (fail closed)", () => {
    const secrets = new RunSecrets()
    secrets.add('state', STATE)
    const unplaced = new DeviceLogs(scratch(), secrets)
    unplaced.keep(
      'a.txt',
      `--------- beginning of main\nstate ${STATE} on a line of another shape`,
      '10151',
    )
    expect(unplaced.holding()).toEqual([{ file: 'a.txt', kinds: ['state'] }])
    expect(unplaced.attributed()).toBe(0)
    // Nor is a line whose uid cannot be read another process's record of the link.
    const unread = new DeviceLogs(scratch(), secrets)
    unread.keep('c.txt', `V WindowManager: capturedLink=${LINK}`, '10151')
    expect(unread.holding()).toEqual([{ file: 'c.txt', kinds: ['state'] }])
    const unknown = new DeviceLogs(scratch(), secrets)
    unknown.keep('b.txt', [SHELL, APP].join('\n'))
    expect(unknown.holding()).toEqual([{ file: 'b.txt', kinds: ['state'] }])
  })
})

describe('where the values come from', () => {
  const kindsOf = (secrets: RunSecrets) =>
    (
      [
        'access token',
        'refresh token',
        'ticket',
        'code',
        'state',
        'verifier',
      ] as SecretKind[]
    ).filter((kind) => secrets.values(kind).length > 0)

  it("the fake Hermes: a sign-in and a connection give every kind, and a refresh's tokens too", async () => {
    const fake = await fakeHermes()
    const secrets = new RunSecrets()
    watchFakeHermes(fake.auth, secrets)
    // Where the fake sends the browser back: the code and the app's own state.
    const redirects: string[] = []
    const completePending = fake.auth.completePending.bind(fake.auth)
    fake.auth.completePending = (brokerState) => {
      const location = completePending(brokerState)
      if (location !== undefined) redirects.push(location)
      return location
    }
    const h = await harness({ fake })
    await h.waitFor(() => h.store.getState().link.phase === 'online')
    expect(kindsOf(secrets)).toEqual([
      'access token',
      'refresh token',
      'ticket',
      'code',
      'state',
      'verifier',
    ])
    expect(redirects).toHaveLength(1)
    expect(secrets.found(redirects[0] ?? '')).toEqual(['code', 'state'])
    const tokens = secrets.values('access token').length
    const [refresh] = secrets.values('refresh token')
    expect(fake.auth.refresh(refresh ?? '')).toBeDefined()
    expect(secrets.values('access token')).toHaveLength(tokens + 1)
  })

  describe('the auth stand-in', () => {
    let stand: FakeHermesAuth | undefined
    afterEach(async () => {
      await stand?.close()
      stand = undefined
    })

    it('hands each value to the run, and its event log still holds none', async () => {
      const secrets = new RunSecrets()
      stand = await startFakeHermesAuth(0, (kind, value) => secrets.add(kind, value))
      const verifier = base64Url(randomBytes(32))
      const url = new URL('/auth/native/authorize', stand.origin)
      url.searchParams.set(
        'code_challenge',
        base64Url(createHash('sha256').update(verifier).digest()),
      )
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('redirect_uri', 'http://127.0.0.1:41234/callback')
      url.searchParams.set('state', STATE)
      const location = new URL(
        (await fetch(url, { redirect: 'manual' })).headers.get('location') ?? '',
      )
      const token = await fetch(`${stand.origin}/auth/native/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: location.searchParams.get('code'),
          code_verifier: verifier,
        }),
      })
      expect(token.status).toBe(200)
      expect(kindsOf(secrets)).toEqual([
        'access token',
        'refresh token',
        'code',
        'state',
        'verifier',
      ])
      expect(secrets.found(location.href)).toEqual(['code', 'state'])
      const events = JSON.stringify(stand.events)
      for (const value of secrets.values(...kindsOf(secrets)))
        expect(events).not.toContain(value)
    })
  })
})

/**
 * adb as the device helper calls it, answering from the environment: the app
 * in front (or the focused window and the focused app apart), the text of the
 * one field on screen, and the app's error log. With FAKE_ADB_MARK set, a
 * screen capture writes that file, and from then on FAKE_ADB_AFTER has focus.
 */
const FAKE_ADB = `#!/usr/bin/env node
const fs = require('node:fs')
const [verb, command = ''] = process.argv.slice(2)
const env = process.env
if (env.FAKE_ADB_CALLS) fs.appendFileSync(env.FAKE_ADB_CALLS, verb + ' ' + command + '\\n')
const front = env.FAKE_ADB_FRONT
const switched = env.FAKE_ADB_MARK !== undefined && fs.existsSync(env.FAKE_ADB_MARK)
const now = switched ? env.FAKE_ADB_AFTER : front
const window = (switched ? undefined : env.FAKE_ADB_WINDOW) ?? 'Window{5a7c u0 ' + now + '/' + now + '.Main}'
const app = (switched ? undefined : env.FAKE_ADB_APP) ?? now
const say = (text) => process.stdout.write(text)
if (verb === 'shell' && command.includes('mCurrentFocus') && env.FAKE_ADB_NO_WINDOWS) {
  process.stderr.write('fake adb: no answer\\n')
  process.exit(1)
} else if (verb === 'shell' && command.includes('mCurrentFocus'))
  say('  mCurrentFocus=' + window + '\\n  mFocusedApp=' +
    (app ? 'ActivityRecord{9f1e u0 ' + app + '/.Main t7}' : 'null') + '\\n')
else if (verb === 'shell' && command.startsWith('uiautomator dump'))
  say('UI hierchary dumped to: /sdcard/cindl-ui.xml\\n')
else if (verb === 'exec-out' && command === 'cat')
  say("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\\"0\\">" +
    '<node text="' + env.FAKE_ADB_TEXT + '" resource-id="" class="android.widget.EditText" package="' +
    front + '" content-desc="" clickable="true" long-clickable="false" checkable="false" checked="false"' +
    ' enabled="true" focused="false" scrollable="false" bounds="[0,0][1080,160]" /></hierarchy>')
else if (verb === 'exec-out' && command === 'screencap') {
  if (env.FAKE_ADB_MARK) fs.writeFileSync(env.FAKE_ADB_MARK, 'captured')
  say('PNG')
}
else if (verb === 'shell' && command === 'logcat -d -b crash') say('')
else if (verb === 'shell' && command.startsWith('logcat -d -s')) say((env.FAKE_ADB_LOG ?? '') + '\\n')
else if (verb === 'shell' && command === 'dumpsys window windows') say(env.FAKE_ADB_WINDOWS ?? '')
else if (verb === 'shell' && command === 'dumpsys window InputMethod') say(env.FAKE_ADB_IME_WINDOW ?? '')
else if (verb === 'shell' && command === 'dumpsys input_method') say('mInputShown=true\\n')
else if (verb === 'shell' && command === 'wm size') say('Physical size: 1080x2400\\n')
else {
  process.stderr.write('fake adb: unexpected ' + process.argv.slice(2).join(' ') + '\\n')
  process.exit(1)
}
`

describe('what the device helper keeps', () => {
  it('reads which app is in front', () => {
    expect(
      focusedPackage(
        '  mCurrentFocus=Window{1a2b u0 dev.fl1nt.cindl/dev.fl1nt.cindl.MainActivity}',
      ),
    ).toBe('dev.fl1nt.cindl')
    expect(
      focusedPackage(
        '  mCurrentFocus=Window{3c4d u0 org.chromium.webview_shell/org.chromium.webview_shell.WebViewBrowserActivity}',
      ),
    ).toBe('org.chromium.webview_shell')
    expect(
      focusedPackage('  mCurrentFocus=Window{5e6f u0 NotificationShade}'),
    ).toBeUndefined()
    expect(focusedPackage('  mCurrentFocus=null')).toBeUndefined()
  })

  it("captures only while Cindl's own window has focus, and fails closed (delta checks: SF2, then N1 of c6ce4d3)", () => {
    const CINDL = 'dev.fl1nt.cindl'
    const BROWSER = 'org.chromium.webview_shell'
    const window = (title: string) => `  mCurrentFocus=Window{5a7c u0 ${title}}`
    const app = (pkg: string) => `  mFocusedApp=ActivityRecord{9f1e u0 ${pkg}/.Main t7}`
    // CI run 41656607631, demo/logcat-01: a system dialog's window names no activity.
    const ANR = window('Application Not Responding: com.android.systemui')
    const cases: Array<[string, boolean]> = [
      [`${window(`${CINDL}/${CINDL}.MainActivity`)}\n${app(CINDL)}`, true],
      [
        `${window(`${BROWSER}/${BROWSER}.WebViewBrowserActivity`)}\n${app(BROWSER)}`,
        false,
      ],
      // No focused window, or a system window, can leave the browser on screen.
      [`  mCurrentFocus=null\n${app(CINDL)}`, false],
      [`  mCurrentFocus=null\n${app(BROWSER)}`, false],
      [`${ANR}\n${app(CINDL)}`, false],
      [`${ANR}\n${app(BROWSER)}`, false],
      [
        `${window('Application Error: org.chromium.webview_shell')}\n${app(BROWSER)}`,
        false,
      ],
      [`${window('NotificationShade')}\n${app(BROWSER)}`, false],
      [`${window('NotificationShade')}\n${app(CINDL)}`, false],
      // Cindl's window, but another app's activity in focus, or none said.
      [`${window(`${CINDL}/${CINDL}.MainActivity`)}\n${app(BROWSER)}`, false],
      [window(`${CINDL}/${CINDL}.MainActivity`), false],
      ['  mCurrentFocus=null\n  mFocusedApp=null', false],
      ['', false],
    ]
    for (const [dumpsys, shown] of cases)
      expect([dumpsys, onlyAppInFront(dumpsys, CINDL)]).toEqual([dumpsys, shown])
  })

  it('keeps a capture only when Cindl was alone in front before it and still is after, unchanged', () => {
    const CINDL = 'dev.fl1nt.cindl'
    const focus = (token: string, pkg = CINDL) =>
      `  mCurrentFocus=Window{${token} u0 ${pkg}/${pkg}.MainActivity}\n  mFocusedApp=ActivityRecord{9f1e u0 ${pkg}/.Main t7}\n`
    expect(keepCapture(focus('5a7c'), focus('5a7c'), CINDL)).toBe(true)
    // The browser came to the front while the screen was read.
    expect(
      keepCapture(focus('5a7c'), focus('3c4d', 'org.chromium.webview_shell'), CINDL),
    ).toBe(false)
    // Another window of Cindl's: the screen read may be from between the two.
    expect(keepCapture(focus('5a7c'), focus('7b8d'), CINDL)).toBe(false)
    expect(keepCapture(focus('5a7c'), '', CINDL)).toBe(false)
    expect(
      keepCapture(focus('3c4d', 'org.chromium.webview_shell'), focus('5a7c'), CINDL),
    ).toBe(false)
  })

  it('captures nothing while the browser is in front, and scrubs UI dumps and error lines', async () => {
    const dir = scratch()
    const adb = join(dir, 'adb')
    writeFileSync(adb, FAKE_ADB, { mode: 0o755 })
    const out = join(dir, 'out')
    mkdirSync(out)
    const secrets = new RunSecrets()
    secrets.add('code', CODE)
    secrets.add('state', STATE)
    const device = createDevice({ adb, out, scrub: (text) => secrets.scrub(text) })
    try {
      process.env.FAKE_ADB_TEXT = `http://127.0.0.1:41234/callback?code=${CODE}&amp;state=${STATE}`
      process.env.FAKE_ADB_FRONT = 'org.chromium.webview_shell'
      await device.dump()
      expect(device.screenshot('browser-signed-in')).toBeUndefined()
      expect(readdirSync(out)).toEqual([])

      // A system dialog over the browser names no activity: still the browser behind it.
      process.env.FAKE_ADB_WINDOW =
        'Window{d103796 u0 Application Not Responding: com.android.systemui}'
      await device.dump()
      expect(device.screenshot('step-failed')).toBeUndefined()
      expect(readdirSync(out)).toEqual([])
      // The device does not say what is in front: nothing is kept.
      process.env.FAKE_ADB_NO_WINDOWS = '1'
      expect(device.screenshot('unsure')).toBeUndefined()
      expect(readdirSync(out)).toEqual([])
      Reflect.deleteProperty(process.env, 'FAKE_ADB_NO_WINDOWS')
      // No focused window, or a system dialog in front, with Cindl the focused
      // app: the browser can still be on screen, so nothing is kept.
      process.env.FAKE_ADB_WINDOW = 'null'
      process.env.FAKE_ADB_APP = 'dev.fl1nt.cindl'
      expect(device.screenshot('between-windows')).toBeUndefined()
      process.env.FAKE_ADB_WINDOW =
        'Window{d103796 u0 Application Not Responding: com.android.systemui}'
      expect(device.screenshot('not-responding')).toBeUndefined()
      expect(readdirSync(out)).toEqual([])
      Reflect.deleteProperty(process.env, 'FAKE_ADB_WINDOW')
      Reflect.deleteProperty(process.env, 'FAKE_ADB_APP')

      // Cindl in front throughout, but the last dump is the browser's: only the picture.
      process.env.FAKE_ADB_FRONT = 'dev.fl1nt.cindl'
      expect(device.screenshot('back-in-cindl')).toBe('01-back-in-cindl.png')
      expect(readdirSync(out)).toEqual(['01-back-in-cindl.png'])
      rmSync(join(out, '01-back-in-cindl.png'))

      // The browser comes to the front while the screen is read: nothing is kept.
      process.env.FAKE_ADB_MARK = join(dir, 'captured')
      process.env.FAKE_ADB_AFTER = 'org.chromium.webview_shell'
      process.env.FAKE_ADB_TEXT = `Signed in with ${CODE}`
      await device.dump()
      expect(device.screenshot('switched')).toBeUndefined()
      expect(readdirSync(out)).toEqual([])
      rmSync(join(dir, 'captured'))
      Reflect.deleteProperty(process.env, 'FAKE_ADB_MARK')
      Reflect.deleteProperty(process.env, 'FAKE_ADB_AFTER')

      expect(device.screenshot('connected')).toBe('02-connected.png')
      expect(readdirSync(out).sort()).toEqual(['02-connected.png', '02-connected.xml'])
      const xml = readFileSync(join(out, '02-connected.xml'), 'utf8')
      expect(xml).toContain('text="Signed in with [issued-code]"')
      expect(xml).not.toContain(CODE)

      process.env.FAKE_ADB_LOG = `E ReactNativeJS: TypeError: sign-in failed at ?code=x&state=${STATE} (${CODE})`
      const problems = device.health().join('\n')
      expect(problems).toContain('TypeError')
      expect(problems).not.toContain(CODE)
      expect(problems).not.toContain(STATE)
    } finally {
      // Only this test sets them.
      for (const key of [
        'FAKE_ADB_TEXT',
        'FAKE_ADB_FRONT',
        'FAKE_ADB_WINDOW',
        'FAKE_ADB_APP',
        'FAKE_ADB_NO_WINDOWS',
        'FAKE_ADB_LOG',
        'FAKE_ADB_MARK',
        'FAKE_ADB_AFTER',
      ])
        Reflect.deleteProperty(process.env, key)
    }
  })

  it("reads the keyboard's geometry from every window in full, not the short window dump", () => {
    const dir = scratch()
    const adb = join(dir, 'adb')
    writeFileSync(adb, FAKE_ADB, { mode: 0o755 })
    const device = createDevice({ adb, out: dir })
    // `dumpsys window InputMethod` leaves out the window's visibility and insets;
    // `dumpsys window windows` prints them (CI run 41681122382's keyboard: "shown",
    // its top at the display's bottom edge).
    const block = (insetTop: number) =>
      [
        '  Window #7 Window{8c1f2e3 u0 InputMethod}:',
        '    mViewVisibility=0x0 mHaveFrame=true mObscured=false',
        `    mGivenContentInsets=[0,${insetTop}][0,0] mGivenVisibleInsets=[0,${insetTop}][0,0]`,
        '    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false',
        '    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,1377][1080,2400] last=[0,1377][1080,2400] insetsChanged=false',
        '    isOnScreen=true',
        '    isVisible=true',
      ].join('\n')
    try {
      process.env.FAKE_ADB_IME_WINDOW = block(0)
      process.env.FAKE_ADB_WINDOWS = `WINDOW MANAGER WINDOWS (dumpsys window windows)\n${block(1023)}\n`
      expect(device.keyboard().shown).toBe(true)
      expect(device.keyboardOnScreen()).toMatchObject({ visible: false })
      process.env.FAKE_ADB_WINDOWS = `WINDOW MANAGER WINDOWS (dumpsys window windows)\n${block(0)}\n`
      expect(device.keyboardOnScreen()).toMatchObject({
        visible: true,
        top: 1377,
        height: 1023,
      })
    } finally {
      for (const key of ['FAKE_ADB_IME_WINDOW', 'FAKE_ADB_WINDOWS'])
        Reflect.deleteProperty(process.env, key)
    }
  })

  it('keeps what TalkBack is given apart from the last dump, scrubbed, and only when it is Cindl alone', async () => {
    const dir = scratch()
    const adb = join(dir, 'adb')
    writeFileSync(adb, FAKE_ADB, { mode: 0o755 })
    const out = join(dir, 'out')
    mkdirSync(out)
    const secrets = new RunSecrets()
    secrets.add('code', CODE)
    const device = createDevice({ adb, out, scrub: (text) => secrets.scrub(text) })
    try {
      process.env.FAKE_ADB_CALLS = join(dir, 'calls')
      process.env.FAKE_ADB_FRONT = 'dev.fl1nt.cindl'
      process.env.FAKE_ADB_TEXT = 'Open this link?'
      await device.dump()
      process.env.FAKE_ADB_TEXT = `Signed in with ${CODE}`
      const talkback = await device.accessibilityDump()
      expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain(
        'shell uiautomator dump --compressed /sdcard/cindl-ui.xml',
      )
      expect(talkback.xml).toContain(`Signed in with ${CODE}`)
      // The last full dump, which a screenshot keeps beside it, is still the dialog's.
      expect(device.lastXml()).toContain('Open this link?')
      expect(device.keepDump('link-confirmation-talkback', talkback)).toBe(
        '01-link-confirmation-talkback.xml',
      )
      const kept = readFileSync(join(out, '01-link-confirmation-talkback.xml'), 'utf8')
      expect(kept).toContain('Signed in with [issued-code]')
      expect(kept).not.toContain(CODE)
      process.env.FAKE_ADB_FRONT = 'org.chromium.webview_shell'
      expect(device.keepDump('browser', await device.accessibilityDump())).toBeUndefined()
      expect(readdirSync(out)).toEqual(['01-link-confirmation-talkback.xml'])
    } finally {
      for (const key of ['FAKE_ADB_CALLS', 'FAKE_ADB_FRONT', 'FAKE_ADB_TEXT'])
        Reflect.deleteProperty(process.env, key)
    }
  })
})
