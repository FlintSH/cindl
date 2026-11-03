/**
 * Emulator tests for the CI test APKs, run on a GitHub-hosted runner (the
 * only place the owner approved the Android SDK licence for). SYNTHETIC data
 * only: the demo APK's invented scenario, and for sign-in a fake Hermes auth
 * server (e2e/fakeHermesAuth.ts) on the runner, reached from the emulator's
 * own 127.0.0.1 through `adb reverse`.
 *
 *   ADB=<platform-tools>/adb node e2e/run.ts demo <apk> <out-dir>
 *   ADB=<platform-tools>/adb node e2e/run.ts signin <apk> <out-dir>
 *
 * Writes screenshots, UI dumps, report.json and summary.md to <out-dir>.
 * A step that would have to accept terms (for example a browser's first-run
 * screen) is reported as blocked, never accepted.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'
import { createDevice, PACKAGE } from './device.ts'
import { startFakeHermesAuth, type FakeHermesAuth } from './fakeHermesAuth.ts'
import {
  find,
  findAll,
  flatten,
  label,
  TERMS_PROMPT,
  type Match,
  type TargetAudit,
  type UiNode,
} from './ui.ts'

type Status = 'passed' | 'failed' | 'blocked'

interface Step {
  name: string
  status: Status
  seconds: number
  detail: string[]
  evidence: string[]
}

class Blocked extends Error {}

const [suite, apk, outDir] = process.argv.slice(2)
/** process.env as typed by React Native's globals is loose; read it as unknown. */
const env = (name: string): string | undefined => {
  const value: unknown = process.env[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}
const adb = env('ADB') ?? 'adb'
if ((suite !== 'demo' && suite !== 'signin') || !apk || !outDir) {
  console.error('Usage: ADB=<adb> node e2e/run.ts <demo|signin> <apk> <out-dir>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const device = createDevice({ adb, out: outDir })
const steps: Step[] = []
const audits: Array<{ screen: string } & TargetAudit> = []

interface StepContext {
  note: (line: string) => void
  shot: (name: string) => void
  audit: (screen: string, root?: UiNode) => Promise<void>
}

async function step(name: string, body: (context: StepContext) => Promise<void>) {
  const started = Date.now()
  const record: Step = { name, status: 'passed', seconds: 0, detail: [], evidence: [] }
  const context: StepContext = {
    note: (line) => record.detail.push(line),
    shot: (shot) => record.evidence.push(device.screenshot(shot)),
    audit: async (screen, root) => {
      const result = await device.audit(root)
      audits.push({ screen, ...result })
      record.detail.push(
        `${screen}: ${result.checked} targets checked, ${result.issues.length} under 48dp` +
          (result.skippedClipped
            ? `, ${result.skippedClipped} partly scrolled off (not measured)`
            : ''),
      )
    },
  }
  console.log(`\n== ${name}`)
  try {
    await body(context)
    const problems = device.health()
    if (problems.length > 0) throw new Error(`App health: ${problems.join(' | ')}`)
  } catch (error) {
    record.status = error instanceof Blocked ? 'blocked' : 'failed'
    record.detail.push(error instanceof Error ? error.message : String(error))
    try {
      await device.dump()
    } catch {
      // The screenshot below is still useful without a fresh dump.
    }
    try {
      record.evidence.push(device.screenshot(`${slug(name)}-${record.status}`))
    } catch {
      record.detail.push('(no screenshot: the device did not answer)')
    }
  }
  try {
    const file = `logcat-${String(steps.length + 1).padStart(2, '0')}-${slug(name)}.txt`
    writeFileSync(
      join(outDir as string, file),
      device.shell('logcat -d -v threadtime', 120_000),
    )
    record.evidence.push(file)
    device.shell('logcat -c')
    device.shell('logcat -b crash -c')
  } catch {
    record.detail.push('(logcat not saved: the device did not answer)')
  }
  record.seconds = Math.round((Date.now() - started) / 100) / 10
  steps.push(record)
  console.log(
    `${record.status.toUpperCase()}: ${name}${record.detail.length ? `\n  ${record.detail.join('\n  ')}` : ''}`,
  )
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const isComposer: Match = (text, node) =>
  /EditText$/.test(node.className) && text.startsWith('Message ')

function navItem(root: UiNode, name: string): UiNode | undefined {
  const candidates = flatten(root).filter(
    (node) =>
      node.clickable && (label(node) === name || label(node).startsWith(`${name}, `)),
  )
  return candidates.sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0]
}

async function openDestination(name: string, heading: Match) {
  const root = await device.dump()
  const item = navItem(root, name)
  if (!item) throw new Error(`No "${name}" item in the bottom navigation`)
  await device.tapNode(item)
  return device.waitFor(heading, `the ${name} destination`)
}

/** A heading or label by its words, whatever case the screen draws it in. */
const named =
  (wanted: string): Match =>
  (text) =>
    text.toLowerCase() === wanted.toLowerCase()

const DESTINATIONS: Array<[string, Match]> = [
  ['Work', named('Needs you')],
  ['Library', named('Skills')],
  ['Agent', named('SOUL.md')],
  ['Talk', isComposer],
]

/** Brings Cindl to the front if something else (launcher, browser) has focus. */
function ensureApp() {
  const focus = device.shell('dumpsys window | grep -E "mCurrentFocus" || true')
  if (!focus.includes(`${PACKAGE}/`)) device.launch()
}

/** Each step starts from Talk, so one failure does not cascade into the next. */
async function startOnTalk() {
  ensureApp()
  const root = await device.dump()
  if (!find(root, isComposer)) await openDestination('Talk', isComposer)
}

function prepareDevice() {
  device.run(['wait-for-device'], 120_000)
  for (const setting of [
    // Deterministic UI dumps: system animations off (the app then also reduces motion).
    'settings put global window_animation_scale 0',
    'settings put global transition_animation_scale 0',
    'settings put global animator_duration_scale 0',
    'settings put system font_scale 1.0',
    'settings put system accelerometer_rotation 0',
    'settings put system user_rotation 0',
    'settings put global always_finish_activities 0',
    'cmd uimode night no',
  ])
    device.shell(setting)
  device.shell('logcat -c')
  device.shell('logcat -b crash -c')
}

function installApk(path: string) {
  try {
    device.run(['uninstall', PACKAGE], 120_000)
  } catch {
    // Not installed yet.
  }
  device.run(['install', path], 240_000)
}

async function demoSuite() {
  await step('Install and launch the demo APK', async ({ note, shot, audit }) => {
    installApk(apk as string)
    const start = device.shell(`am start -W -n ${PACKAGE}/.MainActivity`, 120_000)
    note(`cold start: ${/TotalTime: (\d+)/.exec(start)?.[1] ?? '?'} ms`)
    await device.waitFor(
      (text) => text.startsWith(SYNTHETIC_DEMO_LABEL),
      'the synthetic demo notice',
      90_000,
    )
    const { root } = await device.waitFor(isComposer, 'the composer')
    note('synthetic demo notice shown')
    shot('talk')
    await audit('Talk', root)
  })

  await step('Navigate the four destinations', async ({ shot, audit }) => {
    for (const [name, heading] of DESTINATIONS) {
      const { root } = await openDestination(name, heading)
      shot(`destination-${slug(name)}`)
      await audit(name, root)
    }
  })

  await step(
    'System back closes overlays and steps out before leaving',
    async ({ note, shot, audit }) => {
      await startOnTalk()
      await openDestination('Library', named('Skills'))
      await device.tap(
        (text) => text.startsWith('calendar-triage'),
        'the calendar-triage skill',
      )
      const detail = await device.waitFor('All skills', 'the skill detail')
      shot('skill-detail')
      await audit('Skill detail', detail.root)
      await device.key('KEYCODE_BACK')
      await device.waitUntilGone('All skills', 'The skill detail')
      await device.waitFor((text) => text.startsWith('calendar-triage'), 'the skill list')
      note('back closed the skill detail and stayed in Library')

      await openDestination('Work', named('Needs you'))
      await device.key('KEYCODE_BACK')
      await device.waitFor(isComposer, 'Talk after back from Work')
      note('back from Work returned to Talk')

      await device.tap('Show the working margin', 'the working margin button')
      const margin = await device.waitFor(
        'Close the working margin',
        'the working margin sheet',
      )
      shot('working-margin')
      await audit('Working margin', margin.root)
      await device.key('KEYCODE_BACK')
      await device.waitUntilGone('Close the working margin', 'The working margin sheet')
      await device.waitFor(isComposer, 'Talk after closing the sheet')
      note('back closed the working margin sheet and stayed in Talk')

      await device.tap(
        (text) => text.endsWith('Switch conversation'),
        'the conversation switcher',
      )
      const history = await device.waitFor(
        'Search conversations',
        'the conversation list',
      )
      shot('conversations')
      await audit('Conversations', history.root)
      await device.tap('Search conversations', 'the conversation search')
      await device.type('kiln')
      if (device.keyboard().shown) await device.key('KEYCODE_BACK')
      await device.tap(
        (text) => text.startsWith('Kiln inventory sheet'),
        'the side conversation',
      )
      await device.waitFor(
        (text) =>
          text.startsWith('Kiln inventory sheet') && text.endsWith('Switch conversation'),
        'the side conversation',
      )
      shot('side-conversation')
      await device.key('KEYCODE_BACK')
      await device.waitFor(
        (text) => text.endsWith(', Main. Switch conversation'),
        'the main conversation',
      )
      note('back from a side conversation returned to the main one')

      await device.key('KEYCODE_BACK')
      await sleep(1500)
      const focus = device.shell(
        'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" || true',
      )
      if (focus.includes(`${PACKAGE}/`))
        throw new Error(
          `Cindl kept focus after back on the main conversation: ${focus.trim()}`,
        )
      note(
        `back on the main conversation left the app (process ${device.pid() ? 'kept' : 'ended'})`,
      )
      device.launch()
      await device.waitFor(isComposer, 'Talk after relaunch')
      shot('relaunched')
    },
  )

  await step(
    'Answer the decisions (approval and question set)',
    async ({ note, shot, audit }) => {
      await startOnTalk()
      await device.tap('Show the working margin', 'the working margin button')
      await device.tap(
        'Show approval: Run the inventory export script',
        'the approval in the margin',
      )
      const card = await device.waitFor('Allow once', 'the approval card')
      if (!find(card.root, 'Deny')) throw new Error('The approval card offers no Deny')
      const grant = find(
        card.root,
        (text, node) =>
          node.clickable && /always|all future|session|every time/i.test(text),
      )
      if (grant)
        throw new Error(`The approval card offers a standing grant ("${label(grant)}")`)
      shot('approval')
      await audit('Approval card', card.root)
      await device.tap('Deny', 'Deny')
      await device.waitUntilGone('Allow once', 'The approval card')
      shot('approval-answered')
      note('approval offered Allow once and Deny only; Deny answered it')

      await device.tap('Show the working margin', 'the working margin button')
      await device.tap(
        'Show question: Offsite venue and prep',
        'the question set in the margin',
      )
      const set = await device.waitFor('Harbor Loft (fictional)', 'the question card')
      shot('questions')
      await audit('Question card', set.root)
      await device.tap('Harbor Loft (fictional)', 'a single-choice answer')
      await tapRevealed('Floor plan', 'a multiple-choice answer')
      // Both questions must be answered before the set is sent (no partial answers).
      const chosen = await device.dump()
      for (const answer of ['Harbor Loft (fictional)', 'Floor plan'])
        if (!findAll(chosen, answer).some((n) => n.checked))
          throw new Error(`"${answer}" is not chosen before sending`)
      note('both answers chosen (Harbor Loft, Floor plan)')
      await tapRevealed('Send answers', 'Send answers')
      await device.waitUntilGone('Send answers', 'The question card')
      shot('questions-answered')
      note('both questions answered and sent as one set')
    },
  )

  await step('Chat with the on-screen keyboard open', async ({ note, shot }) => {
    await startOnTalk()
    await device.tap(isComposer, 'the composer')
    await sleep(1500)
    let keyboard = device.keyboard()
    if (!keyboard.shown) {
      await device.tap(isComposer, 'the composer')
      await sleep(1500)
      keyboard = device.keyboard()
    }
    if (!keyboard.shown)
      throw new Error('The on-screen keyboard did not open for the composer')
    const { root, node } = await device.waitFor(
      isComposer,
      'the composer above the keyboard',
    )
    shot('keyboard')
    if (keyboard.top === undefined) {
      note(
        'keyboard open; its top edge was not reported by dumpsys, so overlap was not measured (see screenshot)',
      )
    } else if (node.bounds.bottom > keyboard.top + 2) {
      throw new Error(
        `The keyboard covers the composer (composer bottom ${node.bounds.bottom}px, keyboard top ${keyboard.top}px)`,
      )
    } else {
      note(
        `composer bottom ${node.bounds.bottom}px is above the keyboard top ${keyboard.top}px`,
      )
    }
    if (navItem(root, 'Library'))
      throw new Error('The bottom navigation stayed visible over the keyboard')
    note('bottom navigation hidden while the keyboard is open')
    await device.type('Check the kiln schedule')
    await device.tap((text, n) => text === 'Send' && n.clickable, 'Send')
    await device.waitFor(
      (text, node) =>
        !/EditText$/.test(node.className) && text.includes('Check the kiln schedule'),
      'the sent message',
    )
    await device.waitFor(
      (text) => text.includes('This is the synthetic demo'),
      'the synthetic reply',
      45_000,
    )
    shot('chat-reply')
    note('message sent and the synthetic reply arrived')
    if (device.keyboard().shown) await device.key('KEYCODE_BACK')
  })

  await step('Large font (200%) and dark theme', async ({ note, shot, audit }) => {
    await startOnTalk()
    device.shell('settings put system font_scale 2.0')
    await sleep(3000)
    for (const [name, heading] of DESTINATIONS) {
      const { root } = await openDestination(name, heading)
      for (const item of ['Talk', 'Work', 'Library', 'Agent'])
        if (!navItem(root, item))
          throw new Error(`"${item}" missing from the navigation at 200% font`)
      shot(`font-200-${slug(name)}`)
      await audit(`${name} at 200% font`, root)
    }
    note('all four destinations and the navigation render at 200% font')
    device.shell('settings put system font_scale 1.0')
    device.shell('cmd uimode night yes')
    await sleep(3000)
    await device.waitFor(isComposer, 'Talk in dark theme')
    shot('dark-theme')
    device.shell('cmd uimode night no')
    await sleep(2000)
  })

  await step(
    'Lifecycle: background, rotation, activity recreation, process death',
    async ({ note, shot }) => {
      await startOnTalk()
      await device.tap(isComposer, 'the composer')
      await device.type('Draft kept')
      if (device.keyboard().shown) await device.key('KEYCODE_BACK')
      await device.key('KEYCODE_HOME')
      await sleep(2000)
      device.launch()
      let composer = await device.waitFor(isComposer, 'the composer after returning')
      if (composer.node.text !== 'Draft kept')
        throw new Error(
          `The draft was lost in the background (composer shows "${composer.node.text}")`,
        )
      note('draft kept after going to the background and back')

      device.shell('settings put system user_rotation 1')
      await sleep(3000)
      composer = await device.waitFor(isComposer, 'the composer in landscape')
      shot('landscape')
      note(
        `landscape: composer ${composer.node.text === 'Draft kept' ? 'kept' : 'lost'} the draft`,
      )
      if (composer.node.text !== 'Draft kept')
        throw new Error('The draft was lost on rotation')
      device.shell('settings put system user_rotation 0')
      await sleep(2000)

      device.shell('settings put global always_finish_activities 1')
      await device.key('KEYCODE_HOME')
      await sleep(2000)
      device.launch()
      composer = await device.waitFor(
        isComposer,
        'the composer after the activity was recreated',
      )
      device.shell('settings put global always_finish_activities 0')
      shot('activity-recreated')
      note(
        `activity destroyed and recreated: app usable, draft ${composer.node.text === 'Draft kept' ? 'kept' : 'not kept'}`,
      )

      await device.key('KEYCODE_HOME')
      await sleep(1000)
      device.shell(`am kill ${PACKAGE}`)
      await sleep(2000)
      if (device.pid()) throw new Error('am kill did not end the background process')
      const start = device.shell(`am start -W -n ${PACKAGE}/.MainActivity`, 120_000)
      await device.waitFor(
        (text) => text.startsWith(SYNTHETIC_DEMO_LABEL),
        'the demo notice after process death',
        90_000,
      )
      await device.waitFor(isComposer, 'Talk after process death')
      shot('after-process-death')
      note(
        `process killed in the background; relaunch took ${/TotalTime: (\d+)/.exec(start)?.[1] ?? '?'} ms and showed the demo again`,
      )
    },
  )
}

/** Taps a target that may be below the fold, scrolling to it first. */
async function tapRevealed(match: Match, what: string) {
  await device.tapAt((await device.reveal(match, what)).point)
}

async function signinSuite(hermes: FakeHermesAuth) {
  const signedIn = `Signed in to ${hermes.origin} on this device.`
  const count = (kind: string) =>
    hermes.events.filter((event) => event.kind === kind).length

  const startSignIn = async () => {
    const field = await device.reveal(
      (text, node) =>
        /EditText$/.test(node.className) &&
        (text === 'Hermes address' || node.text === hermes.origin),
      'the Hermes address field',
    )
    if (field.node.text !== hermes.origin) {
      await device.tapAt(field.point)
      await device.type(hermes.origin)
    }
    if (device.keyboard().shown) await device.key('KEYCODE_BACK')
    await tapRevealed((text, node) => text === 'Sign in' && node.clickable, 'Sign in')
  }

  // Steps that need the browser or an earlier sign-in report blocked, not failed, when those
  // could not happen, so a single stop (a browser's terms screen) is not counted several times.
  let browserBlocked: string | undefined
  let signedInOnce = false
  const needsBrowser = () => {
    if (browserBlocked)
      throw new Blocked(`Needs the browser, which stopped at: ${browserBlocked}`)
  }
  const needsSignIn = () => {
    if (!signedInOnce) throw new Blocked('Needs the PKCE sign-in step to have passed')
  }

  const expectAuthorize = async (n: number) => {
    if (await hermes.waitFor('authorize', n, 45_000)) return
    const root = await device.dump()
    const terms = flatten(root).find((node) => TERMS_PROMPT.test(label(node)))
    if (terms) {
      browserBlocked = `its own terms ("${label(terms).slice(0, 80)}")`
      // Leave the terms screen without answering it and return to Cindl.
      await device.key('KEYCODE_BACK')
      ensureApp()
      throw new Blocked(
        `The browser asks to accept ${browserBlocked}. The tests never accept terms; this needs the owner's approval.`,
      )
    }
    throw new Error('The browser never requested /auth/native/authorize')
  }

  await step(
    'Install and launch the real (non-demo) APK',
    async ({ note, shot, audit }) => {
      installApk(apk as string)
      device.run(['reverse', `tcp:${hermes.port}`, `tcp:${hermes.port}`])
      device.launch()
      const { root } = await device.waitFor(
        'Sign in on this device',
        'the sign-in section',
        90_000,
      )
      if (!find(root, 'Cindl is not connected'))
        throw new Error('The real build does not say it is not connected')
      if (findAll(root, (text) => text.startsWith(SYNTHETIC_DEMO_LABEL)).length > 0)
        throw new Error('The real build shows the synthetic demo notice')
      shot('not-connected')
      await audit('Not connected / sign-in', root)
      note('real build: "Cindl is not connected", no demo data, sign-in offered')
      const handlers = device.shell(
        'cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d https://example.test/',
      )
      note(
        `browsers for https links: ${
          handlers
            .split('\n')
            .filter((line) => line.includes('/'))
            .map((line) => line.trim())
            .join(', ') || 'none'
        }`,
      )
      const loopback = device.shell(
        'cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d http://127.0.0.1/',
      )
      note(
        `browsers for http://127.0.0.1 links: ${
          loopback
            .split('\n')
            .filter((line) => line.includes('/'))
            .map((line) => line.trim())
            .join(', ') || 'none'
        }`,
      )
      const chrome = /versionName=(\S+)/.exec(
        device.shell('dumpsys package com.android.chrome | grep versionName || true'),
      )
      note(`Chrome: ${chrome?.[1] ?? 'not installed'}`)
    },
  )

  await step(
    'PKCE sign-in through the loopback callback',
    async ({ note, shot, audit }) => {
      ensureApp()
      const authorizeBefore = count('authorize')
      await startSignIn()
      await expectAuthorize(authorizeBefore + 1)
      const authorize = hermes.events.find((event) => event.kind === 'authorize')
      note(`authorize: ${JSON.stringify(authorize?.detail)}`)
      if (
        authorize?.detail.challengeMethod !== 'S256' ||
        authorize.detail.hasState !== true
      )
        throw new Error('The authorize request lacked S256 PKCE or state')
      if (
        !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(
          String(authorize.detail.redirectUri),
        )
      )
        throw new Error(`Unexpected redirect_uri ${String(authorize.detail.redirectUri)}`)
      if (!(await hermes.waitFor('token', 1, 45_000)))
        throw new Error('Cindl never exchanged the code')
      const token = hermes.events.find((event) => event.kind === 'token')
      note(`token exchange: ${JSON.stringify(token?.detail)}`)
      if (token?.detail.issued !== true)
        throw new Error('The code exchange failed PKCE verification')
      await device
        .waitFor('Signed in', "the listener's reply page in the browser", 20_000)
        .catch(() => undefined)
      shot('browser-signed-in')
      await device.key('KEYCODE_BACK')
      let result = await device
        .waitFor(signedIn, 'the signed-in state', 20_000)
        .catch(() => undefined)
      if (!result) {
        device.launch()
        result = await device.waitFor(signedIn, 'the signed-in state', 20_000)
      }
      shot('signed-in')
      await audit('Signed in', result.root)
      note(
        'callback received by the loopback listener, code exchanged once, tokens stored',
      )
      signedInOnce = true
    },
  )

  await step('Sign-in survives process death', async ({ note, shot }) => {
    needsSignIn()
    await device.key('KEYCODE_HOME')
    await sleep(1000)
    device.shell(`am kill ${PACKAGE}`)
    await sleep(2000)
    if (device.pid()) throw new Error('am kill did not end the background process')
    device.launch()
    await device.waitFor(signedIn, 'the signed-in state after restart', 60_000)
    shot('signed-in-after-restart')
    note('tokens read back from Keystore-backed storage after a cold start')
  })

  await step('Sign out on this device', async ({ note, shot }) => {
    needsSignIn()
    ensureApp()
    await tapRevealed('Sign out on this device', 'Sign out on this device')
    await device.waitUntilGone(signedIn, 'The signed-in state')
    await device.waitFor(
      (text, node) => text === 'Sign in' && node.clickable,
      'the Sign in button',
    )
    shot('signed-out')
    note('signed out; the sign-in form is back')
  })

  await step('Process death while the browser is open', async ({ note, shot }) => {
    needsBrowser()
    ensureApp()
    const authorizeBefore = count('authorize')
    const tokensBefore = count('token')
    hermes.hold()
    await startSignIn()
    await expectAuthorize(authorizeBefore + 1)
    await sleep(1500)
    shot('browser-waiting')
    device.shell(`am kill ${PACKAGE}`)
    await sleep(2000)
    let method = 'am kill (background process)'
    if (device.pid()) {
      device.run(['root'], 60_000)
      device.run(['wait-for-device'], 60_000)
      // adbd restarted as root, which drops the reverse port forward.
      device.run(['reverse', `tcp:${hermes.port}`, `tcp:${hermes.port}`])
      device.shell(`kill -9 ${device.pid()}`)
      await sleep(1500)
      method = 'kill -9 as root (am kill left it running)'
    }
    if (device.pid()) throw new Error('Could not end the app process')
    note(`app process ended with ${method} while the browser showed the authorize page`)
    hermes.release()
    await sleep(3000)
    shot('browser-callback-refused')
    if (count('token') !== tokensBefore)
      throw new Error('A code was exchanged for the interrupted attempt')
    await device.key('KEYCODE_BACK')
    await sleep(2000)
    if (!device.pid()) device.launch()
    const notice = await device.waitFor(
      (text) => text.startsWith('Cindl stopped waiting for the browser'),
      'the interrupted notice',
      60_000,
    )
    if (find(notice.root, signedIn))
      throw new Error('An interrupted sign-in shows as signed in')
    shot('interrupted')
    note(
      'restart found the saved attempt without a listener, wiped it and said so; nothing was exchanged',
    )
  })

  await step('Cancel a sign-in in progress', async ({ note, shot }) => {
    needsBrowser()
    ensureApp()
    const authorizeBefore = count('authorize')
    const tokensBefore = count('token')
    hermes.hold()
    await startSignIn()
    await expectAuthorize(authorizeBefore + 1)
    await sleep(1000)
    await device.key('KEYCODE_BACK')
    await tapRevealed('Cancel sign-in', 'Cancel sign-in')
    await device.waitFor(
      'Sign-in was cancelled. Nothing was saved.',
      'the cancelled notice',
    )
    hermes.release()
    shot('cancelled')
    if (count('token') !== tokensBefore)
      throw new Error('A cancelled attempt exchanged a code')
    note(
      'cancel stopped the listener; the attempt reported "Sign-in was cancelled" and saved nothing',
    )
  })
}

let hermes: FakeHermesAuth | undefined
try {
  prepareDevice()
  if (suite === 'demo') {
    await demoSuite()
  } else {
    hermes = await startFakeHermesAuth()
    await signinSuite(hermes)
  }
} catch (error) {
  steps.push({
    name: 'Test harness',
    status: 'failed',
    seconds: 0,
    detail: [error instanceof Error ? error.message : String(error)],
    evidence: [],
  })
} finally {
  await hermes?.close()
}

/** The report is written even when the device stopped answering. */
function deviceInfo(read: () => string): string {
  try {
    return read().trim()
  } catch {
    return 'unavailable'
  }
}

const issues = audits.flatMap((audit) =>
  audit.issues.map((issue) => ({ screen: audit.screen, ...issue })),
)
const measured = audits.reduce((sum, audit) => sum + audit.checked, 0)
steps.push({
  name: 'Touch targets are at least 48dp',
  // Nothing measured is not a pass.
  status: issues.length > 0 || measured === 0 ? 'failed' : 'passed',
  seconds: 0,
  detail:
    issues.length > 0
      ? issues.map(
          (issue) =>
            `${issue.screen}: "${issue.label}" ${issue.widthDp}x${issue.heightDp}dp (${issue.className})`,
        )
      : [
          measured === 0
            ? 'no screen was measured'
            : `${measured} targets on ${audits.length} screens`,
        ],
  evidence: [],
})

const report = {
  suite,
  apk,
  device: {
    model: deviceInfo(() => device.shell('getprop ro.product.model')),
    release: deviceInfo(() => device.shell('getprop ro.build.version.release')),
    sdk: deviceInfo(() => device.shell('getprop ro.build.version.sdk')),
    density: deviceInfo(() => String(device.density())),
    size: deviceInfo(() => device.shell('wm size')),
  },
  steps,
  audits,
  authEvents: hermes?.events ?? [],
}
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
const summary = [
  `### Emulator tests: ${suite} (${report.device.model}, Android ${report.device.release}, API ${report.device.sdk})`,
  '',
  '| Step | Result | Notes |',
  '| --- | --- | --- |',
  ...steps.map(
    (s) => `| ${s.name} | ${s.status} | ${s.detail.join('<br>').replace(/\|/g, '\\|')} |`,
  ),
  '',
].join('\n')
writeFileSync(join(outDir, 'summary.md'), summary)
console.log(`\n${summary}`)
const stepSummary = env('GITHUB_STEP_SUMMARY')
if (stepSummary) writeFileSync(stepSummary, summary, { flag: 'a' })
for (const blocked of steps.filter((s) => s.status === 'blocked'))
  console.log(`::warning::Blocked: ${blocked.name}: ${blocked.detail.at(-1) ?? ''}`)
process.exit(steps.some((s) => s.status === 'failed') ? 1 : 0)
