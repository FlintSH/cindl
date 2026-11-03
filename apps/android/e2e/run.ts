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
 * screen) is reported as blocked, never accepted, and a blocked step fails the
 * run (e2e/outcome.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { SYNTHETIC_DEMO_LABEL } from '@cindl/contracts'
import { createDevice, PACKAGE } from './device.ts'
import { startFakeHermes, type FakeHermes } from '@cindl/fixtures/fake-hermes'
import { startFakeHermesAuth, type FakeHermesAuth } from './fakeHermesAuth.ts'
import { runExitCode, type StepStatus } from './outcome.ts'
import {
  center,
  commonAncestor,
  find,
  findAll,
  flatten,
  height,
  interactiveWithin,
  label,
  matches,
  near,
  screenToDevice,
  TERMS_PROMPT,
  type Match,
  type TargetAudit,
  type UiNode,
  width,
} from './ui.ts'

interface Step {
  name: string
  status: StepStatus
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

/** The demo's synthetic screen (packages/fixtures/src/scenario/screen.ts). */
const DEMO_SCREEN = { width: 640, height: 400 }
const DESKTOP_TEAL = [47, 93, 98]
const MARKER_ORANGE = [230, 120, 40]

/** The synthetic sudo prompt in the "Kiln inventory sheet" conversation, as TalkBack reads its title. */
const SUDO_PROMPT =
  'Answer outside Cindl: sudo password to restart the label printer (fictional)'

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
      // A prompt Cindl never answers: what Hermes waits for, and nothing to send.
      const prompt = await device.reveal(SUDO_PROMPT, 'the prompt Cindl does not answer')
      const promptText = find(prompt.root, (text) =>
        text.startsWith('Hermes is waiting for a sudo password.'),
      )
      const promptCard = promptText && commonAncestor(prompt.node, promptText)
      if (!promptCard)
        throw new Error('The sudo prompt card does not say what Hermes waits for')
      const offered = interactiveWithin(promptCard)
      if (offered.length)
        throw new Error(
          `The sudo prompt card offers something to send: ${offered.map((n) => label(n) || n.className).join(', ')}`,
        )
      shot('prompt-outside-cindl')
      note('the sudo prompt reads "Answer outside Cindl" and offers nothing to send')
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

  await step(
    'Agent output: a link asks before opening, an image is withheld',
    async ({ note, shot, audit }) => {
      await startOnTalk()
      await device.tap(
        (text) => text.endsWith('Switch conversation'),
        'the conversation switcher',
      )
      await device.tap('Search conversations', 'the conversation search')
      await device.type('offsite')
      if (device.keyboard().shown) await device.key('KEYCODE_BACK')
      await device.tap(
        (text) => text.startsWith('Studio offsite planning'),
        'the offsite conversation',
      )
      // The link shows where it goes next to its text.
      const reply = await device.reveal(
        (text) => text.includes('the venue page (harbor-loft.example.test)'),
        'the reply with a link',
      )
      // A link is a span of the paragraph; React Native gives it an accessibility node
      // of its own (what TalkBack activates), which is where a finger must land.
      const link = findAll(reply.root, 'the venue page').find(
        (node) =>
          node !== reply.node && width(node.bounds) > 0 && height(node.bounds) > 0,
      )
      if (!link)
        throw new Error('The link "the venue page" has no node of its own to tap')
      await device.tapAt(center(link.bounds))
      const dialog = await device.waitFor('Open this link?', 'the link confirmation')
      for (const expected of [
        'This opens harbor-loft.example.test in your browser:',
        'https://harbor-loft.example.test/visit',
      ])
        if (!find(dialog.root, expected))
          throw new Error(`The link confirmation does not show "${expected}"`)
      shot('link-confirmation')
      await audit('Link confirmation', dialog.root)
      await device.tap('Cancel', 'Cancel')
      await device.waitUntilGone('Open this link?', 'The link confirmation')
      const focus = device.shell('dumpsys window | grep -E "mCurrentFocus" || true')
      if (!focus.includes(`${PACKAGE}/`))
        throw new Error(`Cancel left the app: ${focus.trim()}`)
      note(
        'the link showed its host; tapping it asked first with the full address; Cancel opened nothing',
      )

      await device.reveal(
        'Image from harbor-loft.example.test not shown. (Harbor Loft floor plan)',
        'the withheld image',
      )
      shot('image-withheld')
      note(
        'the floor plan image was not loaded; its placeholder names harbor-loft.example.test',
      )
      await device.key('KEYCODE_BACK')
      await device.waitFor(
        (text) => text.endsWith(', Main. Switch conversation'),
        'the main conversation',
      )
    },
  )

  await step(
    'Memory: a warned delete and a reviewed edit',
    async ({ note, shot, audit }) => {
      await startOnTalk()
      await openDestination('Library', named('Skills'))
      await device.tap(
        (text, node) => text === 'Memory' && node.clickable,
        'the Memory tab',
      )
      await tapRevealed(
        (text) => text.startsWith('Open memory entry: The kiln firing log'),
        'the kiln firing log entry',
      )
      // Deleting asks first and says it is permanent; keeping the entry sends nothing.
      await tapRevealed('Delete entry…', 'Delete entry')
      // The confirmation names the entry it deletes.
      const warning = await device.waitFor(
        (text) =>
          text.startsWith('Delete “The kiln firing log') &&
          text.includes('Hermes keeps no backup, so this cannot be undone.'),
        'the delete warning naming the entry',
      )
      shot('memory-delete-warning')
      await audit('Memory delete warning', warning.root)
      await device.tap('Keep it', 'Keep it')
      await device.waitUntilGone(
        (text) => text.includes('Hermes keeps no backup'),
        'The delete warning',
      )
      note('delete asked first, said it cannot be undone, and Keep it kept the entry')

      // An edit is reviewed as a diff against the text that was read, then confirmed.
      await tapRevealed('Edit', 'Edit')
      const field = await device.waitFor('Edit agent note 2', 'the entry editor')
      await device.tapNode(field.node)
      await device.key('KEYCODE_MOVE_END')
      await device.type(' Checked on Monday.')
      if (device.keyboard().shown) await device.key('KEYCODE_BACK')
      await tapRevealed('Review changes', 'Review changes')
      await device.waitFor(
        (text) => text.startsWith('Review before saving: 1 line added, 1 removed.'),
        'the reviewed diff',
      )
      shot('memory-review')
      await tapRevealed('Confirm and save', 'Confirm and save')
      await device.reveal('Restore previous version', 'the saved entry')
      shot('memory-saved')
      note('the edit was reviewed as a diff (1 line added, 1 removed), then saved')
    },
  )

  await step(
    'Work: the agent screen, live, and a tap in control',
    async ({ note, shot, audit }) => {
      await startOnTalk()
      await openDestination('Work', named('Needs you'))
      const live = await device.reveal(
        (text) => text.startsWith('The agent’s screen, live.'),
        'the live screen',
      )
      // The synthetic screen's desktop (packages/fixtures/src/scenario/screen.ts), left of its window.
      const at = screenToDevice(live.node.bounds, DEMO_SCREEN, { x: 20, y: 200 })
      let colour = device.pixel(at.x, at.y)
      for (let tries = 0; tries < 20 && !near(colour, DESKTOP_TEAL); tries++) {
        await sleep(500)
        colour = device.pixel(at.x, at.y)
      }
      shot('agent-screen')
      await audit('Agent screen', await device.dump())
      if (!near(colour, DESKTOP_TEAL))
        throw new Error(
          `The synthetic picture is not drawn: ${JSON.stringify(colour)} at device ${at.x},${at.y}`,
        )
      note(
        `the synthetic picture is drawn: ${JSON.stringify(colour)} at screen (20, 200)`,
      )

      // In control, a tap draws the synthetic screen's pointer marker where it landed.
      await tapRevealed('Take control…', 'Take control')
      await device.tap('Take control now', 'Take control now')
      const controlled = await device.reveal(
        (text) => text.startsWith('The agent’s screen, live. You are in control'),
        'the screen in control',
      )
      const target = screenToDevice(controlled.node.bounds, DEMO_SCREEN, {
        x: 320,
        y: 376,
      })
      await device.tapAt(target)
      let marked = device.pixel(target.x, target.y)
      for (let tries = 0; tries < 20 && !near(marked, MARKER_ORANGE); tries++) {
        await sleep(500)
        marked = device.pixel(target.x, target.y)
      }
      shot('agent-screen-tap')
      await audit('Agent screen in control', await device.dump())
      if (!near(marked, MARKER_ORANGE))
        throw new Error(
          `A tap in control did not draw the marker: ${JSON.stringify(marked)} at device ${target.x},${target.y}`,
        )
      note('in control, a tap drew the synthetic screen’s orange marker where it landed')
      await tapRevealed('Give control back', 'Give control back')
      await device.reveal(
        (text) => text.startsWith('The agent’s screen, live. Watching.'),
        'the screen watched again',
      )
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

/**
 * The real build against two SYNTHETIC servers on the runner, reached through adb
 * reverse: the fixtures' fake `hermes serve` (sign-in, then the direct client
 * connected), and the e2e auth stand-in, whose authorize page can be held open so the
 * app can be killed or the sign-in cancelled while the browser waits.
 */
async function signinSuite(hermes: FakeHermes, holding: FakeHermesAuth) {
  const restCalls = (name: string) =>
    hermes.calls.filter((call) => call.name === name).length
  const isAddressField: Match = (text, node) =>
    /EditText$/.test(node.className) && text === 'Hermes address'
  // Connected: Talk with its composer, or Talk with no conversation yet (the fake starts empty).
  const isConnected: Match = (text, node) =>
    matches(node, isComposer) || text === 'No conversations yet.'

  const startSignIn = async (origin: string) => {
    const field = await device.reveal(isAddressField, 'the Hermes address field')
    if (field.node.text !== origin) {
      await device.tapAt(field.point)
      // The field may hold the last address (or show its hint): clear it first.
      await device.clearText(Math.max(field.node.text.length, 64))
      await device.type(origin)
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

  const browserStopped = async () => {
    const root = await device.dump()
    const terms = flatten(root).find((node) => TERMS_PROMPT.test(label(node)))
    if (!terms) return
    browserBlocked = `its own terms ("${label(terms).slice(0, 80)}")`
    // Leave the terms screen without answering it and return to Cindl.
    await device.key('KEYCODE_BACK')
    ensureApp()
    throw new Blocked(
      `The browser asks to accept ${browserBlocked}. The tests never accept terms; this needs the owner's approval.`,
    )
  }
  const waitForCount = async (count: () => number, target: number, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (count() >= target) return true
      await sleep(500)
    }
    return false
  }
  const expectAuthorize = async (reached: Promise<boolean>) => {
    if (await reached) return
    await browserStopped()
    throw new Error('The browser never requested /auth/native/authorize')
  }

  await step(
    'Install and launch the real (non-demo) APK',
    async ({ note, shot, audit }) => {
      installApk(apk as string)
      for (const port of [hermes.port, holding.port])
        device.run(['reverse', `tcp:${port}`, `tcp:${port}`])
      device.launch()
      const { root } = await device.waitFor(isAddressField, 'the sign-in screen', 90_000)
      if (!find(root, named('Sign in to Hermes')))
        throw new Error('The real build does not ask to sign in to Hermes')
      if (findAll(root, (text) => text.startsWith(SYNTHETIC_DEMO_LABEL)).length > 0)
        throw new Error('The real build shows the synthetic demo notice')
      shot('sign-in')
      await audit('Sign in', root)
      note('real build: asks for the Hermes address, no demo data')
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
      const chrome = /versionName=(\S+)/.exec(
        device.shell('dumpsys package com.android.chrome | grep versionName || true'),
      )
      note(`Chrome: ${chrome?.[1] ?? 'not installed'}`)
    },
  )

  await step(
    'Sign in with PKCE through the loopback callback, then connect',
    async ({ note, shot, audit }) => {
      ensureApp()
      const authorizeBefore = restCalls('GET /auth/native/authorize')
      const tokensBefore = restCalls('POST /auth/native/token')
      await startSignIn(hermes.origin)
      await expectAuthorize(
        waitForCount(
          () => restCalls('GET /auth/native/authorize'),
          authorizeBefore + 1,
          45_000,
        ),
      )
      // The fake refuses an authorize request without S256 PKCE or a 127.0.0.1 redirect,
      // and a code exchange whose verifier does not match the challenge.
      if (
        !(await waitForCount(
          () => restCalls('POST /auth/native/token'),
          tokensBefore + 1,
          45_000,
        ))
      )
        throw new Error('Cindl never exchanged the code')
      await device
        .waitFor('Signed in', "the listener's reply page in the browser", 20_000)
        .catch(() => undefined)
      shot('browser-signed-in')
      await device.key('KEYCODE_BACK')
      let result = await device
        .waitFor(isConnected, 'Talk, connected to the fake Hermes', 30_000)
        .catch(() => undefined)
      if (!result) {
        device.launch()
        result = await device.waitFor(
          isConnected,
          'Talk, connected to the fake Hermes',
          30_000,
        )
      }
      if (!hermes.calls.some((call) => call.kind === 'ws' && call.name === '/api/ws'))
        throw new Error('The app never opened the Hermes gateway socket')
      if (restCalls('POST /auth/native/token') !== tokensBefore + 1)
        throw new Error('The code was exchanged more than once')
      shot('connected')
      await audit('Connected', result.root)
      note(
        'callback received by the loopback listener; the adapter exchanged the code once and the direct client connected (/api/ws)',
      )
      signedInOnce = true
    },
  )

  await step('Chat through the direct client', async ({ note, shot }) => {
    needsSignIn()
    ensureApp()
    const root = await device.dump()
    if (!find(root, isComposer)) {
      await tapRevealed('Start a conversation', 'Start a conversation')
      await device.waitFor(isComposer, 'the composer of the new conversation', 30_000)
    }
    await device.tap(isComposer, 'the composer')
    await device.type('Hello from the emulator')
    if (device.keyboard().shown) await device.key('KEYCODE_BACK')
    await device.tap((text, node) => text === 'Send' && node.clickable, 'Send')
    await device.waitFor(
      (text) => text.includes('Synthetic reply (fixture) to: Hello from the emulator'),
      "the fake Hermes's reply",
      45_000,
    )
    if (
      !hermes.calls.some((call) => call.kind === 'rpc' && call.name === 'prompt.submit')
    )
      throw new Error('The message did not reach Hermes as prompt.submit')
    shot('chat-reply')
    note(
      'a message went to the fake Hermes over the gateway socket and its reply streamed back',
    )
  })

  await step('Sign-in survives process death', async ({ note, shot }) => {
    needsSignIn()
    const authorizeBefore = restCalls('GET /auth/native/authorize')
    await device.key('KEYCODE_HOME')
    await sleep(1000)
    device.shell(`am kill ${PACKAGE}`)
    await sleep(2000)
    if (device.pid()) throw new Error('am kill did not end the background process')
    device.launch()
    await device.waitFor(isConnected, 'Talk, connected again after a cold start', 60_000)
    if (restCalls('GET /auth/native/authorize') !== authorizeBefore)
      throw new Error('A cold start asked to sign in again')
    shot('connected-after-restart')
    note(
      'tokens read back from Keystore-backed storage after a cold start; connected again',
    )
  })

  await step('Sign out on this device', async ({ note, shot }) => {
    needsSignIn()
    ensureApp()
    await openDestination('Agent', named('SOUL.md'))
    await tapRevealed('Sign out on this device', 'Sign out on this device')
    const { root } = await device.waitFor(isAddressField, 'the sign-in screen', 30_000)
    if (!find(root, named('Signed out')))
      throw new Error('After signing out, the screen does not say so')
    shot('signed-out')
    note('signed out on this device; the sign-in screen is back')
  })

  await step('Process death while the browser is open', async ({ note, shot }) => {
    needsBrowser()
    ensureApp()
    const tokensBefore = holding.events.filter((event) => event.kind === 'token').length
    const authorizeBefore = holding.events.filter(
      (event) => event.kind === 'authorize',
    ).length
    holding.hold()
    await startSignIn(holding.origin)
    await expectAuthorize(holding.waitFor('authorize', authorizeBefore + 1, 45_000))
    const authorize = holding.events.filter((event) => event.kind === 'authorize').at(-1)
    note(`authorize: ${JSON.stringify(authorize?.detail)}`)
    if (
      authorize?.detail.challengeMethod !== 'S256' ||
      authorize.detail.hasState !== true
    )
      throw new Error('The authorize request lacked S256 PKCE or state')
    if (
      !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(String(authorize.detail.redirectUri))
    )
      throw new Error(`Unexpected redirect_uri ${String(authorize.detail.redirectUri)}`)
    await sleep(1500)
    shot('browser-waiting')
    device.shell(`am kill ${PACKAGE}`)
    await sleep(2000)
    let method = 'am kill (background process)'
    if (device.pid()) {
      device.run(['root'], 60_000)
      device.run(['wait-for-device'], 60_000)
      // adbd restarted as root, which drops the reverse port forwards.
      for (const port of [hermes.port, holding.port])
        device.run(['reverse', `tcp:${port}`, `tcp:${port}`])
      device.shell(`kill -9 ${device.pid()}`)
      await sleep(1500)
      method = 'kill -9 as root (am kill left it running)'
    }
    if (device.pid()) throw new Error('Could not end the app process')
    note(`app process ended with ${method} while the browser showed the authorize page`)
    holding.release()
    await sleep(3000)
    shot('browser-callback-refused')
    if (holding.events.filter((event) => event.kind === 'token').length !== tokensBefore)
      throw new Error('A code was exchanged for the interrupted attempt')
    await device.key('KEYCODE_BACK')
    await sleep(2000)
    if (!device.pid()) device.launch()
    const notice = await device.waitFor(
      (text) => text.startsWith('Cindl stopped waiting for the browser'),
      'the interrupted notice',
      60_000,
    )
    if (!find(notice.root, isAddressField))
      throw new Error('An interrupted sign-in does not leave the sign-in screen')
    shot('interrupted')
    note('restart found the unfinished attempt, said so, and nothing was exchanged')
  })

  await step('Cancel a sign-in in progress', async ({ note, shot }) => {
    needsBrowser()
    ensureApp()
    const tokensBefore = holding.events.filter((event) => event.kind === 'token').length
    const authorizeBefore = holding.events.filter(
      (event) => event.kind === 'authorize',
    ).length
    holding.hold()
    await startSignIn(holding.origin)
    await expectAuthorize(holding.waitFor('authorize', authorizeBefore + 1, 45_000))
    await sleep(1000)
    await device.key('KEYCODE_BACK')
    ensureApp()
    await tapRevealed('Cancel sign-in', 'Cancel sign-in')
    await device.waitFor(
      'Sign-in was cancelled. Nothing was saved.',
      'the cancelled notice',
    )
    holding.release()
    shot('cancelled')
    if (holding.events.filter((event) => event.kind === 'token').length !== tokensBefore)
      throw new Error('A cancelled attempt exchanged a code')
    note(
      'cancel stopped the listener; the sign-in reported "Sign-in was cancelled" and saved nothing',
    )
  })
}

let hermes: FakeHermes | undefined
let holding: FakeHermesAuth | undefined
try {
  prepareDevice()
  if (suite === 'demo') {
    await demoSuite()
  } else {
    hermes = await startFakeHermes()
    holding = await startFakeHermesAuth()
    await signinSuite(hermes, holding)
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
  await holding?.close()
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
  // Request shapes only: paths and RPC method names, never bodies, codes or tokens.
  fakeHermesCalls: hermes?.calls ?? [],
  authEvents: holding?.events ?? [],
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
// A blocked step fails the run too (outcome.ts): the tests never accept terms, and a
// job that could not do what it tests is not green.
for (const blocked of steps.filter((s) => s.status === 'blocked'))
  console.log(`::error::Blocked: ${blocked.name}: ${blocked.detail.at(-1) ?? ''}`)
process.exit(runExitCode(steps))
