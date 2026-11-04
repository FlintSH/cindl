import { CindlProvider } from '@cindl/client-react'
import type { CindlClientApi } from '@cindl/contracts'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../src/talk/Markdown.tsx'
import { MessageView } from '../src/talk/MessageView.tsx'

const writeText = vi.fn<(text: string) => Promise<void>>()
const execCommand = vi.fn<(command: string) => boolean>()

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  execCommand.mockReset().mockReturnValue(true)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  // jsdom has no execCommand; the copy fallback calls it.
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  })
})
afterEach(cleanup)

const settle = () => act(async () => {})

/** A client with nothing in it: a reply's step rows look their tools up here. */
const api: CindlClientApi = {
  call: (name) => Promise.reject(new Error(`unexpected ${name}`)),
  subscribe: () => () => undefined,
}
const withClient = (node: ReactNode) => <CindlProvider api={api}>{node}</CindlProvider>

describe('copying', () => {
  it('copies exactly the code a block shows, and says so', async () => {
    render(<Markdown text={'Run this:\n\n```sh\npnpm install --frozen-lockfile\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('pnpm install --frozen-lockfile\n')
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })

  it('falls back to the copy command where the clipboard is refused (the desktop app)', async () => {
    writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    render(<Markdown text={'```\nsecret-free text\n```'} />)
    const button = screen.getByRole('button', { name: 'Copy code' })
    button.focus()
    fireEvent.click(button)
    await settle()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('status').textContent).toBe('Copied')
    // The hidden text area it used is gone, and focus is back on the button.
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('says when copying failed', async () => {
    writeText.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    execCommand.mockReturnValue(false)
    render(<Markdown text={'```\nx\n```'} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await settle()
    expect(screen.getByRole('status').textContent).toBe('Copy failed')
  })

  it('copies a finished reply’s words, without its steps, and offers nothing while it streams', async () => {
    const message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      parts: [
        { type: 'text' as const, text: 'First **part**.' },
        { type: 'tool' as const, toolId: 'tool-missing' },
        { type: 'text' as const, text: 'Second part.' },
      ],
      status: 'complete' as const,
      createdAt: new Date().toISOString(),
    }
    const props = {
      agentName: 'Hermes',
      selectedToolId: undefined,
      blockedToolIds: new Set<string>(),
      onSelectTool: () => undefined,
    }
    const view = render(withClient(<MessageView message={message} {...props} />))
    fireEvent.click(screen.getByRole('button', { name: 'Copy reply' }))
    await settle()
    expect(writeText).toHaveBeenCalledWith('First **part**.\n\nSecond part.')
    view.rerender(
      withClient(
        <MessageView message={{ ...message, status: 'streaming' }} {...props} />,
      ),
    )
    expect(screen.queryByRole('button', { name: 'Copy reply' })).toBeNull()
    expect(screen.getByText(/^Working/)).toBeTruthy()
  })
})
