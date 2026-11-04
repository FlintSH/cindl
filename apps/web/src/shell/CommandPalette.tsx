import { useConversations } from '@cindl/client-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../router.ts'
import { shortcuts, type ShortcutId } from '../shortcuts.ts'
import { Keys } from '../ui/primitives.tsx'
import { Overlay } from './Overlay.tsx'
import styles from './palette.module.css'

export interface Command {
  id: string
  label: string
  hint?: string
  shortcut?: ShortcutId
  run: () => void
}

/** Subsequence match: every query character appears in order. Lower score = better. */
export function fuzzyScore(query: string, text: string): number | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let position = -1
  let score = 0
  for (const char of q) {
    const next = t.indexOf(char, position + 1)
    if (next < 0) return undefined
    score += next - position - 1
    position = next
  }
  return score + (t.startsWith(q) ? -100 : 0)
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean
  onClose: () => void
  commands: Command[]
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const conversations = useConversations()
  const all = useMemo<Command[]>(
    () => [
      ...commands,
      ...conversations.map((c) => ({
        id: `conversation:${c.id}`,
        label: c.title,
        hint: c.kind === 'main' ? 'Main conversation' : 'Side conversation',
        run: () => navigate({ view: 'talk', conversationId: c.id }),
      })),
    ],
    [commands, conversations],
  )
  const results = useMemo(
    () =>
      all
        .map((command) => ({
          command,
          score: fuzzyScore(query, `${command.label} ${command.hint ?? ''}`),
        }))
        .filter((r): r is { command: Command; score: number } => r.score !== undefined)
        .sort((a, b) => a.score - b.score)
        .slice(0, 12)
        .map((r) => r.command),
    [all, query],
  )
  const list = useRef<HTMLUListElement>(null)
  // The highlighted row stays in view as the arrow keys move past the list's edge.
  useEffect(() => {
    const row = list.current?.querySelector('[aria-selected="true"]')
    // jsdom has no scrollIntoView.
    if (typeof row?.scrollIntoView === 'function')
      row.scrollIntoView({ block: 'nearest' })
  }, [active, results])
  const close = () => {
    setQuery('')
    setActive(0)
    onClose()
  }
  const run = (command: Command | undefined) => {
    if (!command) return
    close()
    command.run()
  }
  return (
    <Overlay open={open} onClose={close} label="Command palette" placement="top">
      <div className={styles.palette}>
        <input
          className={styles.input}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={
            results[active] ? `palette-${results[active].id}` : undefined
          }
          placeholder="Type a command or a conversation"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            // The arrows wrap at either end, as they do in most palettes.
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (results.length) setActive((i) => (i + 1) % results.length)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              if (results.length)
                setActive((i) => (i - 1 + results.length) % results.length)
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              run(results[active])
            }
          }}
        />
        <ul
          ref={list}
          className={styles.results}
          id="palette-results"
          role="listbox"
          aria-label="Results"
        >
          {results.map((command, index) => {
            const shortcut = shortcuts.find((s) => s.id === command.shortcut)
            return (
              <li
                key={command.id}
                id={`palette-${command.id}`}
                role="option"
                aria-selected={index === active}
                className={styles.result}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span className={styles.label}>{command.label}</span>
                {command.hint ? (
                  <span className={styles.hint}>{command.hint}</span>
                ) : null}
                {shortcut ? <Keys keys={shortcut.keys} /> : null}
              </li>
            )
          })}
          {results.length === 0 ? <li className={styles.empty}>No matches</li> : null}
        </ul>
      </div>
    </Overlay>
  )
}
