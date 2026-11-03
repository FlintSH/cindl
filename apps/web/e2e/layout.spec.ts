import { expect, test } from './fixtures.ts'

// The app shell scrolls inside its regions; the document itself must never scroll.
const sizes = [
  { width: 1265, height: 795 },
  { width: 1440, height: 1000 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]
const routes = [
  '/#/talk',
  '/#/work',
  '/#/library/skills',
  '/#/agent/identity',
  '/#/agent/runtime',
]

for (const size of sizes)
  test(`the document does not scroll at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size)
    const overflowing: string[] = []
    for (const route of routes) {
      await page.goto(route)
      await page.getByRole('main').waitFor()
      await page.evaluate(() => document.fonts.ready)
      const { height, width } = await page.evaluate(() => ({
        height: document.scrollingElement!.scrollHeight - innerHeight,
        width: document.scrollingElement!.scrollWidth - innerWidth,
      }))
      if (height > 1 || width > 1)
        overflowing.push(`${route}: +${height}px tall, +${width}px wide`)
    }
    expect(overflowing).toEqual([])
  })
