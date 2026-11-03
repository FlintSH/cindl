import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from '@playwright/test'
import { emit, openDesktopRenderer, tokenNotice } from './desktop-bridge.ts'

// Evidence capture, not assertions: run with CINDL_CAPTURE=1. Output defaults
// to the git-ignored .agent-artifacts directory; review every image for
// private data before publishing any of them.
const enabled = process.env.CINDL_CAPTURE === '1'
const dir = resolve(
  process.env.CINDL_CAPTURE_DIR ?? '../../.agent-artifacts/web-qa/capture',
)
const viewports: Array<{ name: string; width: number; height: number }> = [
  { name: 'desktop-1440x1000', width: 1440, height: 1000 },
  { name: 'laptop-1280x800', width: 1280, height: 800 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'phone-360x800', width: 360, height: 800 },
]
const themes = ['light', 'dark'] as const

test.describe('screenshot capture', () => {
  test.skip(!enabled, 'Set CINDL_CAPTURE=1 to capture evidence screenshots.')
  test.beforeAll(() => mkdirSync(dir, { recursive: true }))

  for (const theme of themes)
    for (const viewport of viewports)
      test(`talk ${viewport.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.goto('/#/talk')
        await page.getByRole('button', { name: /Today/ }).waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.screenshot({ path: `${dir}/talk-${viewport.name}-${theme}.png` })
      })

  const pages = [
    { route: '/#/work', name: 'work' },
    { route: '/#/library/skills/calendar-triage', name: 'library-skill' },
    { route: '/#/agent/identity', name: 'agent-identity' },
    { route: '/#/agent/runtime', name: 'agent-runtime' },
  ]
  for (const { route, name } of pages)
    for (const [viewport, theme] of [
      [viewports[0]!, 'light'],
      [viewports[3]!, 'dark'],
    ] as const)
      test(`${name} ${viewport.name} ${theme}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.goto(route)
        await page.getByRole('heading', { level: 1 }).waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(150)
        await page.screenshot({ path: `${dir}/${name}-${viewport.name}-${theme}.png` })
      })

  test('evidence margin laptop-1280x800 dark', async ({ page }) => {
    await page.setViewportSize(viewports[1]!)
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.goto('/#/talk')
    await page.getByRole('button', { name: /Checked the studio calendar/ }).click()
    await page.getByRole('tab', { name: 'Step', selected: true }).waitFor()
    await page.screenshot({ path: `${dir}/talk-evidence-laptop-1280x800-dark.png` })
  })

  test('margin computer desktop-1440x1000 light', async ({ page }) => {
    await page.setViewportSize(viewports[0]!)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/#/talk')
    await page.getByRole('tab', { name: 'Computer' }).click()
    await page.getByRole('img', { name: 'The agent’s screen, live.' }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    await page.screenshot({
      path: `${dir}/talk-margin-computer-desktop-1440x1000-light.png`,
    })
  })

  test('margin sheet tablet-768x1024 dark', async ({ page }) => {
    await page.setViewportSize(viewports[2]!)
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.goto('/#/talk')
    await page.getByRole('button', { name: 'Show the working margin' }).click()
    await page.getByRole('dialog', { name: 'Working margin' }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: `${dir}/talk-margin-sheet-tablet-768x1024-dark.png` })
  })

  test('palette and history phone-390x844 light', async ({ page }) => {
    await page.setViewportSize(viewports[3]!)
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await page.goto('/#/talk')
    await page.getByRole('button', { name: /Today/ }).click()
    await page.getByRole('dialog', { name: 'Conversations' }).waitFor()
    await page.screenshot({ path: `${dir}/history-phone-390x844-light.png` })
  })

  // The desktop renderer before sign-in, with a synthetic bridge (no Hermes).
  for (const [viewport, theme, scale] of [
    [viewports[0]!, 'light', '100%'],
    [viewports[1]!, 'dark', '100%'],
    [viewports[3]!, 'light', '100%'],
    [viewports[4]!, 'dark', '200%'],
  ] as const)
    test(`sign-in ${viewport.name} ${theme} ${scale}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await openDesktopRenderer(page)
      await emit(page, tokenNotice)
      await page.getByLabel('Hermes address').fill('http://hermes.example.test')
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.getByRole('alert').waitFor()
      await page.evaluate((size) => {
        document.documentElement.style.fontSize = size
      }, scale)
      await page.evaluate(() => document.fonts.ready)
      const suffix = scale === '100%' ? '' : '-text200'
      await page.screenshot({
        path: `${dir}/sign-in-${viewport.name}-${theme}${suffix}.png`,
      })
    })
})
