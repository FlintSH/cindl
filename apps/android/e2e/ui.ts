/**
 * Pure helpers for the emulator tests: the UI Automator hierarchy dump, the
 * 48dp touch-target audit and the on-screen keyboard's position. No adb here,
 * so all of it is unit-tested (test/e2e.test.ts).
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface UiNode {
  text: string
  desc: string
  className: string
  pkg: string
  clickable: boolean
  longClickable: boolean
  checkable: boolean
  checked: boolean
  enabled: boolean
  focused: boolean
  scrollable: boolean
  /** Selected, as a bottom navigation item or a tab is (accessibilityState). */
  selected: boolean
  /** Where it is drawn among its siblings (a higher one is on top). */
  drawingOrder: number
  bounds: Rect
  parent?: UiNode
  children: UiNode[]
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decode(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_, entity: string) =>
      entity.startsWith('#x')
        ? String.fromCodePoint(parseInt(entity.slice(2), 16))
        : entity.startsWith('#')
          ? String.fromCodePoint(Number(entity.slice(1)))
          : (ENTITIES[entity] ?? ''),
  )
}

export function parseBounds(value: string): Rect {
  const [left = 0, top = 0, right = 0, bottom = 0] = [...value.matchAll(/-?\d+/g)].map(
    Number,
  )
  return { left, top, right, bottom }
}

/** Parses `uiautomator dump` output into a tree under a synthetic root. */
export function parseUi(xml: string): UiNode {
  const root: UiNode = {
    text: '',
    desc: '',
    className: 'hierarchy',
    pkg: '',
    clickable: false,
    longClickable: false,
    checkable: false,
    checked: false,
    enabled: true,
    focused: false,
    scrollable: false,
    selected: false,
    drawingOrder: 0,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    children: [],
  }
  const stack: UiNode[] = [root]
  // A quoted value may hold `>`, so a tag ends only outside quotes.
  for (const match of xml.matchAll(/<(\/?)node\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, closing, attrs = '', selfClosing] = match
    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }
    // uiautomator quotes a value with ' when it holds a " (and writes ' as &apos;),
    // so both quote styles occur; attributes are read in order, one after another.
    const values = new Map<string, string>()
    for (const [, name = '', double, single] of attrs.matchAll(
      /([\w-]+)=(?:"([^"]*)"|'([^']*)')/g,
    ))
      values.set(name, decode(double ?? single ?? ''))
    const get = (name: string) => values.get(name) ?? ''
    const flag = (name: string) => get(name) === 'true'
    const parent = stack[stack.length - 1] as UiNode
    const node: UiNode = {
      text: get('text'),
      desc: get('content-desc'),
      className: get('class'),
      pkg: get('package'),
      clickable: flag('clickable'),
      longClickable: flag('long-clickable'),
      checkable: flag('checkable'),
      checked: flag('checked'),
      enabled: flag('enabled'),
      focused: flag('focused'),
      scrollable: flag('scrollable'),
      selected: flag('selected'),
      drawingOrder: Number(get('drawing-order')) || 0,
      bounds: parseBounds(get('bounds')),
      parent,
      children: [],
    }
    parent.children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

export function flatten(root: UiNode): UiNode[] {
  const out: UiNode[] = []
  const walk = (node: UiNode) => {
    for (const child of node.children) {
      out.push(child)
      walk(child)
    }
  }
  walk(root)
  return out
}

/** What TalkBack reads first: the content description, else the text. */
export const label = (node: UiNode) => node.desc || node.text

/** The bottom navigation's item for a destination (its label may add ", 1 waiting on you"). */
export function navItem(root: UiNode, name: string): UiNode | undefined {
  const candidates = flatten(root).filter(
    (node) =>
      node.clickable && (label(node) === name || label(node).startsWith(`${name}, `)),
  )
  return candidates.sort((a, b) => b.bounds.bottom - a.bounds.bottom)[0]
}

/** The destination is the one selected in the bottom navigation. */
export const onDestination = (root: UiNode, name: string) =>
  navItem(root, name)?.selected === true

/**
 * A dialog or sheet is open: its scrim, a clickable node over the whole
 * window, takes every tap outside it (CI run 41656607631: a step's tap on the
 * bottom navigation closed the delete dialog left open instead).
 */
export function overlayOpen(root: UiNode): boolean {
  return scrimOf(root) !== undefined
}

/**
 * An open dialog's or sheet's scrim: a clickable node over the whole window
 * with nothing in it (the app's scrim is a bare Pressable). A clickable view
 * that holds the screen's content is not one.
 */
function scrimOf(root: UiNode): UiNode | undefined {
  const window = root.children[0]?.bounds
  if (!window) return undefined
  return flatten(root).find(
    (node) =>
      node.clickable &&
      node.children.length === 0 &&
      node.bounds.left <= window.left &&
      node.bounds.top <= window.top &&
      node.bounds.right >= window.right &&
      node.bounds.bottom >= window.bottom,
  )
}

/**
 * The nodes the owner can reach: all of them, or, while a dialog or sheet is
 * open, only those drawn above its scrim. The app hides everything beneath an
 * overlay from TalkBack (AppShell sets importantForAccessibility
 * "no-hide-descendants" on its content) and the scrim takes every touch
 * there, but uiautomator's dump still lists those nodes, because it includes
 * views that are not important for accessibility (CI run 41668168848,
 * 16-link-confirmation: the reply's link behind "Open this link?"). When
 * nothing is drawn above the scrim (a dump without drawing orders), it hides
 * nothing that can be told apart, and every node counts.
 */
export function reachable(root: UiNode): UiNode[] {
  const all = flatten(root)
  const scrim = scrimOf(root)
  if (!scrim) return all
  for (let branch = scrim; branch.parent; branch = branch.parent) {
    const level = branch.drawingOrder
    const above = branch.parent.children.filter(
      (sibling) => sibling !== branch && sibling.drawingOrder > level,
    )
    if (above.length) return above.flatMap((node) => [node, ...flatten(node)])
  }
  return all
}

/**
 * What TalkBack is given of a screen with a dialog or sheet open, from a
 * compressed dump of it (`uiautomator dump --compressed` lists only the views
 * important for accessibility) against the full dump of the same moment. The
 * overlay's labels (what `reachable` gives) must all be in it, and none of
 * the labels beneath it (a label in both counts as the overlay's). `ok` when
 * there is an overlay with labels, all of them shown, something beneath it to
 * hide, and none of that given. With nothing told apart beneath it (a dump
 * without drawing orders: `reachable` then gives every node), nothing is
 * proven, and `ok` is false.
 */
export function hiddenBeneath(
  full: UiNode,
  compressed: UiNode,
): {
  ok: boolean
  shown: string[]
  missing: string[]
  leaked: string[]
  beneath: number
} {
  const above = new Set(reachable(full))
  const labels = (nodes: UiNode[]) =>
    new Set(nodes.map(label).filter((text) => text.trim() !== ''))
  const overlay = labels([...above])
  const beneath = [...labels(flatten(full).filter((node) => !above.has(node)))].filter(
    (text) => !overlay.has(text),
  )
  const given = labels(flatten(compressed))
  const shown = [...overlay].filter((text) => given.has(text))
  const missing = [...overlay].filter((text) => !given.has(text))
  const leaked = beneath.filter((text) => given.has(text))
  return {
    ok:
      overlayOpen(full) &&
      shown.length > 0 &&
      beneath.length > 0 &&
      missing.length === 0 &&
      leaked.length === 0,
    shown,
    missing,
    leaked,
    beneath: beneath.length,
  }
}

/** The node a hardware keyboard's focus is on (`focused="true"`), if any. */
export const focusedNode = (root: UiNode) => flatten(root).find((node) => node.focused)

/**
 * Where a hardware keyboard's focus is while a dialog or sheet is open: on a
 * node drawn above its scrim (`reachable`), on the screen beneath it, or on
 * nothing.
 */
export function keyboardFocusIn(root: UiNode): 'overlay' | 'beneath' | 'none' {
  const node = focusedNode(root)
  if (node === undefined) return 'none'
  return reachable(root).includes(node) ? 'overlay' : 'beneath'
}

export type Match = string | RegExp | ((label: string, node: UiNode) => boolean)

export function matches(node: UiNode, match: Match): boolean {
  const own = label(node)
  if (typeof match === 'string') return own === match || node.text === match
  if (match instanceof RegExp) return match.test(own) || match.test(node.text)
  return match(own, node)
}

export function findAll(root: UiNode, match: Match): UiNode[] {
  return flatten(root).filter((node) => matches(node, match))
}

export function find(root: UiNode, match: Match): UiNode | undefined {
  return findAll(root, match)[0]
}

/** The nearest ancestor (or the node) a tap reaches: clickable, enabled. */
export function tapTarget(node: UiNode): UiNode {
  for (let current: UiNode | undefined = node; current; current = current.parent)
    if (current.clickable) return current
  return node
}

export const center = (rect: Rect) => ({
  x: Math.round((rect.left + rect.right) / 2),
  y: Math.round((rect.top + rect.bottom) / 2),
})

export const width = (rect: Rect) => rect.right - rect.left
export const height = (rect: Rect) => rect.bottom - rect.top

/**
 * Where a finger lands on an inline link. React Native gives a link span an
 * accessibility node whose box runs from the span's first glyph to the end of
 * its line (CI run 41656607631: "the venue page" is [854,784][1038,853] while
 * "the" ends near x=919), so only the box's left end is on the text: `first`
 * is just inside it. When the box reaches the paragraph's right edge and the
 * paragraph goes on below it, the span wraps, and `wrapped` is just inside the
 * start of the next line, where the span continues.
 */
export function linkTapPoints(
  link: Rect,
  paragraph: Rect,
  inset = 16,
): { first: { x: number; y: number }; wrapped?: { x: number; y: number } } {
  const line = height(link)
  const into = Math.min(inset, Math.floor(width(link) / 2))
  const first = { x: link.left + into, y: Math.round(link.top + line / 2) }
  const wraps =
    link.right >= paragraph.right - 1 && link.bottom + line <= paragraph.bottom + 1
  if (!wraps) return { first }
  return {
    first,
    wrapped: { x: paragraph.left + inset, y: Math.round(link.bottom + line / 2) },
  }
}

const contains = (rect: Rect, x: number, y: number) =>
  x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom

const within = (node: UiNode, ancestor: UiNode) => {
  for (let current: UiNode | undefined = node; current; current = current.parent)
    if (current === ancestor) return true
  return false
}

/**
 * Where a tap on `node` would land on it, or undefined when it cannot. UI
 * Automator keeps nodes that are scrolled out of view in the dump, with empty
 * or inverted bounds, so being in the tree is not being on screen. The visible
 * part must be big enough to aim at, and no clickable node drawn after it (an
 * overlay such as the composer or the "Latest" button) may cover the point.
 */
export function tapPoint(
  root: UiNode,
  node: UiNode,
  minPx = 24,
): { x: number; y: number } | undefined {
  const target = tapTarget(node)
  if (width(target.bounds) < minPx || height(target.bounds) < minPx) return undefined
  const point = center(target.bounds)
  const nodes = flatten(root)
  const covered = nodes
    .slice(nodes.indexOf(target) + 1)
    .some(
      (other) =>
        other.clickable &&
        !within(other, target) &&
        width(other.bounds) > 0 &&
        height(other.bounds) > 0 &&
        contains(other.bounds, point.x, point.y),
    )
  return covered ? undefined : point
}

/** The first node matching `match` that a tap can reach, with where to tap it. */
export function findTappable(
  root: UiNode,
  match: Match,
): { node: UiNode; point: { x: number; y: number } } | undefined {
  for (const node of findAll(root, match)) {
    const point = tapPoint(root, node)
    if (point) return { node, point }
  }
  return undefined
}

const isInteractive = (node: UiNode) =>
  node.clickable ||
  node.longClickable ||
  node.checkable ||
  /EditText$/.test(node.className)

/** The innermost node holding both `a` and `b`: for a card's title and text, the card. */
export function commonAncestor(a: UiNode, b: UiNode): UiNode | undefined {
  const above = new Set<UiNode>()
  for (let current: UiNode | undefined = a; current; current = current.parent)
    above.add(current)
  for (let current: UiNode | undefined = b; current; current = current.parent)
    if (above.has(current)) return current
  return undefined
}

/** Everything in `node` (itself included) that responds to a tap or takes text. */
export function interactiveWithin(node: UiNode): UiNode[] {
  return [node, ...flatten(node)].filter(isInteractive)
}

const boxInside = (inner: Rect, outer: Rect) =>
  inner.left >= outer.left &&
  inner.top >= outer.top &&
  inner.right <= outer.right &&
  inner.bottom <= outer.bottom

/**
 * A paragraph's text without one link in it: the link's label and the
 * " (host)" Cindl shows right after every link (Markdown.tsx, LinkSpan),
 * which is the link's, not a sentence around it.
 */
const withoutLink = (text: string, name: string) => {
  const at = text.indexOf(name)
  if (at < 0) return text
  return text.slice(0, at) + text.slice(at + name.length).replace(/^ \([^()]*\)/, '')
}

/**
 * A link inside a sentence, as WCAG 2.5.8's inline exception means it: React
 * Native gives a link span an accessibility node of its own, a child of its
 * paragraph's TextView, with no text of its own, its label part of the
 * paragraph's text, other words around it, and its box within the
 * paragraph's (CI run 41668168848: "the venue page" [854,784][1038,853] in
 * [42,784][1038,991]). A link that is all its paragraph says, and any other
 * link or button, is a target like the rest.
 */
const isInlineLink = (node: UiNode) => {
  const paragraph = node.parent
  const name = label(node)
  return (
    paragraph !== undefined &&
    paragraph.className === 'android.widget.TextView' &&
    node.text === '' &&
    name !== '' &&
    paragraph.text.includes(name) &&
    /[\p{L}\p{N}]/u.test(withoutLink(paragraph.text, name)) &&
    boxInside(node.bounds, paragraph.bounds)
  )
}

/**
 * A paragraph that reports itself clickable because of the inline links in
 * it (React Native renders them as spans of its TextView), exempt with them:
 * it holds at least one (`isInlineLink`). A clickable TextView with no inline
 * link in it is a target like the rest.
 */
const isInlineText = (node: UiNode) =>
  node.className === 'android.widget.TextView' &&
  node.desc === '' &&
  node.text !== '' &&
  node.children.some(isInlineLink)

function nearestScrollable(node: UiNode): UiNode | undefined {
  for (let current = node.parent; current; current = current.parent)
    if (current.scrollable) return current
  return undefined
}

/** True when the node touches its scroll container's edge, so its bounds may be clipped. */
function maybeClipped(node: UiNode): boolean {
  const container = nearestScrollable(node)
  if (!container) return false
  const { bounds: b } = node
  const { bounds: c } = container
  return b.top <= c.top || b.bottom >= c.bottom || b.left <= c.left || b.right >= c.right
}

export interface TargetIssue {
  label: string
  className: string
  widthDp: number
  heightDp: number
  bounds: Rect
}

export interface TargetAudit {
  checked: number
  skippedClipped: number
  exemptInline: number
  issues: TargetIssue[]
}

/**
 * Every interactive node of `pkg` the owner can reach (`reachable`) must be at
 * least `minDp` in both directions; inline text and inline links are exempt.
 */
export function auditTargets(
  root: UiNode,
  options: { pkg: string; density: number; minDp?: number },
): TargetAudit {
  const minDp = options.minDp ?? 48
  const scale = options.density / 160
  const audit: TargetAudit = {
    checked: 0,
    skippedClipped: 0,
    exemptInline: 0,
    issues: [],
  }
  for (const node of reachable(root)) {
    if (node.pkg !== options.pkg || !isInteractive(node)) continue
    if (width(node.bounds) <= 0 || height(node.bounds) <= 0) continue
    if (isInlineText(node) || isInlineLink(node)) {
      audit.exemptInline += 1
      continue
    }
    if (maybeClipped(node)) {
      audit.skippedClipped += 1
      continue
    }
    audit.checked += 1
    const widthDp = width(node.bounds) / scale
    const heightDp = height(node.bounds) / scale
    // Half a dp of slack for layout rounding to whole pixels.
    if (widthDp < minDp - 0.5 || heightDp < minDp - 0.5)
      audit.issues.push({
        label: label(node) || '(unlabelled)',
        className: node.className,
        widthDp: Math.round(widthDp * 10) / 10,
        heightDp: Math.round(heightDp * 10) / 10,
        bounds: node.bounds,
      })
  }
  return audit
}

/** A screen's audit as its step reports it. */
export function auditLine(screen: string, audit: TargetAudit): string {
  return (
    `${screen}: ${audit.checked} targets checked, ${audit.issues.length} under 48dp, ${audit.exemptInline} exempt as inline` +
    (audit.skippedClipped
      ? `, ${audit.skippedClipped} partly scrolled off (not measured)`
      : '') +
    (audit.checked === 0 ? ', nothing measured (fails the 48dp row)' : '')
  )
}

/**
 * The "Touch targets are at least 48dp" row: failed by any target under
 * 48dp, and by any screen where no target was measured (an audit that
 * measured nothing on a screen proves nothing about it), as by a run that
 * audited no screen.
 */
export function touchTargetsRow(
  audits: ReadonlyArray<{ screen: string } & TargetAudit>,
): {
  status: 'passed' | 'failed'
  detail: string[]
} {
  if (audits.length === 0) return { status: 'failed', detail: ['no screen was measured'] }
  const problems = [
    ...audits.flatMap((audit) =>
      audit.issues.map(
        (issue) =>
          `${audit.screen}: "${issue.label}" ${issue.widthDp}x${issue.heightDp}dp (${issue.className})`,
      ),
    ),
    ...audits
      .filter((audit) => audit.checked === 0)
      .map((audit) => `${audit.screen}: no target measured`),
  ]
  if (problems.length > 0) return { status: 'failed', detail: problems }
  const measured = audits.reduce((sum, audit) => sum + audit.checked, 0)
  return { status: 'passed', detail: [`${measured} targets on ${audits.length} screens`] }
}

/**
 * What the reset at each step's start does next: bring Cindl back when
 * another app is in front (the launcher after a step left the app), never
 * system back there; system back while Cindl is in front with a dialog, a
 * sheet or the keyboard's window up; else nothing (CI run 41696032323: back
 * on a bare Talk, on a keyboard flag left set, left the app at every step).
 */
export function resetMove(screen: {
  cindlInFront: boolean
  overlay: boolean
  keyboardUp: boolean
}): 'relaunch' | 'back' | 'done' {
  if (!screen.cindlInFront) return 'relaunch'
  return screen.overlay || screen.keyboardUp ? 'back' : 'done'
}

/**
 * The app whose window has focus, from `dumpsys window` (`mCurrentFocus`), or
 * undefined for a system window (status bar, notification shade, a system
 * dialog) or none.
 */
export function focusedPackage(dumpsys: string): string | undefined {
  return /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(dumpsys)?.[1]
}

/** The app of the focused activity, from `dumpsys window` (`mFocusedApp`), or undefined. */
export function focusedApp(dumpsys: string): string | undefined {
  return /mFocusedApp=[^\n]*?\bu\d+ ([\w.]+)\//.exec(dumpsys)?.[1]
}

/**
 * A screenshot can show nothing but this app: its own window has focus and it
 * is the focused app. Anything else is not captured, including an answer that
 * cannot be read. No focused window, or a system window in front (an
 * "Application Not Responding" dialog, the notification shade, whose titles
 * name no activity), can still leave the browser on screen as Cindl takes
 * over again, and the browser's address bar shows the sign-in's code and
 * state.
 */
export function onlyAppInFront(dumpsys: string, pkg: string): boolean {
  return focusedPackage(dumpsys) === pkg && focusedApp(dumpsys) === pkg
}

/** A UI dump of this app's window alone: it has nodes, and every one is the app's. */
export function onlyApp(root: UiNode, pkg: string): boolean {
  const nodes = flatten(root)
  return nodes.length > 0 && nodes.every((node) => node.pkg === pkg)
}

/** The focus lines of `dumpsys window` (mCurrentFocus, mFocusedApp), trimmed. */
const focusLines = (dumpsys: string) =>
  [...dumpsys.matchAll(/^\s*((?:mCurrentFocus|mFocusedApp)=.*?)\s*$/gm)]
    .map((line) => line[1])
    .join('\n')

/**
 * A screen capture is kept when only this app was in front just before it
 * (`onlyAppInFront`) and still is just after, with the same window and
 * activity in focus: the browser could have come to the front in between.
 */
export function keepCapture(before: string, after: string, pkg: string): boolean {
  return (
    onlyAppInFront(before, pkg) &&
    onlyAppInFront(after, pkg) &&
    focusLines(before) === focusLines(after)
  )
}

/**
 * The input_method dump says the keyboard is shown, for the report only: the
 * input method's own `mIsInputViewShown` stays true after it hides (AOSP's
 * InputMethodService updates it only while its window is visible), so no
 * decision is taken on it (CI run 41696032323).
 */
const saysShown = (inputMethodDump: string) =>
  /\bm?InputShown=true\b|\bisInputViewShown=true\b|\bmIsInputViewShown=true\b/.test(
    inputMethodDump,
  )

/** The display's size from `wm size` (an override wins), or undefined. */
export function parseDisplaySize(
  wmSize: string,
): { width: number; height: number } | undefined {
  const size =
    /Override size: (\d+)x(\d+)/.exec(wmSize) ?? /Physical size: (\d+)x(\d+)/.exec(wmSize)
  return size ? { width: Number(size[1]), height: Number(size[2]) } : undefined
}

/**
 * The input method's window in `dumpsys window windows` (which prints every
 * window in full, its visibility and insets too): from its `Window #n
 * Window{… InputMethod}:` line to the next window's. Undefined without one.
 */
export function imeWindow(windowsDump: string): string | undefined {
  const lines = windowsDump.split('\n')
  const start = lines.findIndex((line) =>
    /^\s*Window #\d+ Window\{\S+ \S+ InputMethod\}:/.test(line),
  )
  if (start < 0) return undefined
  const end = lines.findIndex(
    (line, index) => index > start && /^\s*Window #\d+ /.test(line),
  )
  return lines.slice(start, end < 0 ? undefined : end).join('\n')
}

/**
 * The least share of the display's height a keyboard on screen takes. A
 * phone's takes about 40% (LatinIME's would be about 1023 of that run's 2400
 * px); the 126 px navigation strip Android's keyboard shows without its keys
 * (5%) is no keyboard.
 */
export const MIN_KEYBOARD_SHARE = 0.15

export interface VisibleKeyboard {
  /**
   * Android shows the keyboard's window (visible, with a surface): system
   * back would close it. A hidden keyboard's window is gone, whatever flag
   * the input method still holds.
   */
  windowUp: boolean
  /**
   * On screen: its window visible and on screen, with a surface, its frame
   * inside the display's width, and the area from its top to its frame's
   * bottom inside the display and at least `MIN_KEYBOARD_SHARE` of its height.
   */
  visible: boolean
  /** Screen y of its top edge: the frame's top plus the smaller of the insets it gives. */
  top?: number
  /** Its height on screen, in pixels. */
  height?: number
  /** What was read, numbers and flags only (nothing typed or shown), for the report. */
  geometry: string
}

const insetTop = (block: string, name: string) => {
  const inset = new RegExp(`\\b${name}=\\[-?\\d+,(-?\\d+)\\]\\[-?\\d+,-?\\d+\\]`).exec(
    block,
  )
  return inset ? Number(inset[1]) : undefined
}

/**
 * Whether the on-screen keyboard is on screen, from its window's geometry
 * (`imeWindow`) and the display's size, not from flags: a keyboard Android
 * says is shown can be off the screen, empty, or gone (CI run 41681122382:
 * its top at the display's bottom edge, nothing on screen).
 */
export function visibleKeyboard(
  window: string | undefined,
  inputMethodDump: string,
  display: { width: number; height: number } | undefined,
): VisibleKeyboard {
  const said = `input_method ${saysShown(inputMethodDump) ? 'says shown' : 'does not say shown'}`
  const screen = display
    ? `display ${display.width}x${display.height}`
    : 'display size unknown'
  if (window === undefined)
    return {
      windowUp: false,
      visible: false,
      geometry: `no input method window; ${said}; ${screen}`,
    }
  const flag = (pattern: RegExp) => pattern.exec(window)?.[1]
  const view = flag(/\bmViewVisibility=(0x[0-9a-f]+)\b/)
  const surface = flag(/\bmHasSurface=(true|false)\b/)
  const isVisible = flag(/\bisVisible=(true|false)\b/)
  const onScreen = flag(/\bisOnScreen=(true|false)\b/)
  const frame = /\b(?:frame|mFrame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(window)
  const content = insetTop(window, 'mGivenContentInsets')
  const seen = insetTop(window, 'mGivenVisibleInsets')
  const [left, frameTop, right, bottom] = frame
    ? frame.slice(1, 5).map(Number)
    : [undefined, undefined, undefined, undefined]
  const insets = [content, seen].filter((value) => value !== undefined)
  const inset = insets.length > 0 ? Math.min(...insets) : 0
  const top = frameTop === undefined ? undefined : frameTop + inset
  const height =
    top === undefined || bottom === undefined || display === undefined
      ? undefined
      : Math.min(bottom, display.height) - top
  const geometry = [
    `window view ${view ?? 'unreported'}, surface ${surface ?? 'unreported'}, isVisible ${isVisible ?? 'unreported'}, isOnScreen ${onScreen ?? 'unreported'}`,
    frame ? `frame [${left},${frameTop}][${right},${bottom}]` : 'no frame',
    `content inset top ${content ?? 'unreported'}, visible inset top ${seen ?? 'unreported'}`,
    said,
    screen,
  ].join('; ')
  const windowUp = view === '0x0' && surface === 'true' && isVisible !== 'false'
  const visible =
    windowUp &&
    onScreen === 'true' &&
    display !== undefined &&
    top !== undefined &&
    height !== undefined &&
    left !== undefined &&
    right !== undefined &&
    left >= 0 &&
    right <= display.width &&
    right > left &&
    top >= 0 &&
    top < display.height &&
    height >= display.height * MIN_KEYBOARD_SHARE
  return visible
    ? { windowUp, visible, top, height, geometry }
    : { windowUp, visible, geometry }
}

/** Words that mean a screen asks to accept terms; the tests must stop there, never accept. */
export const TERMS_PROMPT =
  /terms of service|accept (?:&|and) continue|license agreement|i agree/i

/**
 * One pixel of `screencap` output without `-p`: a header of width, height and
 * format (and, on newer Android, a colour space), all little-endian 32-bit,
 * then RGBA rows. Undefined for another format or a point off the screen.
 */
export function rawPixel(
  capture: Uint8Array,
  x: number,
  y: number,
): [number, number, number] | undefined {
  if (capture.length < 12) return undefined
  const header = new DataView(capture.buffer, capture.byteOffset, 12)
  const width = header.getUint32(0, true)
  const height = header.getUint32(4, true)
  const format = header.getUint32(8, true)
  const offset = capture.length - width * height * 4
  if (format !== 1 || (offset !== 12 && offset !== 16)) return undefined
  if (x < 0 || y < 0 || x >= width || y >= height) return undefined
  const at = offset + (y * width + x) * 4
  return [capture[at] ?? 0, capture[at + 1] ?? 0, capture[at + 2] ?? 0]
}

/**
 * Where a point of the agent's screen is drawn on the device: the picture is
 * centred in its view with its aspect kept (modules/cindl-screen ScreenPixels.kt `fit`).
 */
/**
 * The live view's whole box is on screen. The view keeps the screen's aspect
 * ratio (ScreenView.tsx), so a box shorter than the picture at its width is
 * clipped: the tab bar cuts the view while it runs under it (CI run
 * 41668168848: [45,1754][1035,2124], 370 of its 619 px). A taller box is the
 * view letterboxing the picture, and is whole.
 */
export function wholeView(
  bounds: Rect,
  screen: { width: number; height: number },
  tolerance = 4,
): boolean {
  const pictureHeight = (width(bounds) * screen.height) / screen.width
  return width(bounds) > 0 && height(bounds) >= pictureHeight - tolerance
}

/**
 * Where a point of the agent's screen is on the device, in a whole live view
 * (the picture scaled to fit and centred). A clipped view is refused: its box
 * would scale the picture down and shift it, so a point would land elsewhere.
 */
export function screenToDevice(
  bounds: Rect,
  screen: { width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  if (!wholeView(bounds, screen))
    throw new Error(
      `The live view is clipped ([${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]); scroll it fully into view first`,
    )
  const viewWidth = bounds.right - bounds.left
  const viewHeight = bounds.bottom - bounds.top
  const scale = Math.min(viewWidth / screen.width, viewHeight / screen.height)
  const left = bounds.left + (viewWidth - screen.width * scale) / 2
  const top = bounds.top + (viewHeight - screen.height * scale) / 2
  return {
    x: Math.round(left + (point.x + 0.5) * scale),
    y: Math.round(top + (point.y + 0.5) * scale),
  }
}

/** True when two colours differ by at most `tolerance` in every channel. */
export const near = (
  colour: readonly number[] | undefined,
  expected: readonly number[],
  tolerance = 16,
) =>
  colour !== undefined &&
  expected.every((channel, i) => Math.abs((colour[i] ?? -999) - channel) <= tolerance)
