import { useLayoutEffect, useRef } from 'react'
import { formatRoute, type Route } from '../router.ts'
import styles from './views.module.css'

/**
 * A destination's sections (Library's and Agent's), as links. On a phone the
 * strip scrolls sideways: the current section is scrolled into view, and the
 * strip's end fades (views.module.css), which shows only where a section runs
 * under it; padding lets the last one scroll clear.
 */
export function SectionTabs<T extends string>({
  label,
  items,
  current,
  route,
}: {
  label: string
  items: ReadonlyArray<{ id: T; label: string }>
  current: T
  route: (id: T) => Route
}) {
  const strip = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const nav = strip.current
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!nav || !tab) return
    // Only the strip scrolls: scrollIntoView could move the page too. On a
    // phone the strip's end padding is the width of its fade: clear it too.
    const fade = parseFloat(getComputedStyle(nav).paddingRight) || 0
    const end = tab.offsetLeft + tab.offsetWidth + fade
    if (end > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = end - nav.clientWidth
    else if (tab.offsetLeft < nav.scrollLeft) nav.scrollLeft = tab.offsetLeft
  }, [current])
  return (
    <div className={styles.tabsWrap}>
      <nav ref={strip} className={styles.tabs} aria-label={label}>
        {items.map((item) => (
          <a
            key={item.id}
            className={styles.tab}
            href={formatRoute(route(item.id))}
            aria-current={current === item.id ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
    </div>
  )
}
