import type { Definition, Nodes, Root, Table } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

/**
 * Agent output is untrusted. It is parsed with the same CommonMark + GFM
 * parser family as the web client (micromark) and rendered natively; there
 * is no WebView and raw HTML is never rendered (`html` nodes are dropped,
 * like react-markdown's `skipHtml` on web).
 */
export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

export type Definitions = ReadonlyMap<string, Pick<Definition, 'url' | 'title'>>

/**
 * Deepest nesting rendered as structure. Agent output can nest quotes, lists
 * or emphasis thousands deep; anything below this renders as plain text, so
 * one message can never build a native view tree deep enough to crash.
 */
export const MAX_MARKDOWN_DEPTH = 12

/** Reference-style links and images resolve against the document's definitions. */
export function collectDefinitions(root: Root): Definitions {
  const definitions = new Map<string, Pick<Definition, 'url' | 'title'>>()
  // Iterative: untrusted documents can be nested arbitrarily deep.
  const stack: Nodes[] = [root]
  while (stack.length) {
    const node = stack.pop() as Nodes
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, { url: node.url, title: node.title ?? null })
    if ('children' in node)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push(node.children[i] as Nodes)
  }
  return definitions
}

/**
 * Link destinations are shown by host, so the URL parser must not be fooled by
 * `https://a.example.test/?@b.example.test`. Expo's runtime installs a WHATWG
 * URL; if a runtime ever falls back to a weaker one, every link turns inert.
 */
const urlHostParsingIsSafe = (() => {
  try {
    return (
      new URL('https://link.example.test/?@spoof.example.test').host ===
      'link.example.test'
    )
  } catch {
    return false
  }
})()

export type ExternalLink = { kind: 'external'; url: string; host: string }
export type LinkTarget = ExternalLink | { kind: 'inert' }

/**
 * Only http(s) and mailto links are actionable (web parity). Everything else
 * (javascript:, intent:, file:, relative paths) renders as inert text.
 */
export function linkTarget(href: string | null | undefined): LinkTarget {
  if (typeof href !== 'string' || !urlHostParsingIsSafe) return { kind: 'inert' }
  const raw = href.trim()
  if (!/^(?:https?:\/\/|mailto:)/i.test(raw)) return { kind: 'inert' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'inert' }
  }
  if (url.protocol === 'mailto:')
    return { kind: 'external', url: url.href, host: url.pathname }
  if (!url.hostname) return { kind: 'inert' }
  return { kind: 'external', url: url.href, host: url.host }
}

/**
 * Images in agent output are never loaded, remote or embedded (web parity):
 * fetching one would tell its host that, and when, the owner read the
 * message, and a prompt-injected URL can carry data out in its path or
 * query. The placeholder names the host so the owner knows what was withheld.
 */
export function blockedImage(
  src: string | null | undefined,
  alt: string | null | undefined,
): { text: string; label: string } {
  let host: string | undefined
  try {
    host =
      typeof src === 'string' && src.trim()
        ? new URL(src.trim()).host || undefined
        : undefined
  } catch {
    host = undefined
  }
  return {
    text: `${
      host
        ? `Image from ${host} not shown.`
        : 'Image not shown: Cindl does not load images from messages.'
    }${alt ? ` (${alt})` : ''}`,
    label: `Image not shown${alt ? `: ${alt}` : ''}`,
  }
}

/** Destination shown next to the link text, so it is visible without a long-press. */
export function linkDestinationLabel(target: ExternalLink): string {
  return target.url.toLowerCase().startsWith('mailto:')
    ? target.url.slice(7)
    : target.host
}

/** Text content of a node (for flattened deep content and table sizing). Iterative. */
export function plainText(node: Nodes): string {
  let text = ''
  const stack: Nodes[] = [node]
  while (stack.length) {
    const current = stack.pop() as Nodes
    if (
      current.type === 'text' ||
      current.type === 'inlineCode' ||
      current.type === 'code'
    )
      text += current.value
    else if (current.type === 'image') text += current.alt ?? ''
    else if (current.type === 'break') text += '\n'
    else if ('children' in current)
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i] as Nodes)
  }
  return text
}

/** Column widths in dp from the longest cell in each column, so rows line up. */
export function tableColumnWidths(table: Table): number[] {
  const widths: number[] = []
  for (const row of table.children)
    row.children.forEach((cell, index) => {
      const width = Math.min(260, Math.max(72, plainText(cell).length * 8 + 24))
      widths[index] = Math.max(widths[index] ?? 0, width)
    })
  return widths
}
