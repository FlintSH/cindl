import { expect, test } from './fixtures.ts'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('note')).toContainText('Synthetic demo')
})

test('opens on the main conversation with honest presence', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Today/ })).toBeVisible()
  await expect(
    page.getByRole('status').filter({ hasText: 'Waiting on you' }),
  ).toContainText('1 approval, 1 question')
  // Two requests here, plus a sudo prompt in a side conversation that only
  // another Hermes surface can answer.
  await expect(
    page.getByRole('link', { name: /^Work\b.*3 waiting on you/ }).first(),
  ).toBeVisible()
})

test('shows a prompt Cindl never answers, with nothing to send', async ({ page }) => {
  await page.goto('/#/work')
  const card = page.getByRole('region', {
    name: /Answer outside Cindl: sudo password to restart the label printer/,
  })
  await expect(card).toContainText('Hermes is waiting for a sudo password.')
  await expect(card).toContainText('sends nothing for this prompt')
  await expect(card.getByRole('button')).toHaveCount(0)
  await expect(card.getByRole('textbox')).toHaveCount(0)
  await page.goto('/#/talk/demo-inventory')
  await expect(
    page.getByRole('status').filter({ hasText: 'Waiting on you' }),
  ).toContainText('1 prompt outside Cindl')
  await expect(page.locator('#composer-hint')).toHaveText(/outside Cindl/)
})

test('answers an approval once and shows the result', async ({ page }) => {
  const card = page.getByRole('region', {
    name: /Approval needed: Run the inventory export script/,
  })
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('code')).toHaveText(/export_inventory\.py/)
  await expect(card).toContainText('Applies to this action only.')
  await card.getByText('Why only once?').click()
  await expect(card).toContainText('Cindl only sends one-time decisions')
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Done. The inventory sheet is current')).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: /^Work\b.*2 waiting on you/ }).first(),
  ).toBeVisible()
})

test('sends a message and streams the synthetic reply', async ({ page }) => {
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.fill('What is left for today?')
  await box.press('Enter')
  await expect(page.getByRole('article', { name: /^You/ }).last()).toContainText(
    'What is left for today?',
  )
  await expect(page.getByText('nothing reached Hermes', { exact: false })).toBeVisible()
})

test('keyboard reaches every destination and the palette', async ({ page }) => {
  await page.keyboard.press(`${mod}+K`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.type('go to work')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Work' })).toBeVisible()
  await page.keyboard.press('Alt+3')
  await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  await page.keyboard.press('Alt+4')
  await expect(page.getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible()
  await page.keyboard.press('Alt+1')
  await expect(page.getByRole('button', { name: /Today/ })).toBeVisible()
})

test('the working margin points to open requests instead of duplicating them', async ({
  page,
}) => {
  const margin = page.getByRole('complementary', { name: 'Working margin' })
  await expect(margin.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
  await margin
    .getByRole('button', { name: /Show approval: Run the inventory export script/ })
    .click()
  await expect(
    page.getByRole('heading', {
      name: /Approval needed: Run the inventory export script/,
    }),
  ).toBeFocused()
})

test('switches conversations from the searchable history', async ({ page }) => {
  await page.keyboard.press(`${mod}+J`)
  const history = page.getByRole('dialog', { name: 'Conversations' })
  await history.getByRole('textbox', { name: 'Search conversations' }).fill('kiln')
  await history.getByRole('button', { name: /Kiln inventory sheet/ }).click()
  await expect(page.getByRole('button', { name: /Kiln inventory sheet/ })).toBeVisible()
  await expect(page.getByText('42 glaze batches')).toBeVisible()
})

test('the conversation search opens its best match on Enter; the arrows walk the list', async ({
  page,
}) => {
  await page.keyboard.press(`${mod}+J`)
  const history = page.getByRole('dialog', { name: 'Conversations' })
  const search = history.getByRole('textbox', { name: 'Search conversations' })
  await expect(search).toBeFocused()
  await search.press('ArrowDown')
  await expect(history.getByRole('button', { name: /Today/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    history.getByRole('button', { name: /Kiln inventory sheet/ }),
  ).toBeFocused()
  // Typing from the list goes on in the search box.
  await page.keyboard.press('k')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('k')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(search).toBeFocused()
  await search.fill('kiln')
  await search.press('Enter')
  await expect(history).toBeHidden()
  await expect(
    page.getByRole('region', { name: 'Conversation: Kiln inventory sheet' }),
  ).toBeVisible()
})

test('the palette wraps, marks the theme in use, and the shortcuts list closes from its button', async ({
  page,
}) => {
  // Short enough that the palette's list scrolls: wrapping must bring the row into view.
  await page.setViewportSize({ width: 1280, height: 500 })
  await page.keyboard.press(`${mod}+K`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const options = palette.getByRole('option')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('aria-selected', 'true')
  await expect(options.last()).toBeInViewport()
  await page.keyboard.press('ArrowDown')
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.type('theme')
  await expect(palette.getByRole('option', { name: /Match system theme/ })).toContainText(
    'Current',
  )
  await expect(palette.getByRole('option', { name: /Use dark theme/ })).not.toContainText(
    'Current',
  )
  await page.keyboard.press('Escape')
  await page.locator('body').press('?')
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(help).toBeVisible()
  await help.getByRole('button', { name: 'Close keyboard shortcuts' }).click()
  await expect(help).toBeHidden()
})

test('on a phone the section tabs keep the current one in view, clear of the fade', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/agent/appearance')
  const strip = page.getByRole('navigation', { name: 'Agent sections' })
  const tab = strip.getByRole('link', { name: 'Appearance' })
  await expect(tab).toHaveAttribute('aria-current', 'page')
  const box = await strip.boundingBox()
  const at = await tab.boundingBox()
  if (!box || !at) throw new Error('The tab strip is not laid out.')
  expect(at.x).toBeGreaterThanOrEqual(box.x)
  // The last 2rem of the strip fade out on a phone.
  expect(at.x + at.width).toBeLessThanOrEqual(box.x + box.width - 31)
})

test('the connection status says its state, not only its colour', async ({ page }) => {
  const status = page
    .getByRole('navigation', { name: 'Primary' })
    .first()
    .getByRole('link', {
      name: /^Connection: Synthetic demo, not connected\. Show details$/,
    })
  await expect(status).toHaveAttribute('title', /Synthetic demo, not connected/)
  await expect(page).toHaveTitle(/^\(3\) Cindl/)
})

test('typing on Talk with nothing to type into goes on in the message box', async ({
  page,
}) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type('hi')
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('hi')
})

test('"Latest" says what waits below and never drops focus', async ({ page }) => {
  const timeline = page.getByRole('log', { name: 'Messages' }).locator('xpath=..')
  const toTop = () =>
    timeline.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await box.focus()
  await toTop()
  const latest = page.getByRole('button', {
    name: 'Jump to latest messages, where Hermes waits on you',
  })
  await expect(latest).toContainText('Needs you')
  await latest.click()
  await expect(latest).toBeHidden()
  await expect(box).toBeFocused()
  // From the keyboard, focus goes on to the message box as the pill leaves.
  await toTop()
  await latest.focus()
  await page.keyboard.press('Enter')
  await expect(latest).toBeHidden()
  await expect(box).toBeFocused()
})

test('a new side conversation opens ready to write in, and says it is empty', async ({
  page,
}) => {
  const box = page.getByRole('textbox', { name: 'Message Hermes' })
  await page.getByRole('button', { name: 'New side conversation' }).click()
  await expect(
    page.getByRole('region', { name: 'Conversation: New side conversation' }),
  ).toBeVisible()
  await expect(box).toBeFocused()
  await expect(
    page.getByText('This side conversation runs apart from the main one.'),
  ).toBeVisible()
  // From the conversation list too.
  await page.keyboard.press(`${mod}+J`)
  await page
    .getByRole('dialog', { name: 'Conversations' })
    // Exact: the conversation just made is itself titled "New side conversation".
    .getByRole('button', { name: 'New side conversation', exact: true })
    .click()
  await expect(box).toBeFocused()
})

test('Needs you names the conversation each request belongs to', async ({ page }) => {
  await page.goto('/#/work')
  const needsYou = page.getByRole('region', { name: 'Needs you' })
  await expect(needsYou.getByRole('link', { name: 'Today' })).toHaveCount(2)
  await needsYou.getByRole('link', { name: 'Kiln inventory sheet' }).click()
  await expect(
    page.getByRole('region', { name: 'Conversation: Kiln inventory sheet' }),
  ).toBeVisible()
})

test('SOUL edits require a reviewed diff and confirmation', async ({ page }) => {
  await page.goto('/#/agent/identity')
  await page.getByRole('button', { name: 'Edit' }).click()
  const editor = page.getByRole('textbox', { name: /Edit soul/ })
  await editor.press('End')
  await editor.press(`${mod}+End`)
  await editor.type('\n- Keep Fridays meeting-free (synthetic).')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await expect(page.getByLabel('Changes')).toContainText(
    '+ - Keep Fridays meeting-free (synthetic).',
  )
  await page.getByRole('button', { name: 'Confirm and save' }).click()
  await expect(
    page.getByText('The previous version is kept on this screen'),
  ).toBeVisible()
})

test('unsupported Hermes v0.22.5 capabilities are explained, not faked', async ({
  page,
}) => {
  await page.goto('/#/agent/connections')
  await expect(page.getByText('Account coverage: Not supported.')).toBeVisible()
  await page.goto('/#/agent/runtime')
  await expect(page.getByRole('cell', { name: 'presence.unified' })).toBeVisible()
})

test('memory entries change only after a reviewed diff, and deletes warn first', async ({
  page,
}) => {
  await page.goto('/#/library/memory')
  await page
    .getByRole('button', { name: /Open memory entry: Glaze supplier calls/ })
    .click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit agent note 1' })
    .fill('Glaze supplier calls moved to Wednesdays at 10:00 (fictional supplier).')
  await page.getByRole('button', { name: 'Review changes' }).click()
  await page.getByRole('button', { name: 'Confirm and save' }).click()
  await expect(page.getByText(/moved to Wednesdays/).first()).toBeVisible()

  await page.getByRole('button', { name: 'Delete entry…' }).click()
  await expect(
    page.getByText(/Hermes keeps no backup, so this cannot be undone/),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(page.getByText(/moved to Wednesdays/)).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /Open memory entry: The kiln firing log/ }),
  ).toBeVisible()
})

test('shows where agent links go and never loads images from messages', async ({
  page,
}) => {
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))
  await page.goto('/#/talk/demo-offsite')
  const link = page.getByRole('link', { name: 'the venue page' })
  await expect(link).toHaveAttribute('href', 'https://harbor-loft.example.test/visit')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(page.getByText('(harbor-loft.example.test)')).toBeVisible()
  await expect(
    page.getByRole('img', { name: 'Image not shown: Harbor Loft floor plan' }),
  ).toBeVisible()
  expect(requested.filter((url) => url.includes('harbor-loft.example.test'))).toEqual([])
})
