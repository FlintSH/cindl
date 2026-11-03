import { expect, test } from './fixtures.ts'

// The demo's fixture also rejects a second answer, so this checks the visible
// outcome only. decision-lock.spec.ts proves the card's own lock against a
// client that accepts every call.
test('in the demo, two clicks in the same task end in one decision', async ({ page }) => {
  await page.goto('/#/talk')
  const card = page.getByRole('region', {
    name: /Approval needed: Run the inventory export script/,
  })
  await expect(card).toBeVisible()
  await card.evaluate((section) => {
    const buttons = [...section.querySelectorAll('button')]
    const deny = buttons.find((b) => b.textContent?.trim() === 'Deny')
    const allow = buttons.find((b) => b.textContent?.trim() === 'Allow once')
    deny?.click()
    allow?.click()
  })
  await expect(page.getByText('Understood. I did not run the export.')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('Done. The inventory sheet is current')).toHaveCount(0)
})
