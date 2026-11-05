import { readJsonFile, writeFileAtomic } from './platform/files.ts'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/**
 * Wide enough that the page itself is at least 1280px (the conversation
 * panel's breakpoint) even where the width includes the window frame, as on
 * Windows; 1280 itself left about 1264px there, and the panel opened as a sheet.
 */
export const DEFAULT_SIZE = { width: 1360, height: 820 } as const
export const MIN_SIZE = { width: 400, height: 520 } as const
/** How much of the window's top edge must be on a screen to keep a saved position. */
const VISIBLE = { width: 120, height: 40 } as const

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < 100_000

export function parseWindowState(value: unknown): WindowState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (!isInt(v.width) || !isInt(v.height)) return undefined
  const state: WindowState = {
    width: v.width,
    height: v.height,
    maximized: v.maximized === true,
  }
  if (isInt(v.x) && isInt(v.y)) {
    state.x = v.x
    state.y = v.y
  }
  return state
}

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) >=
    VISIBLE.width &&
  Math.max(0, Math.min(a.y + VISIBLE.height, b.y + b.height) - Math.max(a.y, b.y)) >=
    VISIBLE.height

/**
 * Where to open the window: the saved size, clamped to the largest work
 * area, and the saved position only if its title bar is still on a screen
 * (monitors change between sessions). Otherwise Electron centres it.
 */
export function placeWindow(
  saved: WindowState | undefined,
  workAreas: Rect[],
): WindowState {
  const largest = workAreas.reduce<Rect | undefined>(
    (best, area) =>
      !best || area.width * area.height > best.width * best.height ? area : best,
    undefined,
  )
  const maxWidth = Math.max(MIN_SIZE.width, largest?.width ?? DEFAULT_SIZE.width)
  const maxHeight = Math.max(MIN_SIZE.height, largest?.height ?? DEFAULT_SIZE.height)
  const width = Math.min(
    Math.max(saved?.width ?? DEFAULT_SIZE.width, MIN_SIZE.width),
    maxWidth,
  )
  const height = Math.min(
    Math.max(saved?.height ?? DEFAULT_SIZE.height, MIN_SIZE.height),
    maxHeight,
  )
  const placed: WindowState = { width, height, maximized: saved?.maximized ?? false }
  if (saved?.x !== undefined && saved.y !== undefined) {
    const frame = { x: saved.x, y: saved.y, width, height }
    if (workAreas.some((area) => overlap(frame, area))) {
      placed.x = saved.x
      placed.y = saved.y
    }
  }
  return placed
}

export function createWindowStateStore(file: string) {
  return {
    async load(): Promise<WindowState | undefined> {
      try {
        return parseWindowState(await readJsonFile(file))
      } catch {
        return undefined
      }
    },
    save: (state: WindowState) => writeFileAtomic(file, `${JSON.stringify(state)}\n`),
  }
}
