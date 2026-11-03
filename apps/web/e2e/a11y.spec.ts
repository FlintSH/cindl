import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures.ts'

// Automated checks catch a subset of accessibility problems; keyboard, focus,
// target-size and contrast specs cover more, and screen-reader passes remain manual.
const routes = [
  '/#/talk',
  '/#/work',
  '/#/library/skills',
  '/#/library/memory',
  '/#/agent/identity',
  '/#/agent/runtime',
  '/#/agent/connections',
]

for (const scheme of ['light', 'dark'] as const)
  for (const route of routes)
    test(`axe WCAG 2.2 AA: ${route} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.goto(route)
      await page.getByRole('main').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
        ),
      ).toEqual([])
    })
