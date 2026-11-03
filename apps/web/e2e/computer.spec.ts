import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

// The labelled demo serves a SYNTHETIC screen through Cindl's real RFB client
// (ADR 0012), so these flows exercise the decoder, painting and input path.

/** One canvas pixel, in screen coordinates. */
const pixel = (page: Page, x: number, y: number) =>
  page
    .getByRole('img', { name: /agent’s screen, live/ })
    .or(page.getByRole('application', { name: /agent’s screen, live/ }))
    .evaluate(
      (canvas: HTMLCanvasElement, [px, py]: number[]) => [
        ...canvas.getContext('2d')!.getImageData(px!, py!, 1, 1).data,
      ],
      [x, y],
    )

/** Clicks a point given in screen pixels (the canvas is scaled to fit). */
async function clickScreen(screen: Locator, x: number, y: number) {
  const box = (await screen.boundingBox())!
  await screen.click({
    position: { x: (x * box.width) / 640, y: (y * box.height) / 400 },
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/work')
  await expect(page.getByRole('note')).toContainText('Synthetic demo')
})

test('shows the agent’s screen live, labelled as synthetic', async ({ page }) => {
  const screen = page.getByRole('img', { name: 'The agent’s screen, live.' })
  await expect(screen).toBeVisible()
  // The synthetic top bar and desktop colours, once the first frame is painted.
  await expect.poll(() => pixel(page, 2, 2)).toEqual([31, 42, 48, 255])
  await expect.poll(() => pixel(page, 10, 300)).toEqual([47, 93, 98, 255])
  await expect(page.getByText('Watching. Take control to use the pointer')).toBeVisible()
  // Not focusable while watching: keyboard users never land in it by accident.
  await expect(screen).toHaveAttribute('tabindex', '-1')
})

test('sends pointer input only after taking control', async ({ page }) => {
  const watching = page.getByRole('img', { name: 'The agent’s screen, live.' })
  await expect.poll(() => pixel(page, 2, 2)).toEqual([31, 42, 48, 255])
  // Clicking while watching sends nothing: the spot keeps its colour.
  const spot = { x: 300, y: 200 }
  const before = await pixel(page, spot.x, spot.y)
  await clickScreen(watching, spot.x, spot.y)
  await page.waitForTimeout(600)
  expect(await pixel(page, spot.x, spot.y)).toEqual(before)

  await page.getByRole('button', { name: 'Take control…' }).click()
  await page.getByRole('button', { name: 'Take control now' }).click()
  const controlled = page.getByRole('application', { name: /You are in control/ })
  await expect(controlled).toHaveAttribute('tabindex', '0')
  await clickScreen(controlled, spot.x, spot.y)
  // The synthetic screen draws an orange marker where the pointer is.
  await expect.poll(() => pixel(page, spot.x, spot.y)).toEqual([230, 120, 40, 255])
  // Tab is never captured: focus can always leave the screen.
  await controlled.focus()
  await page.keyboard.press('Tab')
  await expect(controlled).not.toBeFocused()
})

// A press used to move focus to the screen, which scrolled a partly visible
// screen into view under the pointer, so the press landed lower than aimed.
test('maps a press on a partly visible screen to where it was aimed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('button', { name: 'Take control…' }).click()
  await page.getByRole('button', { name: 'Take control now' }).click()
  const controlled = page.getByRole('application', { name: /You are in control/ })
  await expect.poll(() => pixel(page, 2, 2)).toEqual([31, 42, 48, 255])
  // Put the screen's top edge near the bottom of the window.
  await controlled.evaluate((canvas) => {
    const top = canvas.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, top - window.innerHeight + 260)
  })
  const box = (await controlled.boundingBox())!
  expect(box.y + box.height).toBeGreaterThan(720)
  const spot = { x: 200, y: 60 }
  await page.mouse.click(
    box.x + (spot.x * box.width) / 640,
    box.y + (spot.y * box.height) / 400,
  )
  await expect.poll(() => pixel(page, spot.x, spot.y)).toEqual([230, 120, 40, 255])
})
