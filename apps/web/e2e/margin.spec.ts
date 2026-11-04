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
  // Leaving the tool closes the view: gone from the page, not merely hidden.
  await margin.getByRole('tab', { name: 'Waiting 2' }).click()
  await expect(
    margin.getByRole('img', { name: 'The agent’s screen, live.' }),
  ).toHaveCount(0)
  await expect(margin.locator('canvas')).toHaveCount(0)
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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
  { width: 320, height: 640 },
])
  test(`at 200% text on a ${viewport.width}px phone, the sheet's tabs stay inside it and clear of the tool`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/#/talk')
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    await page.getByRole('button', { name: 'Show the working margin' }).click()
    const sheet = page.getByRole('dialog', { name: 'Working margin' })
    // Computer is the tallest tool; it pressed the header shut (review 284760f9 B1).
    await sheet.getByRole('tab', { name: 'Computer' }).click()
    await expect(sheet.getByText('Running')).toBeVisible()
    const box = (await sheet.boundingBox())!
    const panel = (await sheet.getByRole('tabpanel').boundingBox())!
    for (const tab of await sheet.getByRole('tab').all()) {
      const t = (await tab.boundingBox())!
      const name = await tab.textContent()
      expect(t.y, `${name} starts inside the sheet`).toBeGreaterThanOrEqual(box.y - 0.5)
      expect(t.y + t.height, `${name} ends inside the sheet`).toBeLessThanOrEqual(
        box.y + box.height + 0.5,
      )
      expect(t.y + t.height, `${name} ends above the tool`).toBeLessThanOrEqual(
        panel.y + 0.5,
      )
    }
  })

test('on a tablet, a step opens the sheet on Step with focus on that tab, and arrows move from there', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto('/#/talk')
  await page.getByRole('button', { name: /Checked the studio calendar/ }).focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Working margin' })
  const step = sheet.getByRole('tab', { name: 'Step', selected: true })
  await expect(step).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(sheet.getByRole('tab', { name: 'Computer', selected: true })).toBeFocused()
})

test('leaving the Computer tool gives control back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/talk')
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await margin.getByRole('tab', { name: 'Computer' }).click()
  await margin.getByRole('button', { name: 'Take control…' }).click()
  await expect(margin.getByText(/Leaving this view gives control back/)).toBeVisible()
  await margin.getByRole('button', { name: 'Take control now' }).click()
  await expect(margin.getByText('You are in control on this device')).toBeVisible()
  await margin.getByRole('tab', { name: /^Waiting/ }).click()
  await margin.getByRole('tab', { name: 'Computer' }).click()
  await expect(margin.getByText('Hermes is in control')).toBeVisible()
  await expect(margin.getByRole('button', { name: 'Take control…' })).toBeVisible()
})

test('focus survives the margin closing and a switch of conversation; the reading place comes back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/talk')
  // Closing the margin puts focus on what reopens it.
  await page.getByRole('button', { name: 'Close the working margin' }).click()
  await expect(
    page.getByRole('button', { name: 'Show the working margin' }),
  ).toBeFocused()
  // Read further back in Main, then switch away and back from the switcher.
  const timeline = page.getByRole('log', { name: 'Messages' }).locator('xpath=..')
  await timeline.evaluate((el) => {
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 200)
    el.dispatchEvent(new Event('scroll'))
  })
  const read = await timeline.evaluate((el) => el.scrollTop)
  expect(read).toBeGreaterThan(0)
  const switcher = page.getByRole('button', { name: /Switch conversation/ })
  await switcher.click()
  const list = page.getByRole('dialog', { name: 'Conversations' })
  await list.getByRole('button', { name: /Kiln inventory sheet/ }).click()
  await expect(
    page.getByRole('region', { name: 'Conversation: Kiln inventory sheet' }),
  ).toBeVisible()
  await expect(switcher).toBeFocused()
  await switcher.click()
  await list.getByRole('button', { name: /Today/ }).click()
  await expect(switcher).toBeFocused()
  await expect
    .poll(() =>
      page
        .getByRole('log', { name: 'Messages' })
        .locator('xpath=..')
        .evaluate((el) => el.scrollTop),
    )
    .toBe(read)
})
