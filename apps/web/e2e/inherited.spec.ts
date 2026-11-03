import { expect, test } from './fixtures.ts'

// Ids from the URL or Hermes may equal Object.prototype names; they must
// never blank the app or resolve to an inherited property.
for (const route of [
  '/#/talk/constructor',
  '/#/talk/__proto__',
  '/#/talk/toString',
  '/#/library/skills/constructor',
  '/#/library/skills/__proto__',
])
  test(`route ${route} renders the shell`, async ({ page }) => {
    await page.goto(route)
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible()
  })
