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

/**
 * Inline links inside a paragraph are exempt (as in WCAG 2.5.8): React Native
 * renders them as spans of one TextView, which then reports as clickable.
 */
const isInlineText = (node: UiNode) =>
  node.className === 'android.widget.TextView' && node.desc === '' && node.text !== ''

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

/** Every interactive node of `pkg` must be at least `minDp` in both directions. */
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
  for (const node of flatten(root)) {
    if (node.pkg !== options.pkg || !isInteractive(node)) continue
    if (width(node.bounds) <= 0 || height(node.bounds) <= 0) continue
    if (isInlineText(node)) {
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

export interface KeyboardState {
  shown: boolean
  /** Screen y of the keyboard's top edge, when the window dump reports it. */
  top?: number
}

/**
 * The app whose window has focus, from `dumpsys window` (`mCurrentFocus`), or
 * undefined for a system window (status bar, notification shade, a system
 * dialog) or none.
 */
export function focusedPackage(dumpsys: string): string | undefined {
  return /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(dumpsys)?.[1]
}

/**
 * Reads `dumpsys window InputMethod` (plus `dumpsys input_method` for the
 * shown flag). The visible keyboard starts at the window frame's top plus its
 * given content inset.
 */
export function parseKeyboard(
  windowDump: string,
  inputMethodDump: string,
): KeyboardState {
  // Older releases report the flag in input_method; newer ones may only show the window as visible.
  const shown =
    /\bm?InputShown=true\b|\bisInputViewShown=true\b|\bmIsInputViewShown=true\b/.test(
      inputMethodDump,
    ) ||
    (/\bmViewVisibility=0x0\b/.test(windowDump) &&
      /\bmHasSurface=true\b/.test(windowDump))
  const frame = /\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(
    windowDump,
  )
  if (!shown || !frame) return { shown }
  const inset = /mGivenContentInsets=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(
    windowDump,
  )
  return { shown, top: Number(frame[2]) + Number(inset?.[2] ?? 0) }
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
export function screenToDevice(
  bounds: Rect,
  screen: { width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number } {
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
