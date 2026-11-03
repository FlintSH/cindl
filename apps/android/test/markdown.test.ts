/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scenarioData } from '@cindl/fixtures/scenario'
import type { Image, Link } from 'mdast'
import { describe, expect, it } from 'vitest'
import {
  blockedImage,
  collectDefinitions,
  linkConfirmation,
  MAX_MARKDOWN_DEPTH,
  linkDestinationLabel,
  linkTarget,
  parseMarkdown,
  plainText,
  tableColumnWidths,
} from '../src/markdown/model.ts'

describe('agent Markdown parsing', () => {
  it('parses GFM: tables, task lists, strikethrough and autolinks', () => {
    const root = parseMarkdown(
      '| Batch | Count |\n| --- | ---: |\n| Celadon | 12 |\n\n- [x] done\n- [ ] open\n\n~~old~~ see https://example.test/a',
    )
    const types = root.children.map((node) => node.type)
    expect(types).toEqual(['table', 'list', 'paragraph'])
    const list = root.children[1]
    expect(list?.type === 'list' && list.children.map((item) => item.checked)).toEqual([
      true,
      false,
    ])
    const paragraph = root.children[2]
    expect(
      paragraph?.type === 'paragraph' && paragraph.children.map((n) => n.type),
    ).toEqual(['delete', 'text', 'link'])
  })

  it('keeps raw HTML as html nodes, which the renderer drops', () => {
    const root = parseMarkdown(
      '<img src="https://tracker.example.test/p.gif">\n\nText <b>bold</b>',
    )
    expect(root.children[0]?.type).toBe('html')
    const paragraph = root.children[1]
    expect(
      paragraph?.type === 'paragraph' && paragraph.children.map((n) => n.type),
    ).toEqual(['text', 'html', 'text', 'html'])
  })

  it('resolves reference-style links against definitions', () => {
    const root = parseMarkdown(
      '[the guide][g]\n\n[g]: https://docs.example.test/guide "Guide"',
    )
    expect(collectDefinitions(root).get('g')).toEqual({
      url: 'https://docs.example.test/guide',
      title: 'Guide',
    })
  })

  it('extracts plain text and sizes table columns from their longest cell', () => {
    const root = parseMarkdown('| a | longer header |\n| - | - |\n| x | y |')
    const table = root.children[0]
    if (table?.type !== 'table') throw new Error('expected a table')
    expect(plainText(table.children[0] as never)).toBe('alonger header')
    const [first, second] = tableColumnWidths(table)
    expect(first).toBe(72)
    expect(second).toBeGreaterThan(first as number)
  })
})

describe('link policy', () => {
  it('opens only http(s) and mailto, with a visible destination', () => {
    const https = linkTarget('https://shop.example.test/pricing?ref=1')
    expect(https).toEqual({
      kind: 'external',
      url: 'https://shop.example.test/pricing?ref=1',
      host: 'shop.example.test',
    })
    if (https.kind === 'external')
      expect(linkDestinationLabel(https)).toBe('shop.example.test')
    const mail = linkTarget('mailto:orders@supplier.example.test')
    expect(mail.kind === 'external' && linkDestinationLabel(mail)).toBe(
      'orders@supplier.example.test',
    )
  })

  it.each([
    'javascript:alert(1)',
    'intent://scan/#Intent;scheme=zxing;end',
    'file:///sdcard/notes.txt',
    '/relative/path',
    'data:text/html,<b>x</b>',
    '',
    undefined,
  ])('renders %s as inert text', (href) => {
    expect(linkTarget(href)).toEqual({ kind: 'inert' })
  })
})

describe('image policy', () => {
  it('never loads an image and names the remote host it withheld', () => {
    for (const url of [
      'https://cdn.example.test/chart.png',
      'http://cdn.example.test/x.gif',
    ])
      expect(blockedImage(url, 'Sales chart')).toEqual({
        text: 'Image from cdn.example.test not shown. (Sales chart)',
        label: 'Image not shown: Sales chart',
      })
  })

  it.each([
    'images/secret.png',
    '../../etc/passwd',
    '/var/data/photo.jpg',
    'data:image/png;base64,iVBORw0KGgo=',
    '',
    undefined,
  ])('refuses %s without a host', (src) => {
    expect(blockedImage(src, undefined)).toEqual({
      text: 'Image not shown: Cindl does not load images from messages.',
      label: 'Image not shown',
    })
  })
})

describe('hostile structure', () => {
  it('walks arbitrarily deep documents without recursion', () => {
    const quotes = parseMarkdown(
      `${'>'.repeat(5000)} deep [x]: https://deep.example.test`,
    )
    expect(() => collectDefinitions(quotes)).not.toThrow()
    expect(plainText(quotes)).toContain('deep')
    const emphasis = parseMarkdown(`${'*'.repeat(4001)}text${'*'.repeat(4001)}`)
    expect(() => plainText(emphasis)).not.toThrow()
    expect(MAX_MARKDOWN_DEPTH).toBeLessThanOrEqual(16)
  })

  it('shows the real host of a link whose path looks like another host', () => {
    expect(linkTarget('https://attacker.example.test/?@docs.example.test')).toMatchObject(
      {
        kind: 'external',
        host: 'attacker.example.test',
      },
    )
    expect(linkTarget('https://docs.example.test@attacker.example.test/')).toMatchObject({
      host: 'attacker.example.test',
    })
  })
})

// The demo's agent reply with a link and a remote image (conversation "Studio offsite
// planning", message m-off-2): what the emulator suite checks on screen.
describe('the demo reply with a link and a remote image', () => {
  const reply = scenarioData.messages.find((message) => message.id === 'm-off-2')
  const text = reply?.parts.find((part) => part.type === 'text')?.text ?? ''
  const nodes = (type: string) => {
    const found: unknown[] = []
    const walk = (node: { type: string; children?: unknown[] }) => {
      if (node.type === type) found.push(node)
      for (const child of node.children ?? []) walk(child as typeof node)
    }
    walk(parseMarkdown(text))
    return found
  }

  it('shows the link with its host and asks before opening, naming the full address', () => {
    const [link] = nodes('link') as Link[]
    const target = linkTarget(link?.url)
    if (target.kind !== 'external')
      throw new Error('the demo link should open externally')
    expect(linkDestinationLabel(target)).toBe('harbor-loft.example.test')
    expect(linkConfirmation(target)).toEqual({
      title: 'Open this link?',
      lead: 'This opens harbor-loft.example.test in your browser:',
      url: 'https://harbor-loft.example.test/visit',
    })
    const mail = linkTarget('mailto:orders@supplier.example.test')
    if (mail.kind === 'external')
      expect(linkConfirmation(mail).lead).toBe(
        'This opens your email app with this address:',
      )
  })

  it('has no image component that could load one', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'src', 'markdown', 'Markdown.tsx'),
      'utf8',
    )
    const fromReactNative =
      /import \{([^}]*)\} from 'react-native'/.exec(source)?.[1] ?? ''
    expect(fromReactNative.split(',').map((name) => name.trim())).not.toContain('Image')
    expect(source).not.toMatch(/expo-image|ImageBackground|\buri:/)
  })

  it('withholds the floor plan image and names its host', () => {
    const [image] = nodes('image') as Image[]
    expect(blockedImage(image?.url, image?.alt)).toEqual({
      text: 'Image from harbor-loft.example.test not shown. (Harbor Loft floor plan)',
      label: 'Image not shown: Harbor Loft floor plan',
    })
  })
})
