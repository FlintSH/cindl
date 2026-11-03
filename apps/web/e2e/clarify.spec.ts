import { expect, test } from './fixtures.ts'

const venueOther = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', {
    name: /Your own answer to: Both venues release their hold/,
  })

test('the question form never discards what the owner typed or picked', async ({
  page,
}) => {
  await page.goto('/#/talk')
  await venueOther(page).fill('Studio annex (fictional)')
  await expect(page.getByRole('radio', { name: 'Other' })).toBeChecked()
  await page.getByRole('radio', { name: 'Harbor Loft (fictional)' }).check()
  await expect(venueOther(page)).toHaveValue('Studio annex (fictional)')
  await page.getByRole('radio', { name: 'Other' }).check()
  await expect(venueOther(page)).toHaveValue('Studio annex (fictional)')

  await page.getByRole('checkbox', { name: 'Floor plan' }).check()
  const skip = page.getByRole('checkbox', { name: 'Skip this question' }).nth(1)
  await skip.check()
  await expect(page.getByRole('checkbox', { name: 'Floor plan' })).toBeDisabled()
  await skip.uncheck()
  await expect(page.getByRole('checkbox', { name: 'Floor plan' })).toBeChecked()

  // Leaving the conversation and coming back keeps the drafts.
  await page.goto('/#/work')
  await page.goto('/#/talk')
  await expect(venueOther(page).first()).toHaveValue('Studio annex (fictional)')
  await expect(page.getByRole('checkbox', { name: 'Floor plan' }).first()).toBeChecked()
})

// Outcome only (the demo's fixture rejects a second answer too); the card's
// lock is proved in decision-lock.spec.ts.
test('in the demo, two submits in the same task end in one answer', async ({ page }) => {
  await page.goto('/#/talk')
  await page.getByRole('radio', { name: 'Harbor Loft (fictional)' }).check()
  await page.getByRole('checkbox', { name: 'Floor plan' }).check()
  await page.getByRole('button', { name: 'Send answers' }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(
    page.getByRole('region', { name: /Question: Offsite venue and prep/ }),
  ).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
