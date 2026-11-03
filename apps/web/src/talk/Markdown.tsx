import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './markdown.module.css'

/**
 * Agent output is untrusted. Raw HTML is never rendered (react-markdown's
 * default), remote images are not fetched until the owner asks, and links
 * open outside the app with their full destination visible.
 */
function SafeImage({
  src,
  alt,
}: {
  src?: string | Blob | undefined
  alt?: string | undefined
}) {
  const [load, setLoad] = useState(false)
  const url = typeof src === 'string' ? src : ''
  const local = url.startsWith('data:image/') || url.startsWith('blob:')
  if (local || load) return <img src={url} alt={alt ?? ''} className={styles.image} />
  let host = 'an unknown host'
  try {
    host = new URL(url).host || host
  } catch {
    // Relative or malformed URL: still not fetched automatically.
  }
  return (
    <span className={styles.blockedImage}>
      <span>
        Image from {host} not loaded{alt ? `: ${alt}` : ''}.
      </span>
      <button type="button" className={styles.inlineButton} onClick={() => setLoad(true)}>
        Load image
      </button>
    </span>
  )
}

const components: Components = {
  a: ({ href, children }) => {
    const safe = typeof href === 'string' && /^(https?:|mailto:)/i.test(href)
    if (!safe) return <span className={styles.inertLink}>{children}</span>
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href}>
        {children}
      </a>
    )
  },
  img: ({ src, alt }) => <SafeImage src={src} alt={alt} />,
  pre: ({ children }) => <pre className={styles.pre}>{children}</pre>,
  table: ({ children }) => (
    <div className={styles.tableWrap}>
      <table>{children}</table>
    </div>
  ),
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
})
