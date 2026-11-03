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
  await expect(
    page.getByRole('link', { name: 'Work, 2 waiting on you' }).first(),
  ).toBeVisible()
})

test('answers an approval once and shows the result', async ({ page }) => {
  const card = page.getByRole('region', {
    name: /Approval needed: Run the inventory export script/,
  })
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('code')).toHaveText(/export_inventory\.py/)
  await expect(card).toContainText(
    'Standing grants (session, always) are not offered from Cindl.',
  )
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('Done. The inventory sheet is current')).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(
    page.getByRole('link', { name: 'Work, 1 waiting on you' }).first(),
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
  await page.goto('/#/library/memory')
  await expect(
    page.getByText('Reading and editing memory text: Not supported.'),
  ).toBeVisible()
  await page.goto('/#/agent/connections')
  await expect(page.getByText('Account coverage: Not supported.')).toBeVisible()
  await page.goto('/#/agent/runtime')
  await expect(page.getByRole('cell', { name: 'presence.unified' })).toBeVisible()
})
