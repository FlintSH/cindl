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
