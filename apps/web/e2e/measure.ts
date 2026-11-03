import type { Page } from '@playwright/test'

export interface Target {
  label: string
  /** Visible (clipped) box, used for overlap checks. */
  x: number
  y: number
  visibleWidth: number
  visibleHeight: number
  /** Element's full box, used for size checks. */
  width: number
  height: number
  path: string
}

/**
 * Visible interactive elements and their real hit boxes. Inline links inside
 * prose are excluded (WCAG 2.5.8 inline exception); visually hidden helpers
 * and disabled-looking decorations are not interactive and are skipped.
 */
export function interactiveTargets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    const selector =
      'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=radio], [role=option], [role=tab]'
    const pathOf = (el: Element) => {
      const parts: string[] = []
      for (
        let node: Element | null = el;
        node && parts.length < 4;
        node = node.parentElement
      )
        parts.unshift(node.tagName.toLowerCase())
      return parts.join('>')
    }
    // A modal dialog makes everything outside it inert.
    const modal = document.querySelector('dialog:modal')
    const scope: ParentNode = modal ?? document
    // The part of an element the user can actually hit: clipped by every
    // scrolling or clipping ancestor and by the viewport.
    const visibleRect = (el: Element) => {
      const r = el.getBoundingClientRect()
      let left = r.left
      let top = r.top
      let right = r.right
      let bottom = r.bottom
      for (let node = el.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
          const c = node.getBoundingClientRect()
          left = Math.max(left, c.left)
          top = Math.max(top, c.top)
          right = Math.min(right, c.right)
          bottom = Math.min(bottom, c.bottom)
        }
      }
      left = Math.max(left, 0)
      top = Math.max(top, 0)
      right = Math.min(right, innerWidth)
      bottom = Math.min(bottom, innerHeight)
      return { x: left, y: top, width: right - left, height: bottom - top, full: r }
    }
    return [...scope.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => {
        if (el.closest('.visually-hidden, [aria-hidden="true"], [inert]')) return false
        if (el.tagName === 'A' && el.closest('p, [data-prose]')) return false
        const style = getComputedStyle(el)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        const visible = visibleRect(el)
        return visible.width > 1 && visible.height > 1
      })
      .map((el) => {
        const visible = visibleRect(el)
        const label = (
          el.getAttribute('aria-label') ??
          el.textContent ??
          el.getAttribute('placeholder') ??
          ''
        )
          .trim()
          .slice(0, 50)
        // Size is judged on the element's full box; overlap on what is visible.
        const fullyVisible =
          Math.abs(visible.width - visible.full.width) < 1 &&
          Math.abs(visible.height - visible.full.height) < 1
        return {
          label: label || el.getAttribute('placeholder') || el.tagName.toLowerCase(),
          x: visible.x,
          y: visible.y,
          width: fullyVisible ? visible.width : visible.full.width,
          height: fullyVisible ? visible.height : visible.full.height,
          visibleWidth: visible.width,
          visibleHeight: visible.height,
          path: pathOf(el),
        }
      })
  })
}

export function overlaps(targets: Target[]): string[] {
  const problems: string[] = []
  for (let i = 0; i < targets.length; i++)
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i] as Target
      const b = targets[j] as Target
      const w = Math.min(a.x + a.visibleWidth, b.x + b.visibleWidth) - Math.max(a.x, b.x)
      const h =
        Math.min(a.y + a.visibleHeight, b.y + b.visibleHeight) - Math.max(a.y, b.y)
      if (w <= 1 || h <= 1) continue
      const contains = (p: Target, q: Target) =>
        p.x <= q.x + 0.5 &&
        p.y <= q.y + 0.5 &&
        p.x + p.width >= q.x + q.width - 0.5 &&
        p.y + p.height >= q.y + q.height - 0.5
      if (contains(a, b) || contains(b, a)) continue
      problems.push(
        `"${a.label}" overlaps "${b.label}" by ${Math.round(w)}x${Math.round(h)}px`,
      )
    }
  return problems
}

/** WCAG contrast of the element's rendered text colour over its composited background. */
export function compositedContrast(
  page: Page,
  selector: string,
  pseudo?: '::placeholder',
) {
  return page
    .locator(selector)
    .first()
    .evaluate((el, pseudoElement) => {
      const parse = (value: string) => {
        const m = value.match(/rgba?\(([^)]+)\)/)
        if (!m) return [0, 0, 0, 0] as const
        const [r, g, b, a = '1'] = (m[1] as string).split(/[ ,/]+/).filter(Boolean)
        return [Number(r), Number(g), Number(b), Number(a)] as const
      }
      const over = (top: readonly number[], under: readonly number[]) => {
        const a = top[3] as number
        return [0, 1, 2]
          .map((i) => (top[i] as number) * a + (under[i] as number) * (1 - a))
          .concat(1)
      }
      const layers: Array<readonly number[]> = []
      for (let node: Element | null = el; node; node = node.parentElement)
        layers.push(parse(getComputedStyle(node).backgroundColor))
      let background: readonly number[] = [255, 255, 255, 1]
      for (const layer of layers.reverse()) background = over(layer, background)
      const style = getComputedStyle(el, pseudoElement ?? null)
      const text = over(parse(style.color), background)
      const lum = (c: readonly number[]) => {
        const f = (v: number) => {
          const s = v / 255
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return (
          0.2126 * f(c[0] as number) +
          0.7152 * f(c[1] as number) +
          0.0722 * f(c[2] as number)
        )
      }
      const [hi, lo] = [lum(text), lum(background)].sort((x, y) => y - x) as [
        number,
        number,
      ]
      const size = Number.parseFloat(style.fontSize)
      const bold = Number.parseInt(style.fontWeight, 10) >= 700
      return {
        ratio: (hi + 0.05) / (lo + 0.05),
        large: size >= 24 || (bold && size >= 18.66),
      }
    }, pseudo)
}
