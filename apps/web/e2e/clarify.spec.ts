import { expect, test } from './fixtures.ts'

const venueOther = (page: import('@playwright/test').Page) =>
  page.getByRole('textbox', {
    name: /Your own answer to: Both venues release their hold/,
  })

test('the question form never discards what the owner typed or picked', async ({
  page,
}) => {
  await page.goto('/#/talk')
  // On Talk the set docks above the composer, one question at a time.
  const dock = page.getByRole('region', { name: /Question: Offsite venue and prep/ })
  await expect(dock).toContainText('1 of 2')
  await venueOther(page).fill('Studio annex (fictional)')
  await expect(page.getByRole('radio', { name: 'Other' })).toBeChecked()
  // A single-choice pick moves on to the next question after a moment.
  await page.getByRole('radio', { name: 'Harbor Loft (fictional)' }).check()
  await expect(dock).toContainText('2 of 2')
  await dock.getByRole('button', { name: 'Previous question' }).click()
  await expect(venueOther(page)).toHaveValue('Studio annex (fictional)')
  await expect(page.getByRole('radio', { name: 'Harbor Loft (fictional)' })).toBeChecked()
  await page.getByRole('radio', { name: 'Other' }).check()
  await expect(venueOther(page)).toHaveValue('Studio annex (fictional)')

  await dock.getByRole('button', { name: 'Next question' }).click()
  await page.getByRole('checkbox', { name: 'Floor plan' }).check()
  const skip = dock.getByRole('checkbox', { name: 'Skip this question' })
  await skip.check()
  await expect(page.getByRole('checkbox', { name: 'Floor plan' })).toBeDisabled()
  await skip.uncheck()
  await expect(page.getByRole('checkbox', { name: 'Floor plan' })).toBeChecked()

  // Leaving the conversation and coming back keeps the drafts.
  await page.goto('/#/work')
  await page.goto('/#/talk')
  await expect(venueOther(page).first()).toHaveValue('Studio annex (fictional)')
  await dock.getByRole('button', { name: 'Next question' }).click()
  await expect(page.getByRole('checkbox', { name: 'Floor plan' }).first()).toBeChecked()
})

test('docked, the number keys pick the shown question’s choices', async ({ page }) => {
  await page.goto('/#/talk')
  const dock = page.getByRole('region', { name: /Question: Offsite venue and prep/ })
  await dock.getByRole('radio', { name: 'Orchard Barn (fictional)' }).focus()
  await page.keyboard.press('1')
  // The pick moves on to the next question; going back shows it was made.
  await expect(dock).toContainText('2 of 2')
  await dock.getByRole('button', { name: 'Previous question' }).click()
  await expect(page.getByRole('radio', { name: 'Harbor Loft (fictional)' })).toBeChecked()
  await dock.getByRole('button', { name: 'Next question' }).click()
  await dock.getByRole('checkbox', { name: 'Floor plan' }).focus()
  await page.keyboard.press('3')
  await expect(page.getByRole('checkbox', { name: 'Travel times' })).toBeChecked()
  // Typing in its own answer types digits instead.
  await page
    .getByRole('textbox', { name: /Your own answer to: What should I prepare/ })
    .fill('')
  await page
    .getByRole('textbox', { name: /Your own answer to: What should I prepare/ })
    .press('2')
  await expect(page.getByRole('checkbox', { name: 'Catering quotes' })).not.toBeChecked()
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
