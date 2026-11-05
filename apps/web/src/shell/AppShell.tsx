import {
  useCan,
  useConversations,
  useLink,
  useMainConversation,
  useOpenRequests,
} from '@cindl/client-react'
import { SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import {
  Activity,
  Fingerprint,
  Keyboard,
  Library,
  MessageSquareText,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plug,
  SquarePen,
  Sun,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentView } from '../agent/AgentView.tsx'
import { LibraryView } from '../library/LibraryView.tsx'
import { applyTheme, setPreference, usePreference } from '../platform/preferences.ts'
import { useMediaQuery } from '../platform/useMediaQuery.ts'
import {
  ConversationList,
  type ConversationListHandle,
} from '../talk/ConversationList.tsx'
import { navigate, useRoute, type Destination } from '../router.ts'
import { matchShortcut } from '../shortcuts.ts'
import { TalkView, type TalkHandle } from '../talk/TalkView.tsx'
import { Mark } from '../ui/Mark.tsx'
import { WorkView } from '../work/WorkView.tsx'
import { CommandPalette, type Command } from './CommandPalette.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { pruneRequestDrafts } from '../talk/RequestCard.tsx'
import { forgetDocumentDrafts } from '../views/DocumentEditor.tsx'
import { forgetPlaces } from '../talk/places.ts'
import { flatten, shelvesOf } from '../talk/conversationList.ts'
import { noteStatuses } from '../talk/finished.ts'
import { Notices } from './Notices.tsx'
import { SignIn } from './SignIn.tsx'
import { forgetAttempts, useSigningIn } from './session.ts'
import { linkCopy, LinkStatusDot } from './LinkStatus.tsx'
import { NavList } from './Navigation.tsx'
import { ShortcutsDialog } from './ShortcutsDialog.tsx'
import { pageTitle } from './title.ts'
import styles from './shell.module.css'

export function AppShell() {
  const route = useRoute()
  const link = useLink()
  const open = useOpenRequests()
  const canCreate = useCan('sessions.create')
  const signingIn = useSigningIn()
  // Native clients without a session sign in first; the demo never needs to.
  // A sign-in the sign-in screen started keeps that screen while the client
  // connects, so its outcome (and "Stop waiting") stays where it was asked.
  const needsSignIn =
    !link.demo &&
    (link.phase === 'unconfigured' ||
      link.phase === 'signed-out' ||
      (signingIn && link.phase === 'connecting'))
  const [theme] = usePreference('theme')
  const status = linkCopy(link.phase, link.demo)
  // The conversation list beside Talk, on wide screens only (Ctrl/⌘ B).
  const wide = useMediaQuery('(min-width: 1280px)')
  const [listOpen, setListOpen] = usePreference('conversationsOpen')
  const main = useMainConversation()
  const conversations = useConversations()
  const list = useRef<ConversationListHandle>(null)
  const showList = wide && listOpen && route.view === 'talk' && !needsSignIn
  const currentConversation =
    route.view === 'talk'
      ? (route.conversationId ?? main?.id ?? conversations[0]?.id)
      : undefined
  const hideList = useCallback(() => {
    // Hidden with focus inside: focus goes to what shows it again.
    const inside = document.activeElement?.closest('[data-conversation-list]') != null
    setListOpen(false)
    if (inside)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-show-conversations]')?.focus(),
      )
  }, [setListOpen])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const talk = useRef<TalkHandle>(null)
  const current: Destination = route.view

  useEffect(() => applyTheme(theme), [theme])
  // What Hermes finishes while the owner looks elsewhere is marked "Done".
  useEffect(
    () => noteStatuses(conversations, currentConversation),
    [conversations, currentConversation],
  )
  // Drafts belong to open requests only.
  useEffect(() => pruneRequestDrafts(new Set(open.map((r) => r.requestId))), [open])
  // Nothing typed on this device outlives the session, however it ended: the
  // sign-out button, or Hermes refusing the session. Kept document drafts go
  // too, so none returns after another sign-in, to this Hermes or another.
  useEffect(() => {
    if (!link.demo && link.phase === 'signed-out') {
      forgetDocumentDrafts()
      forgetPlaces()
    }
  }, [link.demo, link.phase])
  // Online again: what earlier sign-in and sign-out attempts left behind no longer applies.
  useEffect(() => {
    if (link.phase === 'online') forgetAttempts()
  }, [link.phase])
  useEffect(() => {
    document.title = pageTitle(open.length, link.demo)
  }, [link.demo, open.length])

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'go-talk',
        group: 'go' as const,
        icon: MessageSquareText,
        label: 'Go to Talk',
        shortcut: 'go-talk',
        run: () => navigate({ view: 'talk' }),
      },
      {
        id: 'go-work',
        group: 'go' as const,
        icon: Activity,
        label: 'Go to Work',
        hint: 'Approvals, running work, routines, computer',
        shortcut: 'go-work',
        run: () => navigate({ view: 'work' }),
      },
      {
        id: 'go-library',
        group: 'go' as const,
        icon: Library,
        label: 'Go to Library',
        hint: 'Skills, memory, artifacts',
        shortcut: 'go-library',
        run: () => navigate({ view: 'library', section: 'skills' }),
      },
      {
        id: 'go-agent',
        group: 'go' as const,
        icon: UserRound,
        label: 'Go to Agent',
        hint: 'Identity, connections, runtime',
        shortcut: 'go-agent',
        run: () => navigate({ view: 'agent', section: 'identity' }),
      },
      ...(canCreate
        ? [
            {
              id: 'new-side',
              group: 'actions' as const,
              icon: SquarePen,
              label: 'Start a side conversation',
              shortcut: 'new-side' as const,
              run: () => {
                navigate({ view: 'talk' })
                queueMicrotask(() => talk.current?.newSideConversation())
              },
            },
          ]
        : []),
      {
        id: 'identity',
        group: 'go' as const,
        icon: Fingerprint,
        label: 'Open identity (SOUL.md)',
        run: () => navigate({ view: 'agent', section: 'identity' }),
      },
      {
        id: 'runtime',
        group: 'go' as const,
        icon: Plug,
        label: 'Show connection and capabilities',
        run: () => navigate({ view: 'agent', section: 'runtime' }),
      },
      {
        id: 'theme-light',
        group: 'theme' as const,
        icon: Sun,
        label: 'Use light theme',
        ...(theme === 'light' ? { hint: 'Current' } : {}),
        run: () => setPreference('theme', 'light'),
      },
      {
        id: 'theme-dark',
        group: 'theme' as const,
        icon: Moon,
        label: 'Use dark theme',
        ...(theme === 'dark' ? { hint: 'Current' } : {}),
        run: () => setPreference('theme', 'dark'),
      },
      {
        id: 'theme-system',
        group: 'theme' as const,
        icon: Monitor,
        label: 'Match system theme',
        ...(theme === 'system' ? { hint: 'Current' } : {}),
        run: () => setPreference('theme', 'system'),
      },
      // Only where the list can show (wide screens).
      ...(wide
        ? [
            {
              id: 'toggle-conversations',
              group: 'actions' as const,
              icon: PanelLeft,
              label: 'Show or hide the conversation list',
              shortcut: 'toggle-conversations' as const,
              run: () => {
                if (route.view !== 'talk') {
                  // From elsewhere it shows the list, as Ctrl/⌘ B does.
                  setPreference('conversationsOpen', true)
                  navigate({ view: 'talk' })
                } else if (listOpen) {
                  setPreference('conversationsOpen', false)
                  // Focus goes back to what opened the palette, which may have
                  // gone with the list: then to what shows the list again.
                  requestAnimationFrame(() => {
                    if (document.activeElement === document.body)
                      document
                        .querySelector<HTMLElement>('[data-show-conversations]')
                        ?.focus()
                  })
                } else setPreference('conversationsOpen', true)
              },
            },
          ]
        : []),
      {
        id: 'toggle-margin',
        group: 'actions' as const,
        icon: PanelRight,
        label: 'Show or hide the working margin',
        shortcut: 'toggle-margin',
        run: () => {
          if (route.view !== 'talk') navigate({ view: 'talk' })
          queueMicrotask(() => talk.current?.toggleMargin())
        },
      },
      {
        id: 'help',
        group: 'actions' as const,
        icon: Keyboard,
        label: 'Show keyboard shortcuts',
        shortcut: 'help',
        run: () => setHelpOpen(true),
      },
    ],
    [canCreate, theme, listOpen, route.view, wide],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = matchShortcut(event)
      if (!id) return
      event.preventDefault()
      // A key can arrive after a resize but before matchMedia's change event
      // has updated React. Choose a visible surface using the viewport now.
      const wideNow =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(min-width: 1280px)').matches
      switch (id) {
        case 'palette':
          setPaletteOpen(true)
          break
        case 'toggle-conversations':
          if (!wideNow) {
            // No room for the list: the conversation switcher instead, over
            // the conversation already open.
            navigate({
              view: 'talk',
              ...(route.view === 'talk' && route.conversationId
                ? { conversationId: route.conversationId }
                : {}),
            })
            queueMicrotask(() => talk.current?.openHistory())
          } else if (route.view !== 'talk') {
            setListOpen(true)
            navigate({ view: 'talk' })
          } else if (listOpen) hideList()
          else setListOpen(true)
          break
        case 'switch-conversation':
          if (wideNow && showList) {
            list.current?.focusSearch()
            break
          }
          navigate({
            view: 'talk',
            ...(route.view === 'talk' && route.conversationId
              ? { conversationId: route.conversationId }
              : {}),
          })
          queueMicrotask(() => talk.current?.openHistory())
          break
        case 'previous-conversation':
        case 'next-conversation': {
          // In the list's order, stopping at either end (after T3 Code).
          if (route.view !== 'talk') {
            navigate({ view: 'talk' })
            break
          }
          const order = flatten(shelvesOf(conversations))
          const at = order.findIndex((c) => c.id === currentConversation)
          const to = order[id === 'next-conversation' ? at + 1 : at - 1]
          if (at >= 0 && to) navigate({ view: 'talk', conversationId: to.id })
          break
        }
        case 'new-side':
          if (!canCreate) break
          navigate({ view: 'talk' })
          queueMicrotask(() => talk.current?.newSideConversation())
          break
        case 'toggle-margin':
          if (route.view === 'talk') talk.current?.toggleMargin()
          break
        case 'focus-composer':
          talk.current?.focusComposer()
          break
        case 'go-talk':
          navigate({ view: 'talk' })
          break
        case 'go-work':
          navigate({ view: 'work' })
          break
        case 'go-library':
          navigate({ view: 'library', section: 'skills' })
          break
        case 'go-agent':
          navigate({ view: 'agent', section: 'identity' })
          break
        case 'help':
          setHelpOpen(true)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    route,
    canCreate,
    listOpen,
    showList,
    hideList,
    setListOpen,
    conversations,
    currentConversation,
  ])

  return (
    <div className={styles.shell}>
      <div className={styles.banner}>
        {link.demo ? (
          <p className={styles.demoBanner} role="note">
            <TriangleAlert size={14} aria-hidden="true" />
            {SYNTHETIC_DEMO_NOTICE}
          </p>
        ) : null}
      </div>
      <nav className={styles.spine} aria-label="Primary">
        <a className={styles.brand} href="#/talk" aria-label="Cindl, go to Talk">
          <Mark />
        </a>
        <NavList current={current} workCount={open.length} />
        <div className={styles.spineFooter}>
          {/* The status is in the name and the tooltip, not only in the dot's colour. */}
          <a
            className={styles.status}
            href="#/agent/runtime"
            aria-label={`Connection: ${status.label}. Show details`}
            title={`${status.label}. Show connection details`}
          >
            <LinkStatusDot />
          </a>
        </div>
      </nav>
      <main className={styles.main} id="main">
        <Notices />
        <div className={styles.workspace}>
          {showList ? (
            <ErrorBoundary label="the conversation list">
              <ConversationList
                ref={list}
                currentId={currentConversation}
                onHide={hideList}
                onCompose={() => talk.current?.focusComposer()}
              />
            </ErrorBoundary>
          ) : null}
          <div className={styles.view}>
            <ErrorBoundary key={window.location.hash} label="this view">
              {needsSignIn ? (
                <SignIn />
              ) : (
                <>
                  {route.view === 'talk' ? (
                    <TalkView ref={talk} conversationId={route.conversationId} />
                  ) : null}
                  {route.view === 'work' ? <WorkView /> : null}
                  {route.view === 'library' ? (
                    <LibraryView section={route.section} item={route.item} />
                  ) : null}
                  {route.view === 'agent' ? <AgentView section={route.section} /> : null}
                </>
              )}
            </ErrorBoundary>
          </div>
        </div>
      </main>
      <nav className={styles.bottomNav} aria-label="Primary">
        <NavList current={current} workCount={open.length} />
      </nav>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        currentId={currentConversation}
      />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* Says when the list comes and goes, which a screen reader cannot see. */}
      <p className="visually-hidden" role="status">
        {wide ? (listOpen ? 'Conversation list shown' : 'Conversation list hidden') : ''}
      </p>
    </div>
  )
}
