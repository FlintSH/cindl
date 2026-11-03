import { expect, test } from './fixtures.ts'

// Note 4 of the first review: two clicks in the same task (before React
// re-renders) must not send two answers. Hermes keeps the first reply, so a
// second send would at best be ignored and at worst look like a reversal.
test('a decision card sends one answer even for clicks in the same task', async ({
  page,
}) => {
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
