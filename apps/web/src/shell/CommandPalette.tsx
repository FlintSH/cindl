import { useConversations } from '@cindl/client-react'
import { MessageSquare, Pin, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { navigate } from '../router.ts'
import { shortcuts, type ShortcutId } from '../shortcuts.ts'
import { Keys } from '../ui/primitives.tsx'
import { Overlay } from './Overlay.tsx'
import styles from './palette.module.css'

/** Where a command sits in the palette (after T3 Code's grouped palette). */
export type CommandGroup = 'go' | 'actions' | 'conversations' | 'theme'

const groupLabels: Record<CommandGroup, string> = {
  go: 'Go to',
  actions: 'Actions',
  conversations: 'Conversations',
  theme: 'Theme',
}
const groupOrder: CommandGroup[] = ['go', 'actions', 'conversations', 'theme']
/** With nothing typed, the palette lists only the most recent conversations. */
const RECENT = 5

export interface Command {
  id: string
  label: string
  hint?: string
  shortcut?: ShortcutId
  group: CommandGroup
  icon?: LucideIcon
  /** The conversation on screen: left out of the recent ones, last among matches. */
  current?: boolean
  run: () => void
}

interface Group {
  group: CommandGroup
  items: Command[]
}

/**
 * The palette's rows, grouped. Nothing typed: every command in a fixed group
 * order, and the most recent conversations other than the one on screen.
 * Typed: matches only, groups ordered by their best match so Enter runs the
 * best row, the conversation on screen last. A leading `>` searches commands
 * alone. All after T3 Code.
 */
export function paletteGroups(
  commands: readonly Command[],
  conversations: readonly Command[],
  query: string,
): Group[] {
  const commandsOnly = query.trimStart().startsWith('>')
  const typed = (commandsOnly ? query.trimStart().slice(1) : query).trim()
  const pool = commandsOnly ? commands : [...commands, ...conversations]
  if (!typed)
    return groupOrder
      .map((group) => {
        const items = pool.filter((c) => c.group === group)
        return {
          group,
          items:
            group === 'conversations'
              ? items.filter((c) => !c.current).slice(0, RECENT)
              : items,
        }
      })
      .filter((g) => g.items.length > 0)
  const scored = pool
    .map((command) => ({
      command,
      score: fuzzyScore(typed, `${command.label} ${command.hint ?? ''}`),
    }))
    .filter((r): r is { command: Command; score: number } => r.score !== undefined)
    .sort(
      (a, b) =>
        Number(a.command.current ?? false) - Number(b.command.current ?? false) ||
        a.score - b.score,
    )
  const best = new Map<CommandGroup, number>()
  for (const { command, score } of scored)
    if (!best.has(command.group)) best.set(command.group, score)
  return [...best.keys()]
    .sort((a, b) => (best.get(a) ?? 0) - (best.get(b) ?? 0))
    .map((group) => ({
      group,
      items: scored.filter((r) => r.command.group === group).map((r) => r.command),
    }))
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
  currentId,
}: {
  open: boolean
  onClose: () => void
  commands: Command[]
  /** The conversation on screen, if Talk is open. */
  currentId?: string | undefined
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const id = useId()
  const conversations = useConversations()
  const conversationCommands = useMemo<Command[]>(
    () =>
      conversations.map((c) => ({
        id: `conversation:${c.id}`,
        label: c.title,
        hint:
          c.id === currentId
            ? 'Current conversation'
            : c.kind === 'main'
              ? 'Main conversation'
              : 'Side conversation',
        group: 'conversations' as const,
        icon: c.kind === 'main' ? Pin : MessageSquare,
        current: c.id === currentId,
        run: () => navigate({ view: 'talk', conversationId: c.id }),
      })),
    [conversations, currentId],
  )
  const groups = useMemo(
    () => paletteGroups(commands, conversationCommands, query),
    [commands, conversationCommands, query],
  )
  const results = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const list = useRef<HTMLDivElement>(null)
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
          placeholder="Search commands and conversations"
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
        <div
          ref={list}
          className={styles.results}
          id="palette-results"
          role="listbox"
          aria-label="Results"
        >
          {groups.map((group) => (
            <div
              key={group.group}
              role="group"
              aria-labelledby={`${id}-${group.group}`}
              className={styles.group}
            >
              <div id={`${id}-${group.group}`} className={styles.groupLabel}>
                {groupLabels[group.group]}
              </div>
              {group.items.map((command) => {
                const index = results.indexOf(command)
                const shortcut = shortcuts.find((s) => s.id === command.shortcut)
                const Icon = command.icon
                return (
                  <div
                    key={command.id}
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    className={styles.result}
                    onMouseMove={() => setActive(index)}
                    // A press keeps focus in the search box, so the keys still work.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => run(command)}
                  >
                    {Icon ? (
                      <Icon size={16} aria-hidden="true" className={styles.icon} />
                    ) : null}
                    <span className={styles.label}>{command.label}</span>
                    {command.hint ? (
                      <span className={styles.hint}>{command.hint}</span>
                    ) : null}
                    {shortcut ? <Keys keys={shortcut.keys} /> : null}
                  </div>
                )
              })}
            </div>
          ))}
          {results.length === 0 ? <p className={styles.empty}>No matches</p> : null}
        </div>
        {/* For a keyboard; hidden on touch screens (palette.module.css). */}
        <p className={styles.footer} aria-hidden="true">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to run
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
          <span>
            <kbd>&gt;</kbd> for commands only
          </span>
        </p>
      </div>
    </Overlay>
  )
}
