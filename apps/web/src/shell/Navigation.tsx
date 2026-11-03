import {
  Activity,
  Library,
  MessageSquareText,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { Destination } from '../router.ts'
import { formatRoute, type Route } from '../router.ts'
import styles from './shell.module.css'

const destinations: Array<{
  id: Destination
  label: string
  icon: LucideIcon
  route: Route
}> = [
  { id: 'talk', label: 'Talk', icon: MessageSquareText, route: { view: 'talk' } },
  { id: 'work', label: 'Work', icon: Activity, route: { view: 'work' } },
  {
    id: 'library',
    label: 'Library',
    icon: Library,
    route: { view: 'library', section: 'skills' },
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: UserRound,
    route: { view: 'agent', section: 'identity' },
  },
]

export function NavList({
  current,
  workCount,
}: {
  current: Destination
  workCount: number
}) {
  return (
    <ul className={styles.navList}>
      {destinations.map(({ id, label, icon: Icon, route }) => (
        <li key={id}>
          <a
            href={formatRoute(route)}
            className={styles.navItem}
            aria-current={current === id ? 'page' : undefined}
            aria-label={
              id === 'work' && workCount > 0
                ? `${label}, ${workCount} waiting on you`
                : label
            }
          >
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>{label}</span>
            {id === 'work' && workCount > 0 ? (
              <span className={styles.count} aria-hidden="true">
                {workCount > 9 ? '9+' : workCount}
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ul>
  )
}
