import { expect, test } from './fixtures.ts'
import { compositedContrast } from './measure.ts'

const samples: Array<{
  name: string
  route: string
  selector: string
  pseudo?: '::placeholder'
}> = [
  { name: 'assistant text', route: '/#/talk', selector: '[data-prose] p' },
  { name: 'message time', route: '/#/talk', selector: 'article header time' },
  { name: 'presence', route: '/#/talk', selector: '[role=status] span:not([data-tone])' },
  { name: 'demo banner', route: '/#/talk', selector: '[role=note]' },
  {
    name: 'request label',
    route: '/#/talk',
    selector: 'section[data-kind=approval] header span',
  },
  {
    name: 'request scope',
    route: '/#/talk',
    selector: 'section[data-kind=approval] footer p, section[data-kind=approval] p',
  },
  {
    name: 'deny button',
    route: '/#/talk',
    selector: 'section[data-kind=approval] button:not([class*=primary])',
  },
  {
    name: 'allow button',
    route: '/#/talk',
    selector: 'section[data-kind=approval] button[class*=primary]',
  },
  {
    name: 'tool meta',
    route: '/#/talk',
    selector: 'button[data-status] span[aria-hidden=true]',
  },
  {
    name: 'composer placeholder',
    route: '/#/talk',
    selector: '#composer-input',
    pseudo: '::placeholder',
  },
  { name: 'composer hint', route: '/#/talk', selector: '#composer-hint' },
  { name: 'section label', route: '/#/work', selector: 'h2' },
  { name: 'row detail', route: '/#/work', selector: 'main li span:nth-child(2)' },
  { name: 'status badge', route: '/#/work', selector: 'li span[data-tone]' },
  { name: 'capability reason', route: '/#/agent/runtime', selector: 'td:nth-child(3)' },
]

for (const scheme of ['light', 'dark'] as const)
  for (const width of [1440, 390])
    test(`composited text contrast, ${scheme}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      const failures: string[] = []
      for (const sample of samples) {
        await page.goto(sample.route)
        await page.locator(sample.selector).first().waitFor()
        const { ratio, large } = await compositedContrast(
          page,
          sample.selector,
          sample.pseudo,
        )
        const minimum = large ? 3 : 4.5
        if (ratio < minimum)
          failures.push(`${sample.name}: ${ratio.toFixed(2)} < ${minimum}`)
      }
      expect(failures).toEqual([])
    })

for (const scheme of ['light', 'dark'] as const)
  test(`keyboard focus ring is visible and contrasting, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/#/talk')
    const checks: string[] = []
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const result = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || el === document.body) return null
        const style = getComputedStyle(el)
        const parse = (v: string) => (v.match(/\d+(\.\d+)?/g) ?? []).map(Number)
        let bg: number[] = [255, 255, 255]
        for (let node = el.parentElement; node; node = node.parentElement) {
          const c = parse(getComputedStyle(node).backgroundColor)
          if (c.length >= 3 && (c[3] ?? 1) > 0.99) {
            bg = c.slice(0, 3)
            break
          }
        }
        const lum = (c: number[]) =>
          c
            .map((v) => v / 255)
            .map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * ([0.2126, 0.7152, 0.0722][i] as number), 0)
        const ring = parse(style.outlineColor).slice(0, 3)
        const [hi, lo] = [lum(ring), lum(bg)].sort((a, b) => b - a) as [number, number]
        return {
          name:
            el.getAttribute('aria-label') ??
            el.textContent?.trim().slice(0, 30) ??
            el.tagName,
          width: Number.parseFloat(style.outlineWidth),
          style: style.outlineStyle,
          ratio: (hi + 0.05) / (lo + 0.05),
        }
      })
      if (!result) continue
      if (result.style === 'none' || result.width < 2 || result.ratio < 3)
        checks.push(
          `${result.name}: ${result.style} ${result.width}px ${result.ratio.toFixed(2)}:1`,
        )
    }
    expect(checks).toEqual([])
  })
