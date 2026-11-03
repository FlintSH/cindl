import { expect, test } from './fixtures.ts'

test('reduced motion switches transitions off instead of animating every property', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/talk')
  await page.getByRole('main').waitFor()
  const result = await page.evaluate(() => {
    const html = document.documentElement
    html.style.fontSize = '200%'
    const fontSize = getComputedStyle(html).fontSize
    const transitions = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition).length
    html.style.fontSize = ''
    return { fontSize, transitions }
  })
  // Before the fix this started one transition per element and property, and
  // reads and screenshots saw the old size.
  expect(result).toEqual({ fontSize: '32px', transitions: 0 })
})
