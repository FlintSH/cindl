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
