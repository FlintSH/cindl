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
  logcatUid,
  RunSecrets,
  watchFakeHermes,
  type SecretKind,
} from '../e2e/secrets.ts'
import { focusedPackage, onlyAppInFront } from '../e2e/ui.ts'

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

describe('the device log lines that count (CI run 41656607631, delta check of c6ce4d3)', () => {
  // `logcat -v threadtime -v uid` lines. SystemUI (uid 10102) and system_server
  // (uid 1000) log the browser task Cindl opened, with the link's state, as
  // that run's signin/logcat-02 shows; Cindl's own lines carry its uid, 10151.
  const LINK = `http://127.0.0.1:38457/auth/native/authorize?code_challenge=synthetic-challenge&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A39957%2Fcallback&state=${STATE}`
  const SHELL = `11-03 15:03:23.182 10102:  1001  1092 V WindowManagerShell: Transition requested (#22): android.os.BinderProxy@801c905 TransitionRequestInfo { type = OPEN, triggerTask = TaskInfo{userId=0 taskId=10 effectiveUid=10151 displayId=0 isRunning=true baseIntent=Intent { act=android.intent.action.VIEW cat=[android.intent.category.BROWSABLE] flg=0x10000000 capturedLink=${LINK} }`
  const SERVER = `11-03 15:03:23.420  1000:   638   659 V WindowManager: Sent Transition (#22) createdAt=11-03 15:03:23.176 via request=TransitionRequestInfo { type = OPEN, triggerTask = TaskInfo{userId=0 taskId=10 baseIntent=Intent { capturedLink=${LINK} }`
  const APP =
    '11-03 15:03:23.500 10151:  4321  4321 I ReactNativeJS: Waiting for the browser'

  it('reads the uid of a line, and nothing from a line without one', () => {
    expect(logcatUid(SHELL)).toBe('10102')
    expect(logcatUid(SERVER)).toBe('1000')
    expect(logcatUid(APP)).toBe('10151')
    expect(
      logcatUid('11-03 15:03:23.182  1001  1092 V WindowManagerShell: x'),
    ).toBeUndefined()
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
 * one field on screen, and the app's error log.
 */
const FAKE_ADB = `#!/usr/bin/env node
const [verb, command = ''] = process.argv.slice(2)
const env = process.env
const front = env.FAKE_ADB_FRONT
const window = env.FAKE_ADB_WINDOW ?? 'Window{5a7c u0 ' + front + '/' + front + '.Main}'
const app = env.FAKE_ADB_APP ?? front
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
else if (verb === 'exec-out' && command === 'screencap') say('PNG')
else if (verb === 'shell' && command === 'logcat -d -b crash') say('')
else if (verb === 'shell' && command.startsWith('logcat -d -s')) say((env.FAKE_ADB_LOG ?? '') + '\\n')
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

  it('captures only what shows nothing but Cindl, and fails closed (delta check, SF2)', () => {
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
      [`  mCurrentFocus=null\n${app(CINDL)}`, true],
      [`  mCurrentFocus=null\n${app(BROWSER)}`, false],
      [`${ANR}\n${app(CINDL)}`, true],
      [`${ANR}\n${app(BROWSER)}`, false],
      [
        `${window('Application Error: org.chromium.webview_shell')}\n${app(BROWSER)}`,
        false,
      ],
      [`${window('NotificationShade')}\n${app(BROWSER)}`, false],
      [`${window('NotificationShade')}\n${app(CINDL)}`, true],
      ['  mCurrentFocus=null\n  mFocusedApp=null', false],
      ['', false],
    ]
    for (const [dumpsys, shown] of cases)
      expect([dumpsys, onlyAppInFront(dumpsys, CINDL)]).toEqual([dumpsys, shown])
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
      // No focused window, Cindl the focused app: captured.
      process.env.FAKE_ADB_WINDOW = 'null'
      process.env.FAKE_ADB_APP = 'dev.fl1nt.cindl'
      expect(device.screenshot('between-windows')).toBe('01-between-windows.png')
      for (const file of readdirSync(out)) rmSync(join(out, file))
      Reflect.deleteProperty(process.env, 'FAKE_ADB_WINDOW')
      Reflect.deleteProperty(process.env, 'FAKE_ADB_APP')

      process.env.FAKE_ADB_FRONT = 'dev.fl1nt.cindl'
      process.env.FAKE_ADB_TEXT = `Signed in with ${CODE}`
      await device.dump()
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
      ])
        Reflect.deleteProperty(process.env, key)
    }
  })
})
