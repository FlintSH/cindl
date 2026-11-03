import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from '../src/talk/Markdown.tsx'

afterEach(cleanup)

describe('Markdown renders untrusted agent output safely', () => {
  it('never renders raw HTML', () => {
    const { container } = render(
      <Markdown
        text={
          'Hello <img src="https://tracker.example.test/p.gif" onerror="alert(1)"><script>alert(2)</script>'
        }
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
  })

  it('does not fetch remote images until the owner asks', () => {
    const { container } = render(
      <Markdown text={'![chart](https://images.example.test/q?secret=1)'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/Image from images\.example\.test not loaded/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load image' }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://images.example.test/q?secret=1',
    )
  })

  it('keeps unsafe link schemes inert and isolates safe links', () => {
    const { container } = render(
      <Markdown
        text={'[bad](javascript:alert(1)) and [ok](https://docs.example.test/page)'}
      />,
    )
    const links = [...container.querySelectorAll('a')]
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('https://docs.example.test/page')
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('bad').tagName).toBe('SPAN')
  })
})
