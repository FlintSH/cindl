import { expect, test } from './fixtures.ts'

const distanceFromBottom = (page: import('@playwright/test').Page) =>
  page.locator('[role=log]').evaluate((log) => {
    const el = log.parentElement as HTMLElement
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })

test('reading earlier messages is not interrupted by new output', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/#/talk')
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(48)
  await page.locator('[role=log]').evaluate((log) => {
    ;(log.parentElement as HTMLElement).scrollTop = 0
  })
  const jump = page.getByRole('button', { name: 'Jump to latest messages' })
  await expect(jump).toBeVisible()

  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.fill('Anything else?')
  await box.press('Enter')
  await expect(page.getByText('nothing reached Hermes', { exact: false })).toBeAttached({
    timeout: 15_000,
  })
  const top = await page
    .locator('[role=log]')
    .evaluate((log) => (log.parentElement as HTMLElement).scrollTop)
  expect(top).toBeLessThan(5)

  await jump.click()
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(48)
  await expect(jump).toHaveCount(0)
})

test('stays pinned to the newest message while at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/#/talk')
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.fill('Pinned?')
  await box.press('Enter')
  await expect(page.getByText('nothing reached Hermes', { exact: false })).toBeVisible({
    timeout: 15_000,
  })
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(48)
})
