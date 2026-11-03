import {
  useCan,
  useCindlApi,
  useCindlState,
  useConversations,
  useOpenRequests,
} from '@cindl/client-react'
import { isCindlError, type Routine } from '@cindl/contracts'
import { useState } from 'react'
import { RequestCard } from '../talk/RequestCard.tsx'
import { relativeDay } from '../talk/format.ts'
import { Badge, Button, SectionTitle } from '../ui/primitives.tsx'
import { RequireCapability } from '../views/Capability.tsx'
import { useResource } from '../views/useResource.ts'
import styles from '../views/views.module.css'

function Running() {
  const conversations = useConversations()
  const running = useCindlState((state) => state.tools)
  const working = conversations.filter((c) => c.status === 'working')
  const activeTools = Object.values(running).filter(
    (t) => t.status === 'running' || t.status === 'generating',
  )
  // A step in a conversation that waits on the owner is blocked, not running.
  const waitingOn = new Set(useOpenRequests().map((r) => r.conversationId))
  if (!working.length && !activeTools.length)
    return (
      <p className={styles.empty}>
        Nothing is running in the conversations this device can see.
      </p>
    )
  return (
    <ul className={styles.rows}>
      {working.map((c) => (
        <li key={c.id}>
          <a
            className={`${styles.row} ${styles.rowLink}`}
            href={`#/talk/${encodeURIComponent(c.id)}`}
          >
            <span className={styles.rowTitle}>{c.title}</span>
            <span className={styles.rowDetail}>{c.preview ?? 'Working'}</span>
            <span className={styles.rowAside}>
              <Badge tone="info">Working</Badge>
            </span>
          </a>
        </li>
      ))}
      {activeTools.map((t) => (
        <li key={t.id} className={styles.row}>
          <span className={styles.rowTitle}>{t.title}</span>
          <span className={styles.rowDetail}>{t.progress ?? t.name}</span>
          <span className={styles.rowAside}>
            {waitingOn.has(t.conversationId) ? (
              <Badge tone="warning">Waiting for you</Badge>
            ) : (
              <Badge tone="accent">
                {t.status === 'generating' ? 'Preparing' : 'Running'}
              </Badge>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Routines() {
  const api = useCindlApi()
  const canWrite = useCan('routines.write')
  const list = useResource(
    () => api.call('routines.list', {}),
    'routines',
    'Routines could not be loaded.',
  )
  const [overrides, setOverrides] = useState<Record<string, Routine>>({})
  const [actionError, setActionError] = useState<string>()
  const [pending, setPending] = useState<Routine>()
  // Routine ids come from Hermes; only own keys count as overrides.
  const routines = list.data?.map((routine) =>
    Object.hasOwn(overrides, routine.id) ? (overrides[routine.id] ?? routine) : routine,
  )
  const error = list.error ?? actionError
  if (error) return <p className={styles.error}>{error}</p>
  if (!routines) return <p className={styles.note}>Loading routines…</p>
  if (!routines.length)
    return <p className={styles.empty}>No routines are scheduled in Hermes.</p>
  return (
    <>
      <ul className={styles.rows}>
        {routines.map((routine) => (
          <li key={routine.id} className={styles.row}>
            <span className={styles.rowTitle}>{routine.name}</span>
            <span className={styles.rowDetail}>
              {routine.schedule}
              {routine.lastRun
                ? ` · last run ${relativeDay(routine.lastRun.at)} (${routine.lastRun.status})`
                : ''}
            </span>
            <span className={styles.rowAside}>
              <Badge tone={routine.enabled ? 'success' : 'neutral'}>
                {routine.enabled ? 'Active' : 'Paused'}
              </Badge>
              {canWrite ? (
                <Button onClick={() => setPending(routine)}>
                  {routine.enabled ? 'Pause' : 'Resume'}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {pending ? (
        <div
          className={styles.unsupported}
          role="alertdialog"
          aria-label="Confirm routine change"
        >
          <p>
            {pending.enabled ? 'Pause' : 'Resume'} <strong>{pending.name}</strong> on the
            Hermes host?
          </p>
          <div className={styles.actions}>
            <Button variant="quiet" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const target = pending
                setPending(undefined)
                api
                  .call('routines.setEnabled', {
                    id: target.id,
                    enabled: !target.enabled,
                    confirm: true,
                  })
                  .then(
                    (updated) =>
                      setOverrides((current) => ({ ...current, [updated.id]: updated })),
                    (err: unknown) =>
                      setActionError(
                        isCindlError(err) ? err.message : 'The routine was not changed.',
                      ),
                  )
              }}
            >
              {pending.enabled ? 'Pause routine' : 'Resume routine'}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function Computer() {
  const api = useCindlApi()
  const [controlError, setControlError] = useState<string>()
  const controlCall = async (call: () => Promise<unknown>) => {
    setControlError(undefined)
    try {
      await call()
    } catch (err) {
      setControlError(
        isCindlError(err)
          ? err.message
          : 'Cindl could not confirm the change. Check the screen state before trying again.',
      )
    }
  }
  const canControl = useCan('computer.control')
  const display = useCindlState((state) => state.display)
  const [confirming, setConfirming] = useState(false)
  if (!display) return <p className={styles.note}>Screen status not checked yet.</p>
  const controllerCopy = {
    agent: 'Hermes is in control',
    you: 'You are in control on this device',
    'another-viewer': 'Another viewer is in control',
    none: 'No one is in control',
    unknown: 'Control state unknown',
  }[display.controller]
  return (
    <div className={styles.section}>
      <dl className={styles.facts}>
        <dt>Screen</dt>
        <dd>
          {display.status === 'running'
            ? 'Running'
            : display.status === 'stopped'
              ? 'Stopped (Cindl never starts it)'
              : display.status}
        </dd>
        <dt>Control</dt>
        <dd>{controllerCopy}</dd>
        <dt>Scope</dt>
        <dd>
          The agent-owned Linux screen of this Hermes profile only. Not your other
          devices.
        </dd>
      </dl>
      <div className={styles.actions}>
        {display.leaseHeldByThisDevice ? (
          <Button
            onClick={() => void controlCall(() => api.call('display.releaseControl', {}))}
          >
            Give control back
          </Button>
        ) : display.status === 'running' && canControl ? (
          confirming ? (
            <>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirming(false)
                  void controlCall(() =>
                    api.call('display.acquireControl', { confirm: true }),
                  )
                }}
              >
                Take control now
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)}>Take control…</Button>
          )
        ) : null}
      </div>
      {controlError ? (
        <p className={styles.error} role="alert">
          {controlError}
        </p>
      ) : null}
      {confirming ? (
        <p className={styles.note}>
          Taking control pauses Hermes's input on its screen and evicts any other
          controller. Your keystrokes go to the agent's computer.
        </p>
      ) : null}
    </div>
  )
}

export function WorkView() {
  const requests = useOpenRequests()
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Work</h1>
          <p className={styles.pageLead}>
            What Hermes is doing, what it needs from you, and what is scheduled.
          </p>
        </header>
        <section className={styles.section} aria-labelledby="needs-you">
          <div className={styles.sectionHead}>
            <SectionTitle id="needs-you">Needs you</SectionTitle>
          </div>
          {requests.length ? (
            requests.map((r) => <RequestCard key={r.requestId} request={r} />)
          ) : (
            <p className={styles.empty}>Nothing is waiting on you.</p>
          )}
          <p className={styles.note}>
            Covers command approvals and questions Hermes asks Cindl, and prompts it is
            waiting on elsewhere that Cindl can only show. It is not a gate on every
            action Hermes can take.
          </p>
        </section>
        <section className={styles.section} aria-labelledby="running">
          <SectionTitle id="running">Running</SectionTitle>
          <Running />
        </section>
        <section className={styles.section} aria-labelledby="scheduled">
          <SectionTitle id="scheduled">Scheduled</SectionTitle>
          <RequireCapability id="routines.read" label="Routines">
            <Routines />
          </RequireCapability>
        </section>
        <section className={styles.section} aria-labelledby="computer">
          <SectionTitle id="computer">Computer</SectionTitle>
          <RequireCapability id="computer.view" label="Agent computer">
            <Computer />
          </RequireCapability>
        </section>
      </div>
    </div>
  )
}
