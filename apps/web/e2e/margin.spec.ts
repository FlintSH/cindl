import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './fixtures.ts'

test('on a phone, Show closes the margin sheet and focuses the card', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/talk')
  await page.getByRole('button', { name: 'Show the working margin' }).click()
  const sheet = page.getByRole('dialog', { name: 'Working margin' })
  await expect(sheet).toBeVisible()
  await sheet
    .getByRole('button', { name: /Show approval: Run the inventory export script/ })
    .click()
  await expect(sheet).toBeHidden()
  await expect(
    page.getByRole('heading', {
      name: /Approval needed: Run the inventory export script/,
    }),
  ).toBeFocused()
})

test('on a wide screen, Show focuses the card without closing the margin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/talk')
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await margin
    .getByRole('button', { name: /Show question: Offsite venue and prep/ })
    .click()
  await expect(margin).toBeVisible()
  await expect(
    page.getByRole('heading', { name: /Question: Offsite venue and prep/ }),
  ).toBeFocused()
})

test('the margin switches tools only when asked, and keeps the conversation in view', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/talk')
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await expect(
    margin.getByRole('tab', { name: 'Waiting 2', selected: true }),
  ).toBeVisible()
  // The agent's screen beside the conversation: the synthetic picture is drawn.
  await margin.getByRole('tab', { name: 'Computer' }).click()
  const screen = margin.getByRole('img', { name: 'The agent’s screen, live.' })
  await expect(screen).toBeVisible()
  await expect
    .poll(() =>
      screen.evaluate((canvas: HTMLCanvasElement) => [
        ...canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data,
      ]),
    )
    .toEqual([31, 42, 48, 255])
  await expect(page.getByRole('textbox', { name: 'Message Hermes' })).toBeVisible()
  // Leaving the tool closes the view.
  await margin.getByRole('tab', { name: 'Waiting 2' }).click()
  await expect(
    margin.getByRole('img', { name: 'The agent’s screen, live.' }),
  ).toHaveCount(0)
  // Selecting a step opens Step.
  await page.getByRole('button', { name: /Checked the studio calendar/ }).click()
  await expect(margin.getByRole('tab', { name: 'Step', selected: true })).toBeVisible()
  await expect(margin.getByText('calendar.search')).toBeVisible()
})

test('on a tablet the margin is a sheet with the same tools; Escape returns focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 })
  await page.goto('/#/talk')
  const toggle = page.getByRole('button', { name: 'Show the working margin' })
  await toggle.click()
  const sheet = page.getByRole('dialog', { name: 'Working margin' })
  await expect(
    sheet.getByRole('tab', { name: 'Waiting 2', selected: true }),
  ).toBeVisible()
  await sheet.getByRole('tab', { name: 'Step' }).click()
  await expect(sheet.getByText(/Select a step in the conversation/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  await expect(toggle).toBeFocused()
})

for (const tool of ['Waiting 2', 'Step', 'Computer'])
  test(`axe WCAG 2.2 AA: the margin's ${tool.split(' ')[0]} tool`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/#/talk')
    const margin = page.getByRole('complementary', { name: 'Working margin' })
    await margin.getByRole('tab', { name: tool }).click()
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
