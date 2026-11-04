/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto'
import { base64Url } from '@cindl/hermes-adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeHermesAuth, type FakeHermesAuth } from '../e2e/fakeHermesAuth.ts'
import { runExitCode } from '../e2e/outcome.ts'
import { holdingTokens, sharedPreferences, tokenStorage } from '../e2e/keystore.ts'
import {
  auditLine,
  auditTargets,
  center,
  commonAncestor,
  find,
  findAll,
  findTappable,
  focusedNode,
  hiddenBeneath,
  imeWindow,
  keyboardFocusIn,
  interactiveWithin,
  label,
  linkTapPoints,
  near,
  onDestination,
  overlayOpen,
  scrimOf,
  tabsWhole,
  rawPixel,
  reachable,
  resetMove,
  screenToDevice,
  wholeView,
  parseDisplaySize,
  parseUi,
  TERMS_PROMPT,
  tapPoint,
  tapTarget,
  touchTargetsRow,
  type TargetAudit,
  visibleKeyboard,
} from '../e2e/ui.ts'

const PKG = 'dev.fl1nt.cindl'
const node = (attrs: Record<string, string>, children = '') => {
  const all = {
    text: '',
    'resource-id': '',
    class: 'android.view.ViewGroup',
    package: PKG,
    'content-desc': '',
    clickable: 'false',
    'long-clickable': 'false',
    checkable: 'false',
    checked: 'false',
    enabled: 'true',
    focused: 'false',
    scrollable: 'false',
    bounds: '[0,0][0,0]',
    ...attrs,
  }
  const attributes = Object.entries(all)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
  return children ? `<node ${attributes}>${children}</node>` : `<node ${attributes} />`
}
const dump = (body: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${body}</hierarchy>`

// density 320 → 2px per dp, so 48dp = 96px.
const screen = dump(
  node(
    { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
    [
      node({ 'content-desc': 'Send', clickable: 'true', bounds: '[900,2200][996,2296]' }),
      node({ 'content-desc': 'Tiny', clickable: 'true', bounds: '[10,10][90,96]' }),
      node({
        class: 'android.widget.EditText',
        'content-desc': 'Message Hermes',
        text: 'Draft &amp; more',
        bounds: '[0,2200][880,2296]',
      }),
      node(
        {
          class: 'android.widget.TextView',
          text: 'A paragraph with a link',
          clickable: 'true',
          bounds: '[0,400][1000,440]',
        },
        node({
          class: 'android.widget.Button',
          'content-desc': 'a link',
          clickable: 'true',
          bounds: '[700,400][1000,440]',
        }),
      ),
      node({
        class: 'android.widget.TextView',
        text: 'Retry',
        clickable: 'true',
        bounds: '[0,600][120,640]',
      }),
      node(
        {
          class: 'android.widget.ScrollView',
          scrollable: 'true',
          bounds: '[0,500][1080,1500]',
        },
        node({
          'content-desc': 'Half visible',
          clickable: 'true',
          bounds: '[0,1460][400,1500]',
        }),
      ),
      node({
        'content-desc': 'Other app',
        package: 'com.android.chrome',
        clickable: 'true',
        bounds: '[0,0][10,10]',
      }),
    ].join(''),
  ),
)

describe('UI Automator dumps', () => {
  it('reads a value uiautomator quotes with \' because it holds a " (CI run 41656607631)', () => {
    // The delete warning as the run's 17-memory-…-failed.xml has it (synthetic entry).
    const root = parseUi(
      dump(
        `<node index="1" text='Delete “The kiln firing log lives in the studio inventory sheet, tab "Firings".” from Hermes&apos;s memory? Hermes keeps no backup, so this cannot be undone.' resource-id="" class="android.widget.TextView" package="dev.fl1nt.cindl" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[108,1033][974,1245]" drawing-order="2" hint="" />`,
      ),
    )
    const warning = find(root, (text) => text.startsWith('Delete “The kiln'))
    expect(warning?.text).toBe(
      'Delete “The kiln firing log lives in the studio inventory sheet, tab "Firings".” from Hermes\'s memory? Hermes keeps no backup, so this cannot be undone.',
    )
    expect(warning?.className).toBe('android.widget.TextView')
    expect(warning?.bounds).toEqual({ left: 108, top: 1033, right: 974, bottom: 1245 })
  })

  it('reads each attribute in order, whatever another value holds', () => {
    const root = parseUi(
      dump(
        node(
          { text: 'a &gt; b, and text=&quot;x&quot; ', 'content-desc': "it's > 1" },
          '',
        ) +
          `<node text='quoted "twice"' content-desc="plain" class="android.widget.TextView" package="${PKG}" bounds="[1,2][3,4]" />`,
      ),
    )
    const [first, second] = root.children
    expect(first?.text).toBe('a > b, and text="x" ')
    expect(first?.desc).toBe("it's > 1")
    expect(second?.text).toBe('quoted "twice"')
    expect(second?.desc).toBe('plain')
    expect(second?.bounds).toEqual({ left: 1, top: 2, right: 3, bottom: 4 })
  })

  it('parses the tree, decodes entities and finds by label', () => {
    const root = parseUi(screen)
    const composer = find(root, (text) => text.startsWith('Message '))
    expect(composer?.text).toBe('Draft & more')
    expect(composer && label(composer)).toBe('Message Hermes')
    expect(findAll(root, /^(Send|Tiny)$/).map(label)).toEqual(['Send', 'Tiny'])
    const scrolled = find(root, 'Half visible')
    expect(scrolled?.parent?.scrollable).toBe(true)
    expect(scrolled && tapTarget(scrolled)).toBe(scrolled)
    expect(center({ left: 900, top: 2200, right: 996, bottom: 2296 })).toEqual({
      x: 948,
      y: 2248,
    })
  })

  it('flags app targets under 48dp, skipping inline links and their paragraph, clipped rows and other apps', () => {
    const audit = auditTargets(parseUi(screen), { pkg: PKG, density: 320 })
    expect(audit).toMatchObject({ checked: 4, skippedClipped: 1, exemptInline: 2 })
    expect(audit.issues).toEqual([
      {
        label: 'Tiny',
        className: 'android.view.ViewGroup',
        widthDp: 40,
        heightDp: 43,
        bounds: { left: 10, top: 10, right: 90, bottom: 96 },
      },
      // A clickable TextView with no link in it (delta check of c6ce4d3, N2).
      {
        label: 'Retry',
        className: 'android.widget.TextView',
        widthDp: 60,
        heightDp: 20,
        bounds: { left: 0, top: 600, right: 120, bottom: 640 },
      },
    ])
    expect(
      auditTargets(parseUi(screen), { pkg: PKG, density: 320, minDp: 40 }).issues.map(
        (issue) => issue.label,
      ),
    ).toEqual(['Retry'])
  })

  it('recognises terms prompts so the tests stop instead of accepting', () => {
    for (const text of ['Accept & continue', 'Google Terms of Service', 'I agree'])
      expect(TERMS_PROMPT.test(text)).toBe(true)
    expect(TERMS_PROMPT.test('Signed in')).toBe(false)
  })
})

describe('the screen each step starts from (CI run 41656607631)', () => {
  // Lines from that run's dumps: the app's window, Talk with no conversation
  // yet (selected), and Work; and a dialog's scrim as the fixed build reports
  // it (its testID as resource-id, neither clickable nor focusable; pending the
  // next emulator run), beside the one that run had.
  const WINDOW = `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" drawing-order="0" hint="">`
  const SCRIM = `<node NAF="true" index="0" text="" resource-id="cindl-scrim" class="android.view.ViewGroup" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" drawing-order="1" hint="" />`
  const OLD_SCRIM = SCRIM.replace('resource-id="cindl-scrim"', 'resource-id=""')
    .replace('clickable="false"', 'clickable="true"')
    .replace('focusable="false"', 'focusable="true"')
  const EMPTY = `<node index="0" text="No conversations yet." resource-id="" class="android.widget.TextView" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[358,988][722,1041]" drawing-order="1" hint="" />`
  const TALK = `<node index="4" text="" resource-id="" class="android.view.View" package="${PKG}" content-desc="Talk" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="true" bounds="[0,2127][270,2274]" drawing-order="4" hint=""></node>`
  const WORK = `<node index="5" text="" resource-id="" class="android.view.View" package="${PKG}" content-desc="Work" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[270,2127][540,2274]" drawing-order="5" hint=""></node>`

  it('counts Talk with no conversation yet as Talk: selected, though it has no composer', () => {
    const root = parseUi(dump(`${WINDOW}${EMPTY}${TALK}${WORK}</node>`))
    expect(onDestination(root, 'Talk')).toBe(true)
    expect(onDestination(root, 'Work')).toBe(false)
    expect(find(root, (text) => text.startsWith('Message '))).toBeUndefined()
  })

  it("sees a dialog or sheet left open by its scrim, which would take a step's first tap", () => {
    const open = parseUi(dump(`${WINDOW}${SCRIM}${TALK}${WORK}</node>`))
    expect(overlayOpen(open)).toBe(true)
    expect(scrimOf(open)).toMatchObject({ clickable: false, focusable: false })
    expect(overlayOpen(parseUi(dump(`${WINDOW}${EMPTY}${TALK}${WORK}</node>`)))).toBe(
      false,
    )
  })

  it("takes none of Android's own ids for a scrim: every screen's frames carry them", () => {
    // The frames over every dump of Cindl (CI run 41712256173,
    // 19-memory-delete-warning.xml; password="false" as Android writes it).
    const FRAMES = [
      `<node index="0" text="" resource-id="${PKG}:id/action_bar_root" class="android.widget.LinearLayout" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" drawing-order="1" hint="">`,
      `<node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]" drawing-order="2" hint="">`,
    ].join('')
    const bare = parseUi(
      dump(`${WINDOW}${FRAMES}${EMPTY}${TALK}${WORK}</node></node></node>`),
    )
    expect(overlayOpen(bare)).toBe(false)
    const open = parseUi(
      dump(`${WINDOW}${FRAMES}${SCRIM}${TALK}${WORK}</node></node></node>`),
    )
    expect(scrimOf(open)?.resourceId).toBe('cindl-scrim')
  })

  it("takes no clickable view over the whole window for a scrim: only the scrim's id tells it", () => {
    // The scrim as CI run 41712256173 had it, before focusable={false}: a bare
    // clickable leaf over the window, as any full-window control could be.
    expect(overlayOpen(parseUi(dump(`${WINDOW}${OLD_SCRIM}${TALK}${WORK}</node>`)))).toBe(
      false,
    )
  })
})

describe('the touch targets the owner can reach (CI run 41668168848)', () => {
  // Nodes from that run's demo/16-link-confirmation.xml (password="false" as
  // Android writes it). React Native flattened the dialog's frame, so under one
  // container sit the app's content (drawing order 2), the scrim's branch (3)
  // and the dialog's card (4); the reply's paragraph and its link span are in
  // the content, beneath the scrim.
  const attrs = (more: string, id = '') =>
    `resource-id="${id}" package="${PKG}" checkable="false" checked="false" enabled="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" hint="" ${more}`
  const WINDOW = `<node index="0" text="" class="android.widget.FrameLayout" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="0"')}>`
  const CONTAINER = `<node index="0" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="1"')}>`
  const EMPTY = `<node index="0" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="1"')} />`
  const SCRIM_BRANCH = `<node index="1" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="3"')}>`
  // The scrim as the fixed build reports it (pending the next emulator run).
  const SCRIM = `<node NAF="true" index="0" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="1"', 'cindl-scrim')} />`
  const CONTENT = `<node index="2" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="2"')}>`
  const PARAGRAPH = `<node index="2" text="Harbor Loft (fictional) has its directions on the venue page (harbor-loft.example.test). They also sent a floor plan:" class="android.widget.TextView" content-desc="" clickable="false" focusable="true" ${attrs('bounds="[42,784][1038,991]" drawing-order="3"')}>`
  const SPAN = `<node index="0" text="" class="android.widget.Button" content-desc="the venue page" clickable="true" focusable="true" ${attrs('bounds="[854,784][1038,853]" drawing-order="0"')} />`
  const CARD = `<node index="3" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[53,894][1028,1443]" drawing-order="4"')}>`
  const TITLE = `<node index="0" text="Open this link?" class="android.view.View" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[108,949][974,1018]" drawing-order="1"')} />`
  const CANCEL = `<node index="3" text="" class="android.widget.Button" content-desc="Cancel" clickable="true" focusable="true" ${attrs('bounds="[412,1261][600,1387]" drawing-order="4"')}></node>`
  const OPEN = `<node index="4" text="" class="android.widget.Button" content-desc="Open in browser" clickable="true" focusable="true" ${attrs('bounds="[622,1261][973,1387]" drawing-order="5"')}></node>`
  const DENSITY = { pkg: PKG, density: 420 }
  const issues = (root: ReturnType<typeof parseUi>) =>
    auditTargets(root, DENSITY).issues.map(
      (issue) => `${issue.label} ${issue.widthDp}x${issue.heightDp}dp`,
    )

  it('measures only the open dialog, not the reply beneath its scrim, which TalkBack cannot reach', () => {
    const root = parseUi(
      dump(
        `${WINDOW}${CONTAINER}${EMPTY}${SCRIM_BRANCH}${SCRIM}</node>${CONTENT}${PARAGRAPH}${SPAN}</node></node>${CARD}${TITLE}${CANCEL}${OPEN}</node></node></node>`,
      ),
    )
    expect(issues(root)).toEqual([])
    expect(auditTargets(root, DENSITY).checked).toBe(2)
    expect(reachable(root).map(label)).toEqual([
      '',
      'Open this link?',
      'Cancel',
      'Open in browser',
    ])
  })

  it('reaches only the overlay on top when one is open over another (a dialog over the margin)', () => {
    // As the app draws them (overlay/Portal.tsx): each overlay inside its own
    // portal wrapper, the take-control dialog's drawn after the margin's sheet.
    const view = (order: number, bounds = '[0,0][1080,2400]') =>
      `<node index="0" text="" class="android.view.ViewGroup" content-desc="" clickable="false" focusable="false" ${attrs(`bounds="${bounds}" drawing-order="${order}"`)}>`
    const CLOSE = `<node index="0" text="" class="android.widget.Button" content-desc="Close the working margin" clickable="true" focusable="true" ${attrs('bounds="[930,1210][1070,1340]" drawing-order="1"')} />`
    const MARGIN = `${view(2)}${view(1)}${view(1)}${SCRIM}</node>${view(2, '[0,1200][1080,2400]')}${CLOSE}</node></node></node>`
    const DIALOG = `${view(3)}${view(1)}${view(1)}${SCRIM}</node>${CARD.replace('drawing-order="4"', 'drawing-order="2"')}${TITLE}${CANCEL}${OPEN}</node></node></node>`
    const full = parseUi(
      dump(`${WINDOW}${CONTAINER}${EMPTY}${MARGIN}${DIALOG}</node></node>`),
    )
    expect(reachable(full).map(label)).toEqual([
      '',
      'Open this link?',
      'Cancel',
      'Open in browser',
    ])
    // TalkBack is given the dialog alone; the margin beneath it is hidden too.
    expect(
      hiddenBeneath(full, parseUi(dump(`${WINDOW}${TITLE}${CANCEL}${OPEN}</node>`))),
    ).toMatchObject({ ok: true, leaked: [] })
    expect(
      hiddenBeneath(
        full,
        parseUi(dump(`${WINDOW}${CLOSE}${TITLE}${CANCEL}${OPEN}</node>`)),
      ),
    ).toMatchObject({ ok: false, leaked: ['Close the working margin'] })
  })

  it('measures every target when nothing is drawn above the scrim, as in a dump without drawing orders', () => {
    // 16-link-confirmation as a uiautomator without drawing orders would dump it.
    const xml = `${WINDOW}${CONTAINER}${EMPTY}${SCRIM_BRANCH}${SCRIM}</node>${CONTENT}${PARAGRAPH}${SPAN}</node></node>${CARD}${TITLE}${CANCEL}${OPEN}</node></node></node>`
    const root = parseUi(dump(xml.replaceAll(/ drawing-order="\d+"/g, '')))
    expect(overlayOpen(root)).toBe(true)
    expect(reachable(root).map(label)).toContain('Cancel')
    // Cancel and Open in browser: the scrim, no longer clickable, is no target.
    expect(auditTargets(root, DENSITY)).toMatchObject({
      checked: 2,
      exemptInline: 1,
      issues: [],
    })
  })

  it('sees in a compressed dump that TalkBack is given the dialog alone', () => {
    const full = parseUi(
      dump(
        `${WINDOW}${CONTAINER}${EMPTY}${SCRIM_BRANCH}${SCRIM}</node>${CONTENT}${PARAGRAPH}${SPAN}</node></node>${CARD}${TITLE}${CANCEL}${OPEN}</node></node></node>`,
      ),
    )
    // A compressed dump keeps only what is important for accessibility: the dialog.
    expect(
      hiddenBeneath(full, parseUi(dump(`${WINDOW}${TITLE}${CANCEL}${OPEN}</node>`))),
    ).toEqual({
      ok: true,
      shown: ['Open this link?', 'Cancel', 'Open in browser'],
      missing: [],
      leaked: [],
      beneath: 2,
    })
    // The reply beneath still given to TalkBack.
    expect(
      hiddenBeneath(
        full,
        parseUi(
          dump(`${WINDOW}${TITLE}${CANCEL}${OPEN}${PARAGRAPH}${SPAN}</node></node>`),
        ),
      ),
    ).toMatchObject({
      ok: false,
      leaked: [
        'Harbor Loft (fictional) has its directions on the venue page (harbor-loft.example.test). They also sent a floor plan:',
        'the venue page',
      ],
    })
    // One of the dialog's own labels not given.
    expect(
      hiddenBeneath(full, parseUi(dump(`${WINDOW}${TITLE}${OPEN}</node>`))),
    ).toMatchObject({ ok: false, missing: ['Cancel'] })
    // Nothing open: there is no overlay to hide anything.
    const reply = parseUi(
      dump(`${WINDOW}${CONTENT}${PARAGRAPH}${SPAN}</node></node></node>`),
    )
    expect(hiddenBeneath(reply, reply).ok).toBe(false)
  })

  it('proves nothing when nothing beneath the dialog can be told apart (delta check of 1eef0c9, SF1)', () => {
    // The same dump without drawing orders: `reachable` gives every node, so a
    // compressed dump holding everything (hiding broken) would pass. The real
    // 16-link-confirmation.xml of run 41681122382 gave ok, 27 shown, 0 beneath.
    const xml = `${WINDOW}${CONTAINER}${EMPTY}${SCRIM_BRANCH}${SCRIM}</node>${CONTENT}${PARAGRAPH}${SPAN}</node></node>${CARD}${TITLE}${CANCEL}${OPEN}</node></node></node>`
    const unordered = parseUi(dump(xml.replaceAll(/ drawing-order="\d+"/g, '')))
    expect(hiddenBeneath(unordered, unordered)).toMatchObject({ ok: false, beneath: 0 })
    // Even with only the dialog given, nothing beneath it was checked.
    expect(
      hiddenBeneath(unordered, parseUi(dump(`${WINDOW}${TITLE}${CANCEL}${OPEN}</node>`))),
    ).toMatchObject({ ok: false, beneath: 0 })
  })

  it("says whether a hardware keyboard's focus is in the dialog, on the screen beneath it, or on nothing", () => {
    const at = (focused: 'cancel' | 'span' | 'none') =>
      parseUi(
        dump(
          `${WINDOW}${CONTAINER}${EMPTY}${SCRIM_BRANCH}${SCRIM}</node>${CONTENT}${PARAGRAPH}${
            focused === 'span' ? SPAN.replace('focused="false"', 'focused="true"') : SPAN
          }</node></node>${CARD}${TITLE}${
            focused === 'cancel'
              ? CANCEL.replace('focused="false"', 'focused="true"')
              : CANCEL
          }${OPEN}</node></node></node>`,
        ),
      )
    expect(keyboardFocusIn(at('cancel'))).toBe('overlay')
    expect(focusedNode(at('cancel'))).toMatchObject({ desc: 'Cancel' })
    expect(keyboardFocusIn(at('span'))).toBe('beneath')
    expect(keyboardFocusIn(at('none'))).toBe('none')
  })

  // 22dp at density 420 (2.625px per dp).
  const TINY = `<node index="0" text="" class="android.widget.Button" content-desc="Tiny" clickable="true" focusable="true" ${attrs('bounds="[100,100][158,158]" drawing-order="1"')} />`

  it('counts a clickable view over the window that holds the screen as no scrim', () => {
    const holder = `<node index="0" text="" class="android.view.ViewGroup" content-desc="" clickable="true" focusable="true" ${attrs('bounds="[0,0][1080,2400]" drawing-order="1"')}>`
    const root = parseUi(dump(`${WINDOW}${holder}${TINY}</node></node>`))
    expect(overlayOpen(root)).toBe(false)
    expect(issues(root)).toEqual(['Tiny 22.1x22.1dp'])
  })

  it('counts every node when a clickable over the window has nothing drawn above it', () => {
    const cover = `<node index="1" text="" class="android.view.ViewGroup" content-desc="" clickable="true" focusable="true" ${attrs('bounds="[0,0][1080,2400]" drawing-order="2"')} />`
    const root = parseUi(dump(`${WINDOW}${CONTENT}${TINY}</node>${cover}</node>`))
    expect(issues(root)).toEqual(['Tiny 22.1x22.1dp'])
  })

  it('exempts a link inside a sentence (WCAG 2.5.8), and nothing that only looks like one', () => {
    // The reply with no dialog open, as 17-image-withheld.xml has it.
    const reply = parseUi(
      dump(`${WINDOW}${CONTENT}${PARAGRAPH}${SPAN}</node></node></node>`),
    )
    expect(auditTargets(reply, DENSITY)).toMatchObject({
      checked: 0,
      exemptInline: 1,
      issues: [],
    })
    // The same box as a button on its own: a target, and too small.
    expect(issues(parseUi(dump(`${WINDOW}${CONTENT}${SPAN}</node></node>`)))).toEqual([
      'the venue page 70.1x26.3dp',
    ])
    // A label the paragraph does not say, or a box outside it: targets.
    const unsaid = SPAN.replace(
      'content-desc="the venue page"',
      'content-desc="Floor plan"',
    )
    expect(
      issues(
        parseUi(dump(`${WINDOW}${CONTENT}${PARAGRAPH}${unsaid}</node></node></node>`)),
      ),
    ).toEqual(['Floor plan 70.1x26.3dp'])
    const outside = SPAN.replace(
      'bounds="[854,784][1038,853]"',
      'bounds="[854,960][1038,1029]"',
    )
    expect(
      issues(
        parseUi(dump(`${WINDOW}${CONTENT}${PARAGRAPH}${outside}</node></node></node>`)),
      ),
    ).toEqual(['the venue page 70.1x26.3dp'])
  })

  it('measures a link that is all its paragraph says: it is in no sentence', () => {
    const alone = (text: string) =>
      issues(
        parseUi(
          dump(
            `${WINDOW}${CONTENT}${PARAGRAPH.replace(/text="[^"]*"/, `text="${text}"`)}${SPAN}</node></node></node>`,
          ),
        ),
      )
    expect(alone('the venue page')).toEqual(['the venue page 70.1x26.3dp'])
    expect(alone(' the venue page. ')).toEqual(['the venue page 70.1x26.3dp'])
    expect(alone('See the venue page')).toEqual([])
    // Cindl shows every link's host after it: that is the link's, not a sentence
    // (delta check of 1eef0c9, SF2). A link alone on its line, or alone in a list
    // item, is a target.
    expect(alone('the venue page (harbor-loft.example.test)')).toEqual([
      'the venue page 70.1x26.3dp',
    ])
    expect(alone('the venue page (harbor-loft.example.test).')).toEqual([
      'the venue page 70.1x26.3dp',
    ])
    expect(alone('See the venue page (harbor-loft.example.test)')).toEqual([])
    expect(alone('the venue page (harbor-loft.example.test) has the directions')).toEqual(
      [],
    )
  })
})

describe("the working margin's tabs at 200% font (review 4bdfe6c1, B-1)", () => {
  // At density 420 (2.625px per dp): 48dp is 126px. uiautomator clips each
  // node's bounds to its parents, so a cut tab shows as a small one.
  const node = (more: string, children = '') =>
    `<node index="0" text="" resource-id="" class="android.view.ViewGroup" package="${PKG}" checkable="false" checked="false" enabled="true" focusable="false" focused="false" long-clickable="false" password="false" hint="" ${more}>${children}</node>`
  const tab = (name: string, bounds: string, selected = false) =>
    node(
      `content-desc="${name}" clickable="true" scrollable="false" selected="${selected}" bounds="${bounds}" drawing-order="1"`,
    )
  const header = (row: string, bounds: string, scrollable = false) =>
    node(
      `content-desc="" clickable="false" scrollable="false" selected="false" bounds="[0,1100][1080,1500]" drawing-order="1"`,
      node(
        `content-desc="Working margin" clickable="false" scrollable="${scrollable}" selected="false" bounds="${bounds}" drawing-order="1"`,
        row,
      ),
    )
  const tabsOf = (xml: string) => {
    const root = parseUi(dump(xml))
    return ['Waiting 2', 'Step', 'Computer'].map((name) => {
      const found = find(root, name)
      if (!found) throw new Error(`no tab ${name}`)
      return found
    })
  }

  it('passes tabs that wrapped onto a second row, each whole', () => {
    const wrapped = header(
      tab('Waiting 2', '[0,1100][420,1240]', true) +
        tab('Step', '[420,1100][700,1240]') +
        tab('Computer', '[0,1240][409,1380]'),
      '[0,1100][930,1380]',
    )
    expect(tabsWhole(tabsOf(wrapped), 420)).toEqual([])
  })

  it('fails tabs in a row that scrolls, as without wrap, though their bounds stay on screen', () => {
    // Computer scrolled partly off: clipped to the row's right edge.
    const scrolling = header(
      tab('Waiting 2', '[0,1100][420,1240]', true) +
        tab('Step', '[420,1100][700,1240]') +
        tab('Computer', '[700,1100][760,1240]'),
      '[0,1100][760,1240]',
      true,
    )
    expect(tabsWhole(tabsOf(scrolling), 420)).toEqual([
      '"Waiting 2" is in a row that scrolls, so it can be out of view',
      '"Step" is in a row that scrolls, so it can be out of view',
      '"Computer" is in a row that scrolls, so it can be out of view',
      '"Computer" measures 22.9x53.3dp, under 48dp',
    ])
  })

  it('fails a tab cut by a header held short, its second row clipped', () => {
    // A header held at 80dp (210px): the second row shows 16dp of Computer.
    const held = header(
      tab('Waiting 2', '[0,1100][420,1240]', true) +
        tab('Step', '[420,1100][700,1240]') +
        tab('Computer', '[0,1268][409,1310]'),
      '[0,1100][930,1310]',
    )
    expect(tabsWhole(tabsOf(held), 420)).toEqual([
      '"Computer" measures 155.8x16.0dp, under 48dp',
    ])
  })
})

describe('tapping an inline link (CI run 41656607631)', () => {
  // The demo reply's "the venue page" link and its paragraph, as that run dumped
  // them: the link's box runs from "the" to the paragraph's right edge.
  const link = { left: 854, top: 784, right: 1038, bottom: 853 }
  const paragraph = { left: 42, top: 784, right: 1038, bottom: 991 }

  it('lands on the first glyphs, not the middle of the box (blank past "the")', () => {
    const { first } = linkTapPoints(link, paragraph)
    expect(first).toEqual({ x: 870, y: 819 })
    // "the" ends near x=919; the box's centre, where the run tapped, does not.
    expect(first.x).toBeLessThan(919)
    expect(center(link).x).toBeGreaterThan(919)
  })

  it('also lands on the second line of a link that wraps, and only then', () => {
    expect(linkTapPoints(link, paragraph).wrapped).toEqual({ x: 58, y: 888 })
    // Ends before the paragraph's edge: the link does not wrap.
    expect(
      linkTapPoints({ left: 300, top: 784, right: 600, bottom: 853 }, paragraph).wrapped,
    ).toBeUndefined()
    // On the paragraph's last line: nothing below to wrap onto.
    expect(
      linkTapPoints({ left: 854, top: 922, right: 1038, bottom: 991 }, paragraph).wrapped,
    ).toBeUndefined()
    // A box narrower than the inset: still inside it.
    expect(
      linkTapPoints({ left: 1010, top: 784, right: 1038, bottom: 853 }, paragraph).first
        .x,
    ).toBe(1024)
  })
})

describe('tapping only what a tap can reach (CI run 41593367518)', () => {
  // The question card at the moment that run failed (sanitized from its UI dump): both answers
  // chosen, "Send answers" scrolled out of view below the list, the composer and the "Latest"
  // button drawn over the bottom of the screen.
  const questionCard = (sendAnswers: string) =>
    parseUi(
      dump(
        node(
          { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' },
          [
            node(
              {
                class: 'android.widget.ScrollView',
                scrollable: 'true',
                bounds: '[0,409][1080,1947]',
              },
              [
                node({
                  class: 'android.widget.RadioButton',
                  'content-desc': 'Harbor Loft (fictional)',
                  clickable: 'true',
                  checkable: 'true',
                  checked: 'true',
                  bounds: '[92,409][993,436]',
                }),
                node({
                  class: 'android.widget.CheckBox',
                  'content-desc': 'Floor plan',
                  clickable: 'true',
                  checkable: 'true',
                  checked: 'true',
                  bounds: '[92,1261][993,1387]',
                }),
                node({
                  class: 'android.widget.Button',
                  'content-desc': 'Skip this question',
                  clickable: 'true',
                  bounds: '[700,1800][1000,1900]',
                }),
                node({
                  class: 'android.widget.Button',
                  'content-desc': 'Send answers',
                  clickable: 'true',
                  bounds: sendAnswers,
                }),
              ].join(''),
            ),
            node({
              class: 'android.widget.Button',
              'content-desc': 'Jump to latest messages',
              clickable: 'true',
              bounds: '[815,1789][1049,1915]',
            }),
            node({
              class: 'android.widget.EditText',
              'content-desc': 'Message Hermes',
              clickable: 'true',
              bounds: '[79,1983][886,2109]',
            }),
          ].join(''),
        ),
      ),
    )

  it('does not tap a node that is scrolled out of view', () => {
    const root = questionCard('[687,2054][993,1947]')
    const send = find(root, 'Send answers')
    expect(send).toBeDefined()
    if (!send) return
    // What the harness tapped before: the middle of inverted bounds, which is the composer.
    const old = center(tapTarget(send).bounds)
    expect(old).toEqual({ x: 840, y: 2001 })
    expect(find(root, (_text, n) => n.className.endsWith('EditText'))?.bounds).toEqual({
      left: 79,
      top: 1983,
      right: 886,
      bottom: 2109,
    })
    expect(tapPoint(root, send)).toBeUndefined()
    expect(findTappable(root, 'Send answers')).toBeUndefined()
  })

  it('does not tap a node under an overlay, and taps visible ones in their middle', () => {
    const root = questionCard('[687,2054][993,1947]')
    // Its middle (850, 1850) is under the "Latest" button.
    expect(findTappable(root, 'Skip this question')).toBeUndefined()
    expect(findTappable(root, 'Floor plan')?.point).toEqual({ x: 543, y: 1324 })
    // 27px of the chosen answer is still visible at the top edge: enough to aim at its middle.
    expect(findTappable(root, 'Harbor Loft (fictional)')?.point).toEqual({
      x: 543,
      y: 423,
    })
  })

  it('does not aim at a sliver under 24px', () => {
    const root = parseUi(
      dump(
        node(
          {
            class: 'android.widget.ScrollView',
            scrollable: 'true',
            bounds: '[0,409][1080,1947]',
          },
          node({
            'content-desc': 'Orchard Barn (fictional)',
            clickable: 'true',
            bounds: '[92,1930][993,1947]',
          }),
        ),
      ),
    )
    expect(findTappable(root, 'Orchard Barn (fictional)')).toBeUndefined()
  })

  it('taps the button once it has been scrolled into view', () => {
    const root = questionCard('[687,1500][993,1626]')
    expect(findTappable(root, 'Send answers')?.point).toEqual({ x: 840, y: 1563 })
  })
})

describe('fake Hermes auth server (SYNTHETIC test double)', () => {
  let hermes: FakeHermesAuth | undefined
  afterEach(async () => {
    await hermes?.close()
    hermes = undefined
  })

  const authorize = async (server: FakeHermesAuth, verifier: string) => {
    const url = new URL('/auth/native/authorize', server.origin)
    url.searchParams.set(
      'code_challenge',
      base64Url(createHash('sha256').update(verifier).digest()),
    )
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('redirect_uri', 'http://127.0.0.1:41234/callback')
    url.searchParams.set('state', 'state-1')
    return fetch(url, { redirect: 'manual' })
  }

  it('redirects with a one-time code and exchanges it only for the right verifier', async () => {
    hermes = await startFakeHermesAuth()
    const verifier = base64Url(randomBytes(32))
    const response = await authorize(hermes, verifier)
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('http://127.0.0.1:41234/callback')
    expect(location.searchParams.get('state')).toBe('state-1')
    const code = location.searchParams.get('code') ?? ''
    const exchange = (body: Record<string, string>) =>
      fetch(`${hermes?.origin}/auth/native/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await exchange({ code, code_verifier: 'wrong'.repeat(9) })).status).toBe(400)
    // A code is single-use, even after a failed attempt.
    expect((await exchange({ code, code_verifier: verifier })).status).toBe(400)
    const second = new URL(
      (await authorize(hermes, verifier)).headers.get('location') ?? '',
    )
    const ok = await exchange({
      code: second.searchParams.get('code') ?? '',
      code_verifier: verifier,
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ token_type: 'bearer', provider: 'basic' })
    expect(hermes.events.map((event) => `${event.kind}:${event.status}`)).toEqual([
      'authorize:302',
      'token:400',
      'token:400',
      'authorize:302',
      'token:200',
    ])
    // The log is evidence: no codes, verifiers or tokens in it.
    expect(JSON.stringify(hermes.events)).not.toMatch(
      /synthetic-(code|access|refresh)|state-1/,
    )
  })

  it('holds authorize responses until released', async () => {
    hermes = await startFakeHermesAuth()
    hermes.hold()
    const pending = authorize(hermes, base64Url(randomBytes(32)))
    expect(await hermes.waitFor('authorize', 1, 2000)).toBe(true)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    expect(hermes.release()).toBe(1)
    expect((await pending).status).toBe(302)
    expect(await hermes.waitFor('token', 1, 50)).toBe(false)
  })

  it('rejects an authorize request without S256 PKCE or a loopback redirect', async () => {
    hermes = await startFakeHermesAuth()
    const url = new URL('/auth/native/authorize', hermes.origin)
    url.searchParams.set('redirect_uri', 'https://example.test/callback')
    url.searchParams.set('code_challenge', 'x')
    url.searchParams.set('code_challenge_method', 'plain')
    url.searchParams.set('state', 's')
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(400)
  })
})

describe('read-only cards', () => {
  // Two cards in a list: a prompt Cindl does not answer, then an approval with buttons.
  const list = parseUi(
    dump(
      node(
        {
          class: 'android.widget.ScrollView',
          scrollable: 'true',
          bounds: '[0,0][1080,2000]',
        },
        [
          node(
            { bounds: '[32,100][1048,500]' },
            [
              node({
                class: 'android.widget.TextView',
                'content-desc': 'Answer outside Cindl: sudo password',
                text: 'sudo password',
                bounds: '[64,140][1000,200]',
              }),
              node({
                class: 'android.widget.TextView',
                text: 'Hermes is waiting for a sudo password.',
                bounds: '[64,220][1000,400]',
              }),
            ].join(''),
          ),
          node(
            { bounds: '[32,540][1048,900]' },
            [
              node({
                class: 'android.widget.TextView',
                'content-desc': 'Approval needed: Run the export',
                text: 'Run the export',
                bounds: '[64,580][1000,640]',
              }),
              node({
                'content-desc': 'Deny',
                clickable: 'true',
                bounds: '[600,780][800,876]',
              }),
            ].join(''),
          ),
        ].join(''),
      ),
    ),
  )

  it('finds the card around a title and its text, and what can be tapped in it', () => {
    const title = find(list, 'Answer outside Cindl: sudo password')
    const text = find(list, (t) => t.startsWith('Hermes is waiting'))
    if (!title || !text) throw new Error('fixture nodes missing')
    const card = commonAncestor(title, text)
    expect(card?.bounds).toEqual({ left: 32, top: 100, right: 1048, bottom: 500 })
    expect(card && interactiveWithin(card)).toEqual([])
    const approval = find(list, 'Approval needed: Run the export')
    const deny = find(list, 'Deny')
    if (!approval || !deny) throw new Error('fixture nodes missing')
    const other = commonAncestor(approval, deny)
    expect(other && interactiveWithin(other).map(label)).toEqual(['Deny'])
  })
})

describe('reading the screen back', () => {
  /** A raw `screencap` of a 3x2 screen; Android 9 and later add a colour-space word. */
  const capture = (withColourSpace: boolean) => {
    const header = new DataView(new ArrayBuffer(withColourSpace ? 16 : 12))
    header.setUint32(0, 3, true)
    header.setUint32(4, 2, true)
    header.setUint32(8, 1, true)
    const pixels = new Uint8Array(3 * 2 * 4)
    // (2, 1) is the demo's orange marker; the rest is the desktop teal.
    for (let i = 0; i < 6; i++)
      pixels.set(i === 5 ? [230, 120, 40, 255] : [47, 93, 98, 255], i * 4)
    return new Uint8Array([...new Uint8Array(header.buffer), ...pixels])
  }

  it('reads a pixel from a raw capture with either header', () => {
    for (const withColourSpace of [false, true]) {
      expect(rawPixel(capture(withColourSpace), 2, 1)).toEqual([230, 120, 40])
      expect(rawPixel(capture(withColourSpace), 0, 0)).toEqual([47, 93, 98])
      expect(rawPixel(capture(withColourSpace), 3, 0)).toBeUndefined()
    }
    const other = capture(false)
    other[8] = 2
    expect(rawPixel(other, 0, 0)).toBeUndefined()
  })

  it('maps a point of the agent screen to the device, centred with its aspect kept', () => {
    // A 640x400 picture in a 1000x700 view at (40, 100): scaled by 1.5625, centred vertically.
    const bounds = { left: 40, top: 100, right: 1040, bottom: 800 }
    expect(screenToDevice(bounds, { width: 640, height: 400 }, { x: 0, y: 0 })).toEqual({
      x: 41,
      y: 138,
    })
    expect(
      screenToDevice(bounds, { width: 640, height: 400 }, { x: 639, y: 399 }),
    ).toEqual({
      x: 1039,
      y: 762,
    })
  })

  it('refuses a live view the tab bar clipped, which would map the picture wrong (CI run 41668168848)', () => {
    const screen = { width: 640, height: 400 }
    // The live view as that run dumped it, cut by the tab bar at y=2124: the demo's
    // and the real build's. Whole, it is 990 px wide and 619 tall (the screen's ratio).
    const demo = { left: 45, top: 1754, right: 1035, bottom: 2124 }
    const signin = { left: 45, top: 1840, right: 1035, bottom: 2124 }
    for (const clipped of [demo, signin]) {
      expect(wholeView(clipped, screen)).toBe(false)
      // Mapped as it was, the desktop's (20, 200) fell inside the window: device
      // 263,1940 and 327,1982, the grid colour.
      expect(() => screenToDevice(clipped, screen, { x: 20, y: 200 })).toThrow(/clipped/)
    }
    const whole = { ...demo, bottom: 1754 + 619 }
    expect(wholeView(whole, screen)).toBe(true)
    // On the teal desktop, left of the window (which starts near x=200 on the device).
    expect(screenToDevice(whole, screen, { x: 20, y: 200 })).toEqual({ x: 77, y: 2064 })
    // The tap marker's point, under the window.
    expect(screenToDevice(whole, screen, { x: 320, y: 376 })).toEqual({ x: 541, y: 2337 })
  })

  it('compares colours with a tolerance for scaling', () => {
    expect(near([50, 90, 100], [47, 93, 98])).toBe(true)
    expect(near([230, 120, 40], [47, 93, 98])).toBe(false)
    expect(near(undefined, [47, 93, 98])).toBe(false)
  })
})

describe('how a run ends (review of 636a2dd, S2)', () => {
  it('fails the run when a step is blocked, as when one fails: green means every step passed', () => {
    expect(runExitCode([{ status: 'passed' }, { status: 'passed' }])).toBe(0)
    expect(runExitCode([{ status: 'passed' }, { status: 'failed' }])).toBe(1)
    // A browser's terms screen blocks the PKCE step and every sign-in step after it:
    // the tests never accept terms, and the job must not go green without a sign-in.
    expect(
      runExitCode([{ status: 'passed' }, { status: 'blocked' }, { status: 'blocked' }]),
    ).toBe(1)
  })
})

describe('where the app keeps the Hermes tokens (read as root on the emulator)', () => {
  // SecureStore.xml as expo-secure-store writes it, with synthetic ciphertext.
  const tokenKey = 'cindl.s.636c'
  const item = (ct: string) =>
    JSON.stringify({
      ct,
      iv: 'c3ludGhldGljLWl2',
      tlen: 128,
      scheme: 'aes',
      usesKeystoreSuffix: true,
      keystoreAlias: 'key_v1',
      requireAuthentication: false,
    }).replace(/"/g, '&quot;')
  const xml = (ct?: string) =>
    [
      "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
      '<map>',
      ...(ct === undefined
        ? []
        : [`    <string name="key_v1-${tokenKey}">${item(ct)}</string>`]),
      '    <string name="key_v1-cindl.s.6f74686572">&quot;x&quot;</string>',
      '</map>',
    ].join('\n')

  it('reads SharedPreferences strings with XML entities', () => {
    const prefs = sharedPreferences(xml('YWJj'))
    expect(JSON.parse(prefs.get(`key_v1-${tokenKey}`) ?? '{}')).toMatchObject({
      scheme: 'aes',
      keystoreAlias: 'key_v1',
    })
  })

  const app = '/data/data/dev.fl1nt.cindl'
  const ACCESS = 'synthetic-access-token-0001'
  const REFRESH = 'synthetic-refresh-token-0001'
  const files = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([path, text]) => [`${app}${path}`, text]))

  it('says the token set is stored as Keystore AES ciphertext, without the value', () => {
    const before = tokenStorage({
      files: files({
        '/shared_prefs/SecureStore.xml': xml('YWJj'),
        '/databases/RKStorage': 'SQLite format 3 drafts and settings',
      }),
      tokenKey,
      tokens: [ACCESS, REFRESH],
    })
    expect(before).toMatchObject({
      stored: true,
      encrypted: true,
      scheme: 'aes',
      keystoreAlias: 'key_v1',
      searched: [`${app}/shared_prefs/SecureStore.xml`, `${app}/databases/RKStorage`],
      tokensSearched: 2,
      plaintextIn: [],
      plaintext: false,
    })
    expect(before.fingerprint).toMatch(/^[0-9a-f]{12}$/)
    // Facts only: neither the ciphertext nor a token leaves the device.
    const evidence = JSON.stringify(before)
    for (const value of ['YWJj', ACCESS, REFRESH]) expect(evidence).not.toContain(value)
    // A refreshed token set is encrypted again: another ciphertext.
    const after = tokenStorage({
      files: files({ '/shared_prefs/SecureStore.xml': xml('ZGVm') }),
      tokenKey,
      tokens: [ACCESS, REFRESH],
    })
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('finds an issued token in plain text in any file, with or without field names', () => {
    const found = tokenStorage({
      files: files({
        '/shared_prefs/SecureStore.xml': xml('YWJj'),
        // A bare token in a database journal: no field name to give it away.
        '/databases/RKStorage-wal': `\u0000\u0001${REFRESH}\u0000`,
        '/files/settings.json': '{"access_token":"x"}',
        '/cache/notes.txt': 'nothing here',
      }),
      tokenKey,
      tokens: [ACCESS, REFRESH],
    })
    expect(found.plaintext).toBe(true)
    expect(found.plaintextIn).toEqual([
      `${app}/databases/RKStorage-wal`,
      `${app}/files/settings.json`,
    ])
    expect(JSON.stringify(found)).not.toContain(REFRESH)
  })

  it('finds the device logs that hold an issued token', () => {
    const logs = new Map([
      ['logcat-01-install.txt', 'I ReactNativeJS: connected to Hermes'],
      ['logcat-02-sign-in.txt', `D ReactNativeJS: tokens ${ACCESS}`],
      ['logcat-03-refresh.txt', 'I ReactNativeJS: refreshed'],
    ])
    expect(holdingTokens(logs, [ACCESS, REFRESH])).toEqual(['logcat-02-sign-in.txt'])
    expect(holdingTokens(logs, [''])).toEqual([])
  })

  it('says a signed-out device keeps no token set', () => {
    expect(
      tokenStorage({
        files: files({ '/shared_prefs/SecureStore.xml': xml() }),
        tokenKey,
        tokens: [ACCESS, REFRESH],
      }),
    ).toMatchObject({
      stored: false,
      encrypted: false,
      plaintext: false,
      fingerprint: undefined,
    })
  })
})

describe('the 48dp row (delta check of c6ce4d3)', () => {
  const audit = (checked: number, more: Partial<TargetAudit> = {}): TargetAudit => ({
    checked,
    skippedClipped: 0,
    exemptInline: 0,
    issues: [],
    ...more,
  })

  it('fails on a screen where no target was measured, though others were', () => {
    expect(
      touchTargetsRow([
        { screen: '02-talk', ...audit(5) },
        { screen: '16-link-confirmation', ...audit(0) },
      ]),
    ).toEqual({ status: 'failed', detail: ['16-link-confirmation: no target measured'] })
    expect(auditLine('16-link-confirmation', audit(0))).toBe(
      '16-link-confirmation: 0 targets checked, 0 under 48dp, 0 exempt as inline, nothing measured (fails the 48dp row)',
    )
  })

  it("says on each screen's line how many targets were exempt as inline (N4)", () => {
    expect(
      auditLine('Agent output reply', audit(17, { exemptInline: 1, skippedClipped: 2 })),
    ).toBe(
      'Agent output reply: 17 targets checked, 0 under 48dp, 1 exempt as inline, 2 partly scrolled off (not measured)',
    )
  })

  it('fails on a target under 48dp and on a run that audited nothing; passes otherwise', () => {
    const tiny = {
      label: 'Tiny',
      className: 'android.widget.Button',
      widthDp: 22.1,
      heightDp: 22.1,
      bounds: { left: 100, top: 100, right: 158, bottom: 158 },
    }
    expect(
      touchTargetsRow([{ screen: '02-talk', ...audit(5, { issues: [tiny] }) }]),
    ).toEqual({
      status: 'failed',
      detail: ['02-talk: "Tiny" 22.1x22.1dp (android.widget.Button)'],
    })
    expect(touchTargetsRow([])).toEqual({
      status: 'failed',
      detail: ['no screen was measured'],
    })
    expect(
      touchTargetsRow([
        { screen: '02-talk', ...audit(5) },
        { screen: '03-work', ...audit(4) },
      ]),
    ).toEqual({ status: 'passed', detail: ['9 targets on 2 screens'] })
  })
})

describe('a keyboard on screen, not only shown (CI run 41681122382)', () => {
  // That run's "Chat with the on-screen keyboard open" passed on a keyboard Android
  // called shown, with its top at 2400 px on a 1080x2400 display, while
  // 23-keyboard.png shows none. Its artifact holds no dumpsys text, so these blocks
  // follow AOSP's full window dump (`dumpsys window windows`) with that run's
  // display and keyboard (LatinIME, uid 10113); the values are illustrative.
  const DISPLAY = { width: 1080, height: 2400 }
  const ime = (
    options: {
      view?: string
      surface?: string
      isVisible?: string
      onScreen?: string
      frame?: string
      content?: number
      seen?: number
    } = {},
  ) => {
    const {
      view = '0x0',
      surface = 'true',
      isVisible = 'true',
      onScreen = 'true',
      frame = '[0,1377][1080,2400]',
      content = 0,
      seen = content,
    } = options
    return [
      '  Window #7 Window{8c1f2e3 u0 InputMethod}:',
      '    mDisplayId=0 rootTaskId=1 mSession=Session{4ad2b1c 1290:u0a10113} mClient=android.os.BinderProxy@6e1f2a7',
      '    mOwnerUid=10113 showForAllUsers=true package=com.android.inputmethod.latin appop=NONE',
      '    mAttrs={(0,0)(fillxwrap) gr=BOTTOM CENTER_VERTICAL sim={adjust=pan} ty=INPUT_METHOD fmt=TRANSPARENT wanim=0x1030056',
      '      fl=NOT_FOCUSABLE LAYOUT_IN_SCREEN SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS}',
      '    Requested w=1080 h=1023 mLayoutSeq=412',
      '    mIsImWindow=true mIsWallpaper=false mIsFloatingLayer=true',
      `    mViewVisibility=${view} mHaveFrame=true mObscured=false`,
      `    mGivenContentInsets=[0,${content}][0,0] mGivenVisibleInsets=[0,${seen}][0,0]`,
      '    mTouchableInsets=3 mGivenInsetsPending=false',
      `    mHasSurface=${surface} isReadyForDisplay()=${surface} mWindowRemovalAllowed=false`,
      `    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=${frame} last=${frame} insetsChanged=false`,
      '     surface=[0,0][0,0]',
      `    isOnScreen=${onScreen}`,
      `    isVisible=${isVisible}`,
    ].join('\n')
  }
  // The app's own window around it, visible, over the whole display.
  const APP = [
    '  Window #6 Window{623897a u0 dev.fl1nt.cindl/dev.fl1nt.cindl.MainActivity}:',
    '    mViewVisibility=0x0 mHaveFrame=true mObscured=false',
    '    mGivenContentInsets=[0,0][0,0] mGivenVisibleInsets=[0,0][0,0]',
    '    mHasSurface=true isReadyForDisplay()=true mWindowRemovalAllowed=false',
    '    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,0][1080,2400] last=[0,0][1080,2400] insetsChanged=false',
    '    isVisible=true',
  ].join('\n')
  const NAV = '  Window #8 Window{3b1d9e4 u0 NavigationBar0}:\n    mViewVisibility=0x0'
  const windows = (block: string) =>
    `WINDOW MANAGER WINDOWS (dumpsys window windows)\n${APP}\n${block}\n${NAV}\n`
  const read = (block: string, inputMethod = 'mInputShown=true') =>
    visibleKeyboard(imeWindow(windows(block)), inputMethod, DISPLAY)

  it('finds a keyboard on screen: its top inside the display and some height below it', () => {
    expect(read(ime())).toEqual({
      windowUp: true,
      visible: true,
      top: 1377,
      height: 1023,
      geometry:
        'window view 0x0, surface true, isVisible true, isOnScreen true; frame [0,1377][1080,2400]; content inset top 0, visible inset top 0; input_method says shown; display 1080x2400',
    })
    // The insets it gives move its top down; the smaller of them counts.
    expect(read(ime({ content: 120, seen: 60 }))).toMatchObject({
      top: 1437,
      height: 963,
    })
    // Without any flag in input_method: the window decides.
    expect(read(ime(), '')).toMatchObject({ visible: true, top: 1377 })
  })

  it('finds none where Android says shown but nothing is on screen', () => {
    // That run's case: its input view hidden, so its insets reach the frame's bottom.
    expect(read(ime({ content: 1023 }))).toEqual({
      windowUp: true,
      visible: false,
      geometry:
        'window view 0x0, surface true, isVisible true, isOnScreen true; frame [0,1377][1080,2400]; content inset top 1023, visible inset top 1023; input_method says shown; display 1080x2400',
    })
    // Off the screen: laid out below the display.
    expect(read(ime({ frame: '[0,2400][1080,3423]' })).visible).toBe(false)
    // No height.
    expect(read(ime({ frame: '[0,2400][1080,2400]' })).visible).toBe(false)
    expect(read(ime({ frame: '[0,1377][1080,1377]' })).visible).toBe(false)
    // Stale "shown": the window gone, its last frame still printed.
    expect(read(ime({ view: '0x8', surface: 'false', isVisible: 'false' })).visible).toBe(
      false,
    )
    expect(read(ime({ isVisible: 'false' })).visible).toBe(false)
    expect(read(ime({ surface: 'false' })).visible).toBe(false)
  })

  it('finds none in a strip, off to the side, or not on screen (delta check of 1eef0c9, note 1)', () => {
    // A 1 px strip at the bottom, and the 126 px navigation strip Android's
    // keyboard shows without its keys: under 15% of the display's height.
    expect(read(ime({ frame: '[0,2399][1080,2400]' })).visible).toBe(false)
    expect(read(ime({ frame: '[0,2274][1080,2400]' })).visible).toBe(false)
    // The same height, off to the right of the display.
    expect(read(ime({ frame: '[2000,1377][3080,2400]' })).visible).toBe(false)
    expect(read(ime({ frame: '[-200,1377][880,2400]' })).visible).toBe(false)
    // Laid out, but Android says it is not on screen; or does not say.
    expect(read(ime({ onScreen: 'false' })).visible).toBe(false)
    expect(read(ime().replace('    isOnScreen=true\n', '')).visible).toBe(false)
    // At the floor, 15% of 2400 px, it counts; just under, it does not.
    expect(read(ime({ frame: '[0,2040][1080,2400]' }))).toMatchObject({
      visible: true,
      height: 360,
    })
    expect(read(ime({ frame: '[0,2041][1080,2400]' })).visible).toBe(false)
  })

  it("reads only the keyboard's own window, and fails closed without it or the display", () => {
    // The app's window is visible over the whole display; it is not the keyboard.
    expect(
      visibleKeyboard(imeWindow(`${APP}\n${NAV}\n`), 'mInputShown=true', DISPLAY),
    ).toEqual({
      windowUp: false,
      visible: false,
      geometry: 'no input method window; input_method says shown; display 1080x2400',
    })
    expect(imeWindow(windows(ime()))).not.toContain('MainActivity')
    expect(imeWindow(windows(ime()))).not.toContain('NavigationBar0')
    expect(visibleKeyboard(imeWindow(windows(ime())), '', undefined).visible).toBe(false)
    // An older release's frame line.
    expect(
      visibleKeyboard(
        ime().replace(
          /Frames: .*/,
          'mFrame=[0,1377][1080,2400] last=[0,1377][1080,2400]',
        ),
        '',
        DISPLAY,
      ),
    ).toMatchObject({ visible: true, top: 1377, height: 1023 })
  })

  it('reads the display size, an override first', () => {
    expect(parseDisplaySize('Physical size: 1080x2400\n')).toEqual(DISPLAY)
    expect(
      parseDisplaySize('Physical size: 1080x2400\nOverride size: 720x1600\n'),
    ).toEqual({
      width: 720,
      height: 1600,
    })
    expect(parseDisplaySize('')).toBeUndefined()
  })
})

describe("the reset at each step's start (CI run 41696032323)", () => {
  // That run's demo steps 1-3 passed. Step 3 typed in the conversation search
  // (the keyboard shown at 18:55:02, hidden by back at 18:55:03) and ended on
  // a relaunched Talk (11-relaunched.xml, whose nodes these are: the composer
  // not focused, nothing open). Step 4's reset then pressed back on that bare
  // Talk (Cindl's activity closed at 18:55:24, no keyboard shown in the step),
  // kept pressing it over the launcher, and every later step failed the same
  // way. Its likely cause, inferred (the artifact does not show which flag was
  // set): the input method's own flag still said shown. (password="false" as
  // Android writes it; the run's artifact has it masked by its own scrub.)
  const attrs = (more: string) =>
    `resource-id="" package="${PKG}" checkable="false" checked="false" enabled="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" hint="" ${more}`
  const TALK_AFTER_RELAUNCH = dump(
    [
      `<node index="0" text="" class="android.widget.FrameLayout" content-desc="" clickable="false" focusable="false" ${attrs('bounds="[0,0][1080,2400]" drawing-order="0"')}>`,
      `<node index="1" text="" class="android.widget.Button" content-desc="Today, Main. Switch conversation" clickable="true" focusable="true" ${attrs('bounds="[21,201][390,327]" drawing-order="2"')} />`,
      `<node index="8" text="Message Hermes" class="android.widget.EditText" content-desc="Message Hermes" clickable="true" focusable="true" ${attrs('bounds="[76,1837][742,1963]" drawing-order="9"')} />`,
      `<node index="5" text="" class="android.view.View" content-desc="Talk" clickable="true" focusable="true" ${attrs('bounds="[0,2127][270,2274]" drawing-order="5"').replace('selected="false"', 'selected="true"')} />`,
      `<node index="7" text="" class="android.view.View" content-desc="Library" clickable="true" focusable="true" ${attrs('bounds="[540,2127][810,2274]" drawing-order="7"')} />`,
      `<node index="8" text="" class="android.view.View" content-desc="Agent" clickable="true" focusable="true" ${attrs('bounds="[810,2127][1080,2274]" drawing-order="8"')} />`,
      '</node>',
    ].join(''),
  )
  // A keyboard hidden after use, as we expect Android to report it. Not taken
  // from a run (neither artifact holds dumpsys text): this is the premise the
  // next runner evidence is to confirm. Its window gone, while the input
  // method's own dump still holds mIsInputViewShown=true (InputMethodService
  // updates it only while its window is visible).
  const HIDDEN_KEYBOARD = [
    'WINDOW MANAGER WINDOWS (dumpsys window windows)',
    '  Window #7 Window{8c1f2e3 u0 InputMethod}:',
    '    mViewVisibility=0x8 mHaveFrame=true mObscured=false',
    '    mGivenContentInsets=[0,0][0,0] mGivenVisibleInsets=[0,0][0,0]',
    '    mHasSurface=false isReadyForDisplay()=false mWindowRemovalAllowed=false',
    '    Frames: parent=[0,0][1080,2400] display=[0,0][1080,2400] frame=[0,1377][1080,2400] last=[0,1377][1080,2400] insetsChanged=false',
    '    isOnScreen=false',
    '    isVisible=false',
  ].join('\n')
  const STALE_FLAG = '  mShowInputRequested=false\n  mIsInputViewShown=true mStatusIcon=0'
  const DISPLAY = { width: 1080, height: 2400 }

  it('takes no decision on the input method flag left set after the keyboard hid', () => {
    expect(
      visibleKeyboard(imeWindow(HIDDEN_KEYBOARD), STALE_FLAG, DISPLAY),
    ).toMatchObject({ windowUp: false, visible: false })
    expect(overlayOpen(parseUi(TALK_AFTER_RELAUNCH))).toBe(false)
  })

  it('leaves a bare Talk alone, relaunches Cindl over another app, and presses back only in Cindl', () => {
    const keyboardUp = visibleKeyboard(
      imeWindow(HIDDEN_KEYBOARD),
      STALE_FLAG,
      DISPLAY,
    ).windowUp
    const overlay = overlayOpen(parseUi(TALK_AFTER_RELAUNCH))
    expect(resetMove({ cindlInFront: true, overlay, keyboardUp })).toBe('done')
    // The launcher in front: Cindl comes back; system back there does nothing useful.
    for (const left of [
      { overlay: false, keyboardUp: false },
      { overlay: true, keyboardUp: true },
    ])
      expect(resetMove({ cindlInFront: false, ...left })).toBe('relaunch')
    // A sheet or dialog left open, or the keyboard's window up, in Cindl: back.
    expect(resetMove({ cindlInFront: true, overlay: true, keyboardUp: false })).toBe(
      'back',
    )
    expect(resetMove({ cindlInFront: true, overlay: false, keyboardUp: true })).toBe(
      'back',
    )
  })

  it('brings every step of that order back to Cindl with nothing open, where the old reset left the app', () => {
    // Android as the reset sees it: back on a bare Talk leaves the app; back on
    // the launcher does nothing; relaunching brings Cindl back as it was.
    type Device = { front: 'cindl' | 'launcher'; overlay: boolean; keyboardUp: boolean }
    const press = (device: Device, move: 'relaunch' | 'back' | 'done'): Device => {
      if (move === 'relaunch') return { ...device, front: 'cindl' }
      if (move !== 'back' || device.front !== 'cindl') return device
      if (device.keyboardUp) return { ...device, keyboardUp: false }
      if (device.overlay) return { ...device, overlay: false }
      return { ...device, front: 'launcher' }
    }
    const reset = (
      start: Device,
      decide: (device: Device) => 'relaunch' | 'back' | 'done',
    ) => {
      let device = start
      for (let tries = 0; tries < 6; tries++) {
        const move = decide(device)
        if (move === 'done') return device
        device = press(device, move)
      }
      return undefined
    }
    const now = (device: Device) =>
      resetMove({
        cindlInFront: device.front === 'cindl',
        overlay: device.front === 'cindl' && device.overlay,
        keyboardUp: device.front === 'cindl' && device.keyboardUp,
      })
    // c6ce4d3..1eef0c9: back while a dump or the flag says something is open,
    // whatever is in front; the flag is the input method's (stale after use).
    const before = (stale: boolean) => (device: Device) =>
      device.overlay || device.keyboardUp || stale ? 'back' : 'done'
    const starts: Device[] = [
      // After step 3: a relaunched bare Talk, the keyboard hidden after use.
      { front: 'cindl', overlay: false, keyboardUp: false },
      // A step left a sheet open, or the keyboard up.
      { front: 'cindl', overlay: true, keyboardUp: false },
      { front: 'cindl', overlay: false, keyboardUp: true },
      // A step left the app: the launcher in front.
      { front: 'launcher', overlay: false, keyboardUp: false },
    ]
    for (const start of starts)
      expect(reset(start, now)).toEqual({
        front: 'cindl',
        overlay: false,
        keyboardUp: false,
      })
    // The old reset, after the keyboard was used once: the app left at every start.
    expect(reset(starts[0] as Device, before(true))).toBeUndefined()
    expect(reset(starts[3] as Device, before(false))).toEqual(starts[3])
  })
})
