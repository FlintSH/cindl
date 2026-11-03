import { useCindlApi } from '@cindl/client-react'
import {
  isCindlError,
  type DisplayFrame,
  type DisplayInputEvent,
  type DisplayView,
} from '@cindl/contracts'
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Button } from '../ui/primitives.tsx'
import styles from '../views/views.module.css'

/** DOM `buttons` (1 left, 2 right, 4 middle) as RFB's mask (1 left, 2 middle, 4 right). */
export const rfbButtons = (dom: number) => (dom & 1) | ((dom & 4) >> 1) | ((dom & 2) << 1)
const WHEEL_UP = 8
const WHEEL_DOWN = 16
/** Input events per `display.input` call (the contract's limit). */
const MAX_BATCH = 64

const nextPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function')
      requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })

function paint(target: HTMLCanvasElement | null, frame: DisplayFrame) {
  if (!target) return
  if (target.width !== frame.width || target.height !== frame.height) {
    target.width = frame.width
    target.height = frame.height
  }
  const context = target.getContext('2d')
  if (!context) return
  for (const region of frame.regions) {
    const pixels = new Uint8ClampedArray(
      region.rgba.buffer,
      region.rgba.byteOffset,
      region.rgba.byteLength,
    )
    context.putImageData(
      new ImageData(pixels, region.width, region.height),
      region.x,
      region.y,
    )
  }
}

/**
 * The agent-owned screen, live (ADR 0012). The client implementation holds
 * the Hermes ticket and speaks RFB; this only paints the regions it returns
 * and, while this device holds control, forwards pointer and key input. Tab
 * is never forwarded, so keyboard focus can always leave the screen.
 */
export function ScreenView({ controlling }: { controlling: boolean }) {
  const api = useCindlApi()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<DisplayView>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const queue = useRef<DisplayInputEvent[]>([])
  const flushing = useRef(false)
  const viewIdRef = useRef<string>(undefined)

  useEffect(() => {
    let alive = true
    let viewId: string | undefined
    const current = viewIdRef
    const run = async () => {
      try {
        const opened = await api.call('display.watch', {})
        viewId = opened.viewId
        if (!alive) return
        current.current = opened.viewId
        setView(opened)
        while (alive) {
          const frame = await api.call('display.frame', { viewId: opened.viewId })
          if (!alive) return
          paint(canvas.current, frame)
          await nextPaint()
        }
      } catch (err) {
        if (alive)
          setError(isCindlError(err) ? err.message : 'Cindl could not show the screen.')
      }
    }
    void run()
    return () => {
      alive = false
      current.current = undefined
      if (viewId) void api.call('display.unwatch', { viewId }).catch(() => undefined)
    }
  }, [api, attempt])

  const flush = () => {
    flushing.current = false
    const target = viewIdRef.current
    const events = queue.current.splice(0, MAX_BATCH)
    if (!target || !events.length) return
    void api.call('display.input', { viewId: target, events }).catch((err: unknown) => {
      setError(
        isCindlError(err) ? err.message : 'Cindl could not send that to the screen.',
      )
    })
    if (queue.current.length) schedule()
  }
  const schedule = () => {
    if (flushing.current) return
    flushing.current = true
    void nextPaint().then(flush)
  }
  const send = (event: DisplayInputEvent) => {
    const last = queue.current.at(-1)
    // Only the newest position matters between paints, unless buttons changed.
    if (
      event.type === 'pointer' &&
      last?.type === 'pointer' &&
      last.buttons === event.buttons
    )
      queue.current[queue.current.length - 1] = event
    else queue.current.push(event)
    schedule()
  }
  const at = (clientX: number, clientY: number) => {
    const target = canvas.current
    if (!target || !view) return undefined
    const box = target.getBoundingClientRect()
    const scaleX = view.width / (box.width || view.width)
    const scaleY = view.height / (box.height || view.height)
    return {
      x: Math.min(Math.max(Math.round((clientX - box.left) * scaleX), 0), view.width - 1),
      y: Math.min(Math.max(Math.round((clientY - box.top) * scaleY), 0), view.height - 1),
    }
  }
  const pointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!controlling) return
    const point = at(event.clientX, event.clientY)
    if (point) send({ type: 'pointer', ...point, buttons: rfbButtons(event.buttons) })
  }

  // React's wheel listener is passive; the page must not scroll while the
  // wheel drives the screen.
  const wheel = useEffectEvent((event: WheelEvent) => {
    const point = at(event.clientX, event.clientY)
    if (!point || event.deltaY === 0) return
    event.preventDefault()
    const button = event.deltaY < 0 ? WHEEL_UP : WHEEL_DOWN
    send({ type: 'pointer', ...point, buttons: button })
    send({ type: 'pointer', ...point, buttons: 0 })
  })
  useEffect(() => {
    const target = canvas.current
    if (!controlling || !target) return
    const listener = (event: WheelEvent) => wheel(event)
    target.addEventListener('wheel', listener, { passive: false })
    return () => target.removeEventListener('wheel', listener)
  }, [controlling])

  const key = (event: ReactKeyboardEvent<HTMLCanvasElement>, down: boolean) => {
    if (!controlling || event.key === 'Tab' || event.nativeEvent.isComposing) return
    event.preventDefault()
    send({ type: 'key', key: event.key, down })
  }

  return (
    <div className={styles.screen}>
      <canvas
        ref={canvas}
        className={styles.screenCanvas}
        width={view?.width ?? 640}
        height={view?.height ?? 400}
        role={controlling ? 'application' : 'img'}
        aria-label={
          controlling
            ? 'The agent’s screen, live. You are in control: keys typed here go to it, and Tab leaves it.'
            : 'The agent’s screen, live.'
        }
        tabIndex={controlling ? 0 : -1}
        data-controlling={controlling}
        onPointerMove={pointer}
        onPointerDown={(event) => {
          if (!controlling) return
          // Map the press first; focusing must not scroll the page under it.
          pointer(event)
          event.currentTarget.focus({ preventScroll: true })
        }}
        onPointerUp={pointer}
        onContextMenu={(event) => {
          if (controlling) event.preventDefault()
        }}
        onKeyDown={(event) => key(event, true)}
        onKeyUp={(event) => key(event, false)}
      />
      <p className={styles.note}>
        {controlling
          ? 'You are in control. Click the screen to type into it; Tab moves focus away.'
          : 'Watching. Take control to use the pointer and keyboard.'}
      </p>
      {error ? (
        <div className={styles.actions}>
          <p className={styles.error} role="alert">
            {error}
          </p>
          <Button
            variant="quiet"
            onClick={() => {
              setError(undefined)
              setAttempt((value) => value + 1)
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  )
}
