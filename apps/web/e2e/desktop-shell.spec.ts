import AxeBuilder from '@axe-core/playwright'
import {
  bridgeCalls as calls,
  emit,
  openDesktopRenderer,
  tokenNotice as notice,
} from './desktop-bridge.ts'
import { expect, test } from './fixtures.ts'
import { compositedContrast, interactiveTargets, overlaps } from './measure.ts'

test('desktop sign-in asks only for the address and shows bridge errors by their message', async ({
  page,
}) => {
  await openDesktopRenderer(page)
  await expect(page.getByRole('heading', { name: 'Connect to Hermes' })).toBeVisible()
  // Not a demo: no banner, and nothing that could collect a password or code.
  await expect(page.getByRole('note')).toHaveCount(0)
  await expect(page.locator('input[type=password]')).toHaveCount(0)

  const address = page.getByLabel('Hermes address')
  const signIn = page.getByRole('button', { name: 'Sign in' })
  await expect(signIn).toBeDisabled()

  for (const [value, message] of [
    [
      'http://hermes.example.test',
      'Use https:// (plain http is allowed only for 127.0.0.1 or [::1]).',
    ],
    ['https://hermes.example.test/api', 'Use only the scheme, host and port.'],
    ['https://owner@hermes.example.test', 'Remove credentials from the address.'],
  ] as const) {
    await address.fill(value)
    await signIn.click()
    await expect(page.getByRole('alert')).toHaveText(message)
    await expect(address).toHaveAttribute('aria-invalid', 'true')
  }
  expect(await calls(page), 'nothing invalid reaches the bridge').toEqual([])

  await address.fill('  https://Hermes.Example.test  ')
  await signIn.click()
  // The plain rejection object was revived into a CindlError, so its own message shows.
  await expect(page.getByRole('alert')).toHaveText(
    'The system browser could not be opened.',
  )
  await expect(signIn).toBeEnabled()
  expect(await calls(page)).toEqual([
    { name: 'auth.signIn', args: { origin: 'https://hermes.example.test' } },
  ])
})

test('a signed-out desktop keeps the known address', async ({ page }) => {
  await openDesktopRenderer(page, {
    phase: 'signed-out',
    origin: 'https://hermes.example.test',
  })
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  await expect(page.getByLabel('Hermes address')).toHaveValue(
    'https://hermes.example.test',
  )
})

test('client notices stay until dismissed', async ({ page }) => {
  await openDesktopRenderer(page)
  await emit(page, notice)
  const shown = page.getByRole('status').filter({ hasText: notice.message })
  await expect(shown).toBeVisible()
  await shown.getByRole('button', { name: 'Dismiss notice' }).click()
  await expect(page.getByText(notice.message)).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const)
  test(`sign-in with an error and a notice passes axe WCAG 2.2 AA and text contrast (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openDesktopRenderer(page)
    await emit(page, notice)
    await page.getByLabel('Hermes address').fill('http://hermes.example.test')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('alert').waitFor()
    await page.evaluate(() => document.fonts.ready)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
    ).toEqual([])

    // axe does not measure placeholders or composited backgrounds.
    await page.getByLabel('Hermes address').fill('')
    const failures: string[] = []
    for (const [name, selector, pseudo] of [
      ['address placeholder', 'main form input', '::placeholder'],
      ['small print', 'main form p:last-child', undefined],
      ['notice', '[aria-live=polite] > div > p', undefined],
    ] as const) {
      const { ratio, large } = await compositedContrast(page, selector, pseudo)
      const minimum = large ? 3 : 4.5
      if (ratio < minimum) failures.push(`${name}: ${ratio.toFixed(2)} < ${minimum}`)
    }
    expect(failures).toEqual([])
  })

for (const width of [360, 390])
  test(`sign-in at ${width}px: 44px targets, no overlaps, reachable at 200% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await openDesktopRenderer(page)
    await emit(page, notice)
    await page.getByLabel('Hermes address').fill('https://hermes.example.test')
    await page.evaluate(() => document.fonts.ready)
    for (const scale of ['100%', '200%']) {
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size
      }, scale)
      const targets = await interactiveTargets(page)
      expect(targets.length, 'interactive targets found').toBeGreaterThan(2)
      const small = targets
        .filter((t) => t.height < 43.5 || t.width < 43.5)
        .map(
          (t) => `${t.label} (${t.path}) ${Math.round(t.width)}x${Math.round(t.height)}`,
        )
      expect(small, `targets under 44px at ${scale} text`).toEqual([])
      expect(overlaps(targets), `overlapping hit areas at ${scale} text`).toEqual([])
      const overflow = await page.evaluate(() => ({
        x: document.scrollingElement!.scrollWidth - innerWidth,
        y: document.scrollingElement!.scrollHeight - innerHeight,
      }))
      expect(overflow.x, `page scrolls sideways at ${scale} text`).toBeLessThanOrEqual(1)
      expect(overflow.y, `the document scrolls at ${scale} text`).toBeLessThanOrEqual(1)
      // A region that clips can still hide content sideways inside itself.
      // (Text fields scroll their own value; that is expected.)
      const sideways = await page.evaluate(() =>
        [...document.querySelectorAll('body *:not(input, textarea, select)')]
          .filter((el) => {
            const style = getComputedStyle(el)
            return (
              style.overflowX !== 'visible' &&
              style.display !== 'none' &&
              el.scrollWidth - el.clientWidth > 1
            )
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
      )
      expect(sideways, `regions scrolling sideways at ${scale} text`).toEqual([])
    }
    // The form scrolls inside the main region: each control can be focused
    // without the nav or a notice covering it (WCAG 2.4.11).
    for (const control of [
      page.getByLabel('Hermes address'),
      page.getByRole('button', { name: 'Sign in' }),
    ]) {
      // A real focus change (fill() already focused the field before the reflow).
      await control.blur()
      await control.focus()
      const covered = await control.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !(hit === el || el.contains(hit))
      })
      expect(
        covered,
        `${await control.evaluate((el) => el.outerHTML.slice(0, 60))} is covered`,
      ).toBe(false)
    }
  })
