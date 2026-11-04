import { useCan, useLink, useOpenRequests } from '@cindl/client-react'
import { SYNTHETIC_DEMO_LABEL, SYNTHETIC_DEMO_NOTICE } from '@cindl/contracts'
import { TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentView } from '../agent/AgentView.tsx'
import { LibraryView } from '../library/LibraryView.tsx'
import { applyTheme, setPreference, usePreference } from '../platform/preferences.ts'
import { navigate, useRoute, type Destination } from '../router.ts'
import { matchShortcut } from '../shortcuts.ts'
import { TalkView, type TalkHandle } from '../talk/TalkView.tsx'
import { Mark } from '../ui/Mark.tsx'
import { WorkView } from '../work/WorkView.tsx'
import { CommandPalette, type Command } from './CommandPalette.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { pruneRequestDrafts } from '../talk/RequestCard.tsx'
import { forgetDocumentDrafts } from '../views/DocumentEditor.tsx'
import { Notices } from './Notices.tsx'
import { SignIn } from './SignIn.tsx'
import { forgetSignOut } from './signOut.ts'
import { LinkStatusDot } from './LinkStatus.tsx'
import { NavList } from './Navigation.tsx'
import { ShortcutsDialog } from './ShortcutsDialog.tsx'
import styles from './shell.module.css'

export function AppShell() {
  const route = useRoute()
  const link = useLink()
  const open = useOpenRequests()
  const canCreate = useCan('sessions.create')
  // Native clients without a session sign in first; the demo never needs to.
  const needsSignIn =
    !link.demo && (link.phase === 'unconfigured' || link.phase === 'signed-out')
  const [theme] = usePreference('theme')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const talk = useRef<TalkHandle>(null)
  const current: Destination = route.view

  useEffect(() => applyTheme(theme), [theme])
  // Drafts belong to open requests only.
  useEffect(() => pruneRequestDrafts(new Set(open.map((r) => r.requestId))), [open])
  // Nothing typed on this device outlives the session, however it ended: the
  // sign-out button, or Hermes refusing the session. Kept document drafts go
  // too, so none returns after another sign-in, to this Hermes or another.
  useEffect(() => {
    if (!link.demo && link.phase === 'signed-out') forgetDocumentDrafts()
  }, [link.demo, link.phase])
  // Online again, an earlier sign-out Hermes did not confirm no longer applies.
  useEffect(() => {
    if (link.phase === 'online') forgetSignOut()
  }, [link.phase])
  useEffect(() => {
    document.title = link.demo ? `Cindl (${SYNTHETIC_DEMO_LABEL.toLowerCase()})` : 'Cindl'
  }, [link.demo])

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'go-talk',
        label: 'Go to Talk',
        shortcut: 'go-talk',
        run: () => navigate({ view: 'talk' }),
      },
      {
        id: 'go-work',
        label: 'Go to Work',
        hint: 'Approvals, running work, routines, computer',
        shortcut: 'go-work',
        run: () => navigate({ view: 'work' }),
      },
      {
        id: 'go-library',
        label: 'Go to Library',
        hint: 'Skills, memory, artifacts',
        shortcut: 'go-library',
        run: () => navigate({ view: 'library', section: 'skills' }),
      },
      {
        id: 'go-agent',
        label: 'Go to Agent',
        hint: 'Identity, connections, runtime',
        shortcut: 'go-agent',
        run: () => navigate({ view: 'agent', section: 'identity' }),
      },
      ...(canCreate
        ? [
            {
              id: 'new-side',
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
        label: 'Open identity (SOUL.md)',
        run: () => navigate({ view: 'agent', section: 'identity' }),
      },
      {
        id: 'runtime',
        label: 'Show connection and capabilities',
        run: () => navigate({ view: 'agent', section: 'runtime' }),
      },
      {
        id: 'theme-light',
        label: 'Use light theme',
        run: () => setPreference('theme', 'light'),
      },
      {
        id: 'theme-dark',
        label: 'Use dark theme',
        run: () => setPreference('theme', 'dark'),
      },
      {
        id: 'theme-system',
        label: 'Match system theme',
        run: () => setPreference('theme', 'system'),
      },
      {
        id: 'help',
        label: 'Show keyboard shortcuts',
        shortcut: 'help',
        run: () => setHelpOpen(true),
      },
    ],
    [canCreate],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = matchShortcut(event)
      if (!id) return
      event.preventDefault()
      switch (id) {
        case 'palette':
          setPaletteOpen(true)
          break
        case 'switch-conversation':
          navigate({
            view: 'talk',
            ...(route.view === 'talk' && route.conversationId
              ? { conversationId: route.conversationId }
              : {}),
          })
          queueMicrotask(() => talk.current?.openHistory())
          break
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
  }, [route, canCreate])

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
          <a
            className={styles.status}
            href="#/agent/runtime"
            aria-label="Connection details"
          >
            <LinkStatusDot />
          </a>
        </div>
      </nav>
      <main className={styles.main} id="main">
        <Notices />
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
      </main>
      <nav className={styles.bottomNav} aria-label="Primary">
        <NavList current={current} workCount={open.length} />
      </nav>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
