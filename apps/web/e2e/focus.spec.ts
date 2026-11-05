import type { CindlEvent } from '@cindl/contracts'
import { scenarioData } from '@cindl/fixtures/scenario'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

/**
 * Where focus lands in the document editors (memory entries and SOUL) in a
 * real browser. jsdom cannot show the case that matters most: a browser keeps
 * focus on a control that just became disabled until its next frame, then
 * drops it to the page without a render. Runs on the test-only harness
 * (e2e/harness/focus.html): the real views on a synthetic client that holds,
 * refuses and changes Hermes's answers. Synthetic data only.
 */
const harnessUrl = process.env.CINDL_E2E_HARNESS
if (!harnessUrl) throw new Error('playwright.config.ts sets CINDL_E2E_HARNESS')

const D_K = 'Kiln draft: the firing log moved to the studio binder (fictional).'
const HARBOR_MON = 'Harbor Loft (fictional) holds the offsite date until Monday.'
const NOTICE = /^DIV:The entry this editor showed was changed/

async function harness(page: Page, view: 'memory' | 'soul' = 'memory') {
  await page.goto(`${harnessUrl}#${view}`)
  if (view === 'soul') await button(page, 'Edit').waitFor()
  else await button(page, /Open memory entry: The kiln/).waitFor()
  return {
    hold: (name: string, mode: 'request' | 'answer') =>
      page.evaluate(([n, m]) => window.harness.hold(n, m), [name, mode] as const),
    release: async (name: string) => {
      await expect
        .poll(() => page.evaluate((n) => window.harness.held(n), name))
        .toBe(true)
      await page.evaluate((n) => window.harness.release(n), name)
    },
    fail: (name: string, code: 'unavailable' | 'conflict', message: string, times = 1) =>
      page.evaluate(([n, c, m, t]) => window.harness.fail(n, c, m, t), [
        name,
        code,
        message,
        times,
      ] as const),
    remove: (text: string) => page.evaluate((t) => window.harness.remove(t), text),
    replace: (text: string, content: string) =>
      page.evaluate(([t, c]) => window.harness.replace(t, c), [text, content] as const),
  }
}
type Harness = Awaited<ReturnType<typeof harness>>

declare global {
  interface Window {
    harness: {
      emit: (event: CindlEvent) => void
      hold: (name: string, mode: 'request' | 'answer') => void
      held: (name: string) => boolean
      release: (name: string) => void
      fail: (
        name: string,
        code: 'unavailable' | 'conflict',
        message: string,
        times?: number,
      ) => void
      remove: (text: string) => void
      replace: (text: string, content: string) => void
    }
  }
}

test('focus follows a conversation row across shelves, but never follows after the owner leaves it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${harnessUrl}#/talk/demo-main`)
  const list = page.getByRole('navigation', { name: 'Conversations' })
  const row = list.getByRole('button', { name: /^Studio offsite planning/ })
  await row.focus()
  const offsite = scenarioData.conversations.find((c) => c.id === 'demo-offsite')!
  await page.evaluate(
    (conversation) =>
      window.harness.emit({
        type: 'conversation.upserted',
        conversation,
      }),
    { ...offsite, status: 'waiting-on-you' as const },
  )
  await expect(row).toContainText('Needs you')
  await expect(row).toBeFocused()
  await page.getByRole('heading', { name: 'Needs you', exact: false }).click()
  await page.evaluate(
    (conversation) =>
      window.harness.emit({
        type: 'conversation.upserted',
        conversation,
      }),
    { ...offsite, status: 'idle' as const },
  )
  await expect(row).not.toBeFocused()
})

test('a rename draft survives its conversation moving to another shelf', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${harnessUrl}#/talk/demo-main`)
  const list = page.getByRole('navigation', { name: 'Conversations' })
  const row = list.getByRole('button', { name: /^Studio offsite planning/ })
  await row.focus()
  await page.keyboard.press('F2')
  const field = list.getByRole('textbox', { name: 'Rename Studio offsite planning' })
  await field.fill('Offsite draft (synthetic)')
  const offsite = scenarioData.conversations.find((c) => c.id === 'demo-offsite')!
  await page.evaluate(
    (conversation) =>
      window.harness.emit({ type: 'conversation.upserted', conversation }),
    { ...offsite, status: 'waiting-on-you' as const },
  )
  await expect(field).toHaveValue('Offsite draft (synthetic)')
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(row).toBeFocused()
})

test('focus follows a step joining a work log and keeps its finished group open until focus leaves', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${harnessUrl}#/talk/demo-offsite`)
  await page.getByRole('textbox', { name: 'Message Hermes' }).waitFor()
  await page.evaluate(() =>
    window.harness.emit({
      type: 'message.started',
      conversationId: 'demo-offsite',
      messageId: 'focus-reply',
      role: 'assistant',
    }),
  )
  const step = (id: string, title: string, status: 'running' | 'complete') =>
    page.evaluate((activity) => window.harness.emit({ type: 'tool.updated', activity }), {
      id,
      title,
      status,
      name: 'notes.search',
      conversationId: 'demo-offsite',
    })
  await step('focus-a', 'Searched synthetic notes', 'running')
  const first = page.getByRole('button', { name: /^Searched synthetic notes/ })
  await first.focus()
  await step('focus-b', 'Read synthetic floor plan', 'running')
  await expect(first).toBeFocused()
  await step('focus-a', 'Searched synthetic notes', 'complete')
  await step('focus-b', 'Read synthetic floor plan', 'complete')
  const group = page.getByRole('button', { name: /^2 steps/ })
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect(first).toBeFocused()
  await group.focus()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(group).toBeFocused()
})

const button = (page: Page, name: string | RegExp) =>
  page.getByRole('button', { name, exact: typeof name === 'string' })
/** What has focus, after the browser's next frames (where it drops focus from a disabled control). */
async function focused(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0
        const next = () =>
          ++frames >= 3 ? setTimeout(resolve, 20) : requestAnimationFrame(next)
        requestAnimationFrame(next)
      }),
  )
  return page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'BODY'
    return `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? ''}`
  })
}

async function openKiln(page: Page) {
  await button(page, /Open memory entry: The kiln/).click()
  await button(page, 'Edit').waitFor()
}
async function toReview(page: Page) {
  await openKiln(page)
  await button(page, 'Edit').click()
  await page.getByLabel('Edit agent note 2').fill(D_K)
  await button(page, 'Review changes').click()
  await page.getByLabel('Changes').waitFor()
}
/** The kiln note is removed and Harbor rewritten while a list reload is held: the editor locks. */
async function lockedByMerge(page: Page, h: Harness) {
  await openKiln(page)
  await h.hold('memory.entries', 'request')
  await button(page, 'Reload').click()
  await button(page, 'Edit').click()
  await page.getByLabel('Edit agent note 2').fill(D_K)
  await h.remove('The kiln firing log')
  await h.replace('Harbor Loft', HARBOR_MON)
  await h.release('memory.entries')
  await page.getByText(/cannot tell which/).waitFor()
}

test('each step lands focus on what replaced the control: the draft, the changes, the draft, Edit', async ({
  page,
}) => {
  await harness(page)
  await openKiln(page)
  await button(page, 'Edit').click()
  expect(await focused(page)).toMatch(/^TEXTAREA:/)
  await page.getByLabel('Edit agent note 2').fill(D_K)
  await button(page, 'Review changes').click()
  expect(await focused(page)).toBe('PRE:Changes')
  await button(page, 'Back to editing').click()
  expect(await focused(page)).toMatch(/^TEXTAREA:/)
  await button(page, 'Discard changes').click()
  expect(await focused(page)).toBe('BUTTON:Edit')
})

test('a save that Hermes refuses keeps focus on the changes, while it is out and after', async ({
  page,
}) => {
  const h = await harness(page)
  await toReview(page)
  await h.hold('memory.write', 'answer')
  await h.fail('memory.write', 'unavailable', 'Hermes is not answering.')
  await button(page, 'Confirm and save').click()
  expect(await focused(page)).toBe('PRE:Changes')
  await h.release('memory.write')
  await page.getByText(/Nothing was saved/).waitFor()
  expect(await focused(page)).toBe('PRE:Changes')
})

test('a save refused as stale keeps focus on the changes, answered at once or later', async ({
  page,
}) => {
  const h = await harness(page)
  await toReview(page)
  await h.fail('memory.write', 'conflict', 'Probe conflict.')
  await button(page, 'Confirm and save').click()
  await button(page, 'Reload and keep my draft').waitFor()
  expect(await focused(page)).toBe('PRE:Changes')
  await button(page, 'Back to editing').click()
  await button(page, 'Discard changes').click()
  await button(page, 'Edit').click()
  await page.getByLabel('Edit agent note 2').fill(`${D_K} Again.`)
  await button(page, 'Review changes').click()
  await h.hold('memory.write', 'answer')
  await h.fail('memory.write', 'conflict', 'Probe conflict.')
  await button(page, 'Confirm and save').click()
  await h.release('memory.write')
  await button(page, 'Reload and keep my draft').waitFor()
  expect(await focused(page)).toBe('PRE:Changes')
})

test('a save that succeeds lands focus on Edit', async ({ page }) => {
  const h = await harness(page)
  await toReview(page)
  await h.hold('memory.write', 'answer')
  await button(page, 'Confirm and save').click()
  await h.release('memory.write')
  await button(page, 'Restore previous version').waitFor()
  expect(await focused(page)).toBe('BUTTON:Edit')
})

test('an adoption read that Hermes refuses keeps focus on the lock notice', async ({
  page,
}) => {
  const h = await harness(page)
  await lockedByMerge(page, h)
  await h.hold('memory.read', 'answer')
  await h.fail('memory.read', 'unavailable', 'Hermes is not answering.')
  await button(page, 'Use this draft for the entry now here').click()
  expect(await focused(page)).toMatch(NOTICE)
  await h.release('memory.read')
  await page.getByText('Your draft was not used, and it is still kept.').waitFor()
  expect(await focused(page)).toMatch(NOTICE)
})

test('a refusal that empties the place removes the adopt button; focus stays on the lock notice', async ({
  page,
}) => {
  const h = await harness(page)
  await lockedByMerge(page, h)
  await h.remove('Harbor Loft')
  await h.hold('memory.read', 'answer')
  await button(page, 'Use this draft for the entry now here').click()
  await h.release('memory.read')
  await button(page, 'Use this draft for the entry now here').waitFor({
    state: 'detached',
  })
  expect(await focused(page)).toMatch(NOTICE)
})

test('a completed adoption puts focus in the draft', async ({ page }) => {
  const h = await harness(page)
  await lockedByMerge(page, h)
  await h.hold('memory.read', 'answer')
  await button(page, 'Use this draft for the entry now here').click()
  await h.release('memory.read')
  await page
    .getByText(/This draft was written for the entry that was here before/)
    .waitFor()
  expect(await focused(page)).toMatch(/^TEXTAREA:Kiln draft/)
})

test('a lock that disables the focused control puts focus on the lock notice, also for an adopted draft', async ({
  page,
}) => {
  const h = await harness(page)
  await openKiln(page)
  await h.hold('memory.entries', 'request')
  await button(page, 'Reload').click()
  await button(page, 'Edit').click()
  await page.getByLabel('Edit agent note 2').fill(D_K)
  await button(page, 'Review changes').focus()
  await h.remove('The kiln firing log')
  await h.replace('Harbor Loft', HARBOR_MON)
  await h.release('memory.entries')
  await page.getByText(/cannot tell which/).waitFor()
  expect(await focused(page)).toMatch(NOTICE)
  // The draft is used for Harbor, which is then rewritten again while Review changes has focus.
  await h.hold('memory.entries', 'request')
  await button(page, 'Reload').click()
  await button(page, 'Use this draft for the entry now here').click()
  await page
    .getByText(/This draft was written for the entry that was here before/)
    .waitFor()
  await button(page, 'Review changes').focus()
  await h.replace(
    'Harbor Loft',
    'Harbor Loft (fictional) holds the offsite date until Tuesday.',
  )
  await h.release('memory.entries')
  await page.getByText(/cannot tell which/).waitFor()
  expect(await focused(page)).toMatch(NOTICE)
})

test('deleting moves focus to Keep it, back to Delete entry…, to the confirmation, then to the Entries heading', async ({
  page,
}) => {
  const h = await harness(page)
  await openKiln(page)
  await button(page, 'Delete entry…').click()
  expect(await focused(page)).toBe('BUTTON:Keep it')
  await button(page, 'Keep it').click()
  expect(await focused(page)).toBe('BUTTON:Delete entry…')
  await button(page, 'Delete entry…').click()
  await h.hold('memory.delete', 'answer')
  await button(page, 'Delete permanently').click()
  expect(await focused(page)).toBe('DIV:Delete this memory entry')
  await h.release('memory.delete')
  await button(page, /Close memory entry: The kiln/).waitFor({ state: 'detached' })
  expect(await focused(page)).toBe('H2:Entries')
})

test('focus the owner moved to plain page text stays there when a save lands', async ({
  page,
}) => {
  const h = await harness(page)
  await toReview(page)
  await h.hold('memory.write', 'answer')
  await button(page, 'Confirm and save').click()
  await page.locator('#page-text').click()
  expect(await focused(page)).toBe('BODY')
  const scroll = await page.evaluate(() => window.scrollY)
  await h.release('memory.write')
  await button(page, 'Restore previous version').waitFor()
  expect(await focused(page)).toBe('BODY')
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll)
})

test('focus the owner moved to plain page text stays there when an adoption lands', async ({
  page,
}) => {
  const h = await harness(page)
  await lockedByMerge(page, h)
  await h.hold('memory.read', 'answer')
  await button(page, 'Use this draft for the entry now here').click()
  await page.locator('#page-text').click()
  await h.release('memory.read')
  await page
    .getByText(/This draft was written for the entry that was here before/)
    .waitFor()
  expect(await focused(page)).toBe('BODY')
})

test('when a failed read is retried from its Reload and succeeds, focus moves into the editor', async ({
  page,
}) => {
  const h = await harness(page)
  // Development mode mounts twice, so both first reads fail.
  await h.fail('memory.read', 'unavailable', 'Hermes is not answering.', 2)
  await button(page, /Open memory entry: The kiln/).click()
  await page.getByText('Hermes is not answering.').waitFor()
  await button(page, 'Reload').click()
  await button(page, 'Edit').waitFor()
  expect(await focused(page)).not.toBe('BODY')
})

test('SOUL: the steps, a refused save and a successful one land focus the same way', async ({
  page,
}) => {
  const h = await harness(page, 'soul')
  await button(page, 'Edit').click()
  expect(await focused(page)).toMatch(/^TEXTAREA:/)
  const box = page.getByLabel(/^Edit soul/)
  await box.fill(`${await box.inputValue()}\nA new line (fictional).`)
  await button(page, 'Review changes').click()
  expect(await focused(page)).toBe('PRE:Changes')
  await h.hold('soul.write', 'answer')
  await h.fail('soul.write', 'unavailable', 'Hermes is not answering.')
  await button(page, 'Confirm and save').click()
  await h.release('soul.write')
  await page.getByText(/Nothing was saved/).waitFor()
  expect(await focused(page)).toBe('PRE:Changes')
  await h.hold('soul.write', 'answer')
  await button(page, 'Confirm and save').click()
  await h.release('soul.write')
  await button(page, 'Restore previous version').waitFor()
  expect(await focused(page)).toBe('BUTTON:Edit')
  await button(page, 'Restore previous version').click()
  expect(await focused(page)).toMatch(/^TEXTAREA:/)
})
