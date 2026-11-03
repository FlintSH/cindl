import { expect, test } from './fixtures.ts'

test('status follows observed state: waiting, then working, then idle', async ({
  page,
}) => {
  await page.goto('/#/talk')
  const presence = page
    .getByRole('status')
    .filter({ hasText: /Waiting on you|Working|Idle/ })
  await expect(presence).toContainText('Waiting on you: 1 approval, 1 question')
  await expect(page.locator('#composer-hint')).toHaveText(/waiting for your answer/)

  // The open tool step is blocked on the owner: no spinner, explicit wording.
  const step = page.getByRole('button', {
    name: /Preparing to update the inventory export/,
  })
  await expect(step).toHaveAttribute('data-status', 'blocked')
  await expect(step).toContainText('Waiting for you')
  await expect(step.locator('svg.lucide-loader-circle')).toHaveCount(0)

  // The question set is answered in one submission; the approval still waits.
  const send = page.getByRole('button', { name: 'Send answers' })
  await expect(send).toBeDisabled()
  await page.getByRole('radio', { name: 'Harbor Loft (fictional)' }).check()
  await expect(send).toBeDisabled()
  await page.getByRole('checkbox', { name: 'Floor plan' }).check()
  await send.click()
  await expect(presence).toContainText('Waiting on you: 1 approval')

  await page.getByRole('button', { name: 'Allow once' }).click()
  await expect(presence).toContainText('Working')
  await expect(page.locator('#composer-hint')).toHaveText(/Hermes is working/)
  await expect(presence).toContainText('Idle', { timeout: 15_000 })
  await expect(page.locator('#composer-hint')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop the current turn' })).toHaveCount(0)
})
