import { expect, test as base, type Page } from '@playwright/test'

/** Fails a test on any console error, page error or CSP violation. */
export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    const problems: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    })
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    await use(page)
    expect(problems, 'browser errors').toEqual([])
  },
})
export { expect }
