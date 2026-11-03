import { bridgeCalls, openDesktopRenderer } from './desktop-bridge.ts'
import { expect, test } from './fixtures.ts'

// Two clicks in the same task, before React re-renders, must not send two
// answers. The synthetic bridge records every call and rejects none (unlike the
// demo's fixture), so only the card's own lock can stop the second send.
const base = {
  lastSeenEpoch: 1,
  conversationId: 'c1',
  receivedAt: '2026-01-01T00:00:00.000Z',
  status: 'open',
}
const approval = {
  ...base,
  requestId: 'srq-0000000000c1',
  kind: 'approval',
  title: 'Run the export script',
  command: 'python3 export.py',
  choices: ['once', 'deny'],
}
const question = {
  ...base,
  requestId: 'srq-0000000000c2',
  kind: 'clarify',
  title: 'Rooms',
  choices: [],
  // Multi-select, so the card shows "Send answers" (a single single-select
  // question is answered with one click instead).
  questions: [
    {
      qid: 'q0',
      question: 'Which rooms?',
      choices: ['North', 'South'],
      multiSelect: true,
    },
  ],
}

const answersSent = async (page: Parameters<typeof bridgeCalls>[0]) =>
  (await bridgeCalls(page)).filter((call) => call.name === 'request.answer')

test('an approval card sends one answer for two clicks in the same task', async ({
  page,
}) => {
  await openDesktopRenderer(
    page,
    { phase: 'online' },
    { route: '/#/work', events: [{ type: 'request.opened', request: approval }] },
  )
  const card = page.getByRole('region', {
    name: /Approval needed: Run the export script/,
  })
  await card.evaluate((section) => {
    const buttons = [...section.querySelectorAll('button')]
    buttons.find((b) => b.textContent?.trim() === 'Deny')?.click()
    buttons.find((b) => b.textContent?.trim() === 'Allow once')?.click()
  })
  expect(await answersSent(page)).toEqual([
    {
      name: 'request.answer',
      args: {
        requestId: approval.requestId,
        answer: { kind: 'approval', choice: 'deny' },
      },
    },
  ])
  await expect(card.getByText('Sending your answer…')).toBeVisible()
})

test('a question card sends one answer for two submits in the same task', async ({
  page,
}) => {
  await openDesktopRenderer(
    page,
    { phase: 'online' },
    { route: '/#/work', events: [{ type: 'request.opened', request: question }] },
  )
  await page.getByRole('checkbox', { name: 'South' }).check()
  await page.getByRole('button', { name: 'Send answers' }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  expect(await answersSent(page)).toEqual([
    {
      name: 'request.answer',
      args: {
        requestId: question.requestId,
        answer: { kind: 'clarify', answers: { q0: { choices: ['South'] } } },
      },
    },
  ])
})
