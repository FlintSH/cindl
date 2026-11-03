import { expect, test } from './fixtures.ts'
import { interactiveTargets, overlaps } from './measure.ts'

const phones = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
]
const screens: Array<{
  name: string
  route: string
  open?: 'history' | 'margin' | 'palette'
}> = [
  { name: 'talk', route: '/#/talk' },
  { name: 'talk with margin', route: '/#/talk', open: 'margin' },
  { name: 'history', route: '/#/talk', open: 'history' },
  { name: 'palette', route: '/#/talk', open: 'palette' },
  { name: 'work', route: '/#/work' },
  { name: 'skills', route: '/#/library/skills' },
  { name: 'skill', route: '/#/library/skills/calendar-triage' },
  { name: 'identity', route: '/#/agent/identity' },
  { name: 'runtime', route: '/#/agent/runtime' },
  { name: 'appearance', route: '/#/agent/appearance' },
]

for (const viewport of phones)
  for (const screen of screens)
    test(`${screen.name} at ${viewport.width}px: 44px targets, no overlaps, survives 200% text`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport)
      await page.goto(screen.route)
      await page.getByRole('main').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const marginClose = page.getByRole('button', { name: 'Close the working margin' })
      if (screen.open !== 'margin' && (await marginClose.count()))
        await marginClose.click()
      if (screen.open === 'margin' && !(await marginClose.count()))
        await page.getByRole('button', { name: 'Show the working margin' }).click()
      if (screen.open === 'history')
        await page.getByRole('button', { name: /Switch conversation/ }).click()
      if (screen.open === 'palette') await page.keyboard.press('Control+K')

      for (const scale of ['100%', '200%']) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size
        }, scale)
        const targets = await interactiveTargets(page)
        expect(targets.length, 'interactive targets found').toBeGreaterThan(2)
        const small = targets
          .filter((t) => t.height < 43.5 || t.width < 43.5)
          .map(
            (t) =>
              `${t.label} (${t.path}) ${Math.round(t.width)}x${Math.round(t.height)}`,
          )
        expect(small, `targets under 44px at ${scale} text`).toEqual([])
        expect(overlaps(targets), `overlapping hit areas at ${scale} text`).toEqual([])
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        )
        expect(overflow, `page scrolls sideways at ${scale} text`).toBeLessThanOrEqual(1)
      }
    })

test('targets grow with text size', async ({ page }) => {
  await page.setViewportSize(phones[1] as { width: number; height: number })
  await page.goto('/#/talk')
  const button = page.getByRole('button', { name: 'Allow once' })
  const before = (await button.boundingBox())?.height ?? 0
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const after = (await button.boundingBox())?.height ?? 0
  expect(after).toBeGreaterThan(before)
})

test('the viewport lets the on-screen keyboard resize content', async ({ page }) => {
  await page.goto('/#/talk')
  const content = await page.locator('meta[name=viewport]').getAttribute('content')
  expect(content).toContain('interactive-widget=resizes-content')
  expect(content).toContain('viewport-fit=cover')
})
