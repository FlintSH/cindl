import { expect, test } from './fixtures.ts'

// The T3 Code-inspired workspace on a wide screen: the conversation list
// beside Talk, the work log, the composer and the docked question set.
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/talk')
  await expect(page.getByRole('note')).toContainText('Synthetic demo')
})

test('the conversation list shows status where it matters and the time otherwise', async ({
  page,
}) => {
  const list = page.getByRole('navigation', { name: 'Conversations' })
  await expect(list.getByRole('heading', { name: 'Pinned' })).toBeVisible()
  const today = list.getByRole('button', { name: /^Today, main conversation/ })
  await expect(today).toHaveAttribute('aria-current', 'page')
  await expect(today).toContainText('2 need you')
  await expect(list.getByRole('heading', { name: /Needs you/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /^Kiln inventory sheet/ })).toContainText(
    'Needs you',
  )
  await expect(
    list.getByRole('button', { name: /^Studio offsite planning/ }),
  ).toContainText(/Jun 1|Jun 2|\dd|\dh|\dm|now/)
})

test('the arrows walk the list without opening anything; Enter opens', async ({
  page,
}) => {
  const list = page.getByRole('navigation', { name: 'Conversations' })
  const today = list.getByRole('button', { name: /^Today/ })
  await today.focus()
  await page.keyboard.press('ArrowDown')
  const kiln = list.getByRole('button', { name: /^Kiln inventory sheet/ })
  await expect(kiln).toBeFocused()
  await expect(page.getByRole('region', { name: 'Conversation: Today' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('region', { name: 'Conversation: Kiln inventory sheet' }),
  ).toBeVisible()
  // The list stays put, and so does focus on its row.
  await expect(kiln).toBeFocused()
  await expect(kiln).toHaveAttribute('aria-current', 'page')
  // Up from the first row reaches the search box; typing filters.
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowUp')
  const search = list.getByRole('textbox', { name: 'Search conversations' })
  await expect(search).toBeFocused()
  await page.keyboard.type('offsite')
  await expect(list.getByRole('button')).toHaveCount(4) // new, hide, clear, one row
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('region', { name: 'Conversation: Studio offsite planning' }),
  ).toBeVisible()
})

test('Ctrl/⌘ B hides and shows the list; hidden from inside, focus goes to what shows it', async ({
  page,
}) => {
  const list = page.getByRole('navigation', { name: 'Conversations' })
  await list.getByRole('button', { name: /^Today/ }).focus()
  await page.keyboard.press(`${mod}+B`)
  await expect(list).toHaveCount(0)
  const show = page.getByRole('button', { name: 'Show the conversation list' })
  await expect(show).toBeFocused()
  await page.keyboard.press(`${mod}+B`)
  await expect(list).toBeVisible()
  // Ctrl/⌘ J goes to its search while it is shown.
  await page.keyboard.press(`${mod}+J`)
  await expect(list.getByRole('textbox', { name: 'Search conversations' })).toBeFocused()
  await expect(page.getByRole('dialog', { name: 'Conversations' })).toHaveCount(0)
})

test('F2 renames a conversation in place; Escape keeps its name', async ({ page }) => {
  const list = page.getByRole('navigation', { name: 'Conversations' })
  const row = list.getByRole('button', { name: /^Studio offsite planning/ })
  await row.focus()
  await page.keyboard.press('F2')
  const field = list.getByRole('textbox', { name: 'Rename Studio offsite planning' })
  await expect(field).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(row).toBeFocused()
  await page.keyboard.press('F2')
  await field.fill('Offsite, planning call')
  await page.keyboard.press('Enter')
  const renamed = list.getByRole('button', { name: /^Offsite, planning call/ })
  await expect(renamed).toBeVisible()
  await expect(renamed).toBeFocused()
})

test('finished steps fold into one line that opens into them', async ({ page }) => {
  const group = page.getByRole('button', { name: /^2 steps/ })
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(
    page.getByRole('button', { name: /Checked the studio calendar/ }),
  ).toHaveCount(0)
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: /Checked the studio calendar/ }).click()
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await expect(margin.getByRole('tab', { name: 'Step', selected: true })).toBeVisible()
  // A selected step keeps its group open, whatever the owner chose before.
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
})

test('the question set waits above the composer; approvals stay in the conversation', async ({
  page,
}) => {
  const dock = page.getByRole('region', { name: /Question: Offsite venue and prep/ })
  const composer = page.getByRole('textbox', { name: 'Message Hermes' })
  const dockBox = await dock.boundingBox()
  const composerBox = await composer.boundingBox()
  if (!dockBox || !composerBox) throw new Error('Not laid out.')
  expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(composerBox.y)
  await expect(page.getByRole('log', { name: 'Messages' })).not.toContainText(
    'Offsite venue and prep',
  )
  await expect(
    page.getByRole('log', { name: 'Messages' }).getByRole('region', {
      name: /Approval needed: Run the inventory export script/,
    }),
  ).toBeVisible()
})

test('the list resizes from its edge, by drag or keys, within bounds, and remembers', async ({
  page,
}) => {
  const list = page.getByRole('navigation', { name: 'Conversations' })
  const edge = list.getByRole('separator', { name: 'Resize the conversation list' })
  const widthOf = async () => (await list.boundingBox())?.width ?? 0
  const start = await widthOf()
  await edge.focus()
  await page.keyboard.press('ArrowRight')
  await expect(edge).toHaveAttribute('aria-valuenow', String(Math.round(start) + 16))
  await page.keyboard.press('End')
  await expect(edge).toHaveAttribute('aria-valuenow', '384')
  await edge.dblclick()
  await expect(edge).toHaveAttribute('aria-valuenow', '264')
  const box = await edge.boundingBox()
  if (!box) throw new Error('No edge.')
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + 200, { steps: 4 })
  await page.mouse.up()
  await expect(edge).toHaveAttribute('aria-valuenow', '224')
  await page.reload()
  await expect(
    page
      .getByRole('navigation', { name: 'Conversations' })
      .getByRole('separator', { name: 'Resize the conversation list' }),
  ).toHaveAttribute('aria-valuenow', '224')
})

test('a long message folds; Show full message opens it', async ({ page }) => {
  await page.goto('/#/talk/demo-offsite')
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.fill('A line of a pasted log (synthetic).\n'.repeat(12))
  await box.press('Enter')
  const mine = page.getByRole('article', { name: /^You/ }).last()
  const unfold = mine.getByRole('button', { name: 'Show full message' })
  await expect(unfold).toHaveAttribute('aria-expanded', 'false')
  await unfold.click()
  await expect(mine.getByRole('button', { name: 'Show less' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // Copy sits beside it, shown on hover.
  await mine.hover()
  await expect(mine.getByRole('button', { name: 'Copy message' })).toBeVisible()
})
