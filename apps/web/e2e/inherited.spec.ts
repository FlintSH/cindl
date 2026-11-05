import { expect, test } from './fixtures.ts'

// Ids from the URL or Hermes may equal Object.prototype names; they must
// never blank the app or resolve to an inherited property.
// Valid but unknown ids say so; ids the router rejects (such as `__proto__`,
// which is not a valid id) fall back to the main conversation.
for (const [route, expected] of [
  ['/#/talk/constructor', 'This conversation is not available on this connection.'],
  ['/#/talk/toString', 'This conversation is not available on this connection.'],
  ['/#/talk/__proto__', /Today.*Switch conversation/],
  ['/#/library/skills/constructor', 'That skill is not installed.'],
  ['/#/library/skills/__proto__', 'That skill is not installed.'],
] as const)
  test(`route ${route} renders a real state instead of failing`, async ({ page }) => {
    await page.goto(route)
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Primary' }).first()).toBeVisible()
    // The shell staying up is not enough: the view itself must render, not the
    // error boundary.
    await expect(
      typeof expected === 'string'
        ? page.getByText(expected)
        : page.getByRole('button', { name: expected }),
    ).toBeVisible()
    await expect(page.getByText(/Something went wrong showing/)).toHaveCount(0)
  })
