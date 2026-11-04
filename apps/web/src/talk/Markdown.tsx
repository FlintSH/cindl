import { memo, useRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from '../ui/CopyButton.tsx'
import styles from './markdown.module.css'

/**
 * Agent output is untrusted. Raw HTML is never rendered (react-markdown's
 * default). Links show their real destination host as visible text, so a
 * link labelled with one address cannot silently point at another, on touch
 * devices too. Images are never loaded from agent output: the production CSP
 * blocks remote images, a relative path would be fetched from the hosting
 * origin with the owner's session, and react-markdown strips data: URLs.
 */
function hostOf(href: string): string | undefined {
  try {
    return new URL(href).host || undefined
  } catch {
    return undefined
  }
}

/** Names what was withheld instead of loading it. */
function BlockedImage({
  src,
  alt,
}: {
  src?: string | Blob | undefined
  alt?: string | undefined
}) {
  const host = hostOf(typeof src === 'string' ? src : '')
  return (
    <span
      className={styles.blockedImage}
      role="img"
      aria-label={`Image not shown${alt ? `: ${alt}` : ''}`}
    >
      {host
        ? `Image from ${host} not shown.`
        : 'Image not shown: Cindl does not load images from messages.'}{' '}
      {alt ? <span className={styles.altText}>({alt})</span> : null}
    </span>
  )
}

/** A code block, with a button that copies exactly the code shown. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className={styles.code}>
      <pre ref={pre} className={styles.pre}>
        {children}
      </pre>
      <CopyButton
        label="Copy code"
        className={styles.copyCode}
        text={() => pre.current?.textContent ?? ''}
      />
    </div>
  )
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^(https?:|mailto:)/i.test(href)
    if (!safe) return <span className={styles.inertLink}>{children}</span>
    const destination = href.toLowerCase().startsWith('mailto:')
      ? href.slice(7)
      : hostOf(href)
    return (
      <>
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
        {destination ? <span className={styles.linkHost}> ({destination})</span> : null}
      </>
    )
  },
  img: ({ src, alt }) => <BlockedImage src={src} alt={alt} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown} data-prose>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
})
