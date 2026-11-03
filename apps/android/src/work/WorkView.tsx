import {
  useCan,
  useCapability,
  useCindlApi,
  useCindlState,
  useConversations,
  useOpenRequests,
} from '@cindl/client-react'
import type { DisplayState, Routine } from '@cindl/contracts'
import { useState } from 'react'
import { View } from 'react-native'
import { useNavigate } from '../nav/NavProvider.tsx'
import { Dialog } from '../overlay/Sheet.tsx'
import {
  CONTROL_UNCERTAIN,
  describeFailure,
  ROUTINE_UNCERTAIN,
} from '../talk/failures.ts'
import { relativeDay } from '../talk/format.ts'
import { RequestCard } from '../talk/RequestCard.tsx'
import { NO_LIVE_PICTURE, TAKE_CONTROL_WARNING } from './screen.ts'
import { requestKeyOf } from '../talk/requests.ts'
import { useTheme } from '../theme/theme.tsx'
import {
  Badge,
  Button,
  Empty,
  ErrorText,
  Facts,
  Note,
  Row,
  Rows,
  Txt,
} from '../ui/primitives.tsx'
import { Page, Section } from '../views/Page.tsx'
import { RequireCapability, unavailableCopy } from '../views/RequireCapability.tsx'
import { useResource } from '../views/useResource.ts'

function Running() {
  const navigate = useNavigate()
  const conversations = useConversations()
  const tools = useCindlState((state) => state.tools)
  // A step in a conversation that waits on the owner is blocked, not running.
  const waitingOn = new Set(useOpenRequests().map((request) => request.conversationId))
  const working = conversations.filter((c) => c.status === 'working')
  const activeTools = Object.values(tools).filter(
    (t) => t.status === 'running' || t.status === 'generating',
  )
  if (!working.length && !activeTools.length)
    return <Empty>Nothing is running in the conversations this device can see.</Empty>
  return (
    <Rows>
      {working.map((c) => (
        <Row
          key={c.id}
          title={c.title}
          detail={c.preview ?? 'Working'}
          aside={<Badge tone="info">Working</Badge>}
          accessibilityLabel={`${c.title}, working. Open conversation`}
          onPress={() => navigate({ type: 'conversation', conversationId: c.id })}
        />
      ))}
      {activeTools.map((t) => (
        <Row
          key={t.id}
          title={t.title}
          detail={t.progress ?? t.name}
          aside={
            waitingOn.has(t.conversationId) ? (
              <Badge tone="warning">Waiting for you</Badge>
            ) : (
              <Badge tone="accent">
                {t.status === 'generating' ? 'Preparing' : 'Running'}
              </Badge>
            )
          }
        />
      ))}
    </Rows>
  )
}

function Routines() {
  const api = useCindlApi()
  const canWrite = useCan('routines.write')
  const writeCapability = useCapability('routines.write')
  const list = useResource(
    () => api.call('routines.list', {}),
    'routines',
    'Routines could not be loaded.',
  )
  const [overrides, setOverrides] = useState<Record<string, Routine>>({})
  const [actionError, setActionError] = useState<string>()
  const [pending, setPending] = useState<Routine>()
  const [busy, setBusy] = useState(false)
  const routines = list.data?.map((routine) => overrides[routine.id] ?? routine)
  if (list.error) return <ErrorText>{list.error}</ErrorText>
  if (!routines) return <Note>Loading routines…</Note>
  if (!routines.length) return <Empty>No routines are scheduled in Hermes.</Empty>
  const confirm = () => {
    const target = pending
    if (!target || busy) return
    setBusy(true)
    setActionError(undefined)
    api
      .call('routines.setEnabled', {
        id: target.id,
        enabled: !target.enabled,
        confirm: true,
      })
      .then(
        (updated) => setOverrides((current) => ({ ...current, [updated.id]: updated })),
        (error: unknown) =>
          setActionError(describeFailure(error, ROUTINE_UNCERTAIN).message),
      )
      .finally(() => {
        setBusy(false)
        setPending(undefined)
      })
  }
  return (
    <>
      <Rows>
        {routines.map((routine) => (
          <Row
            key={routine.id}
            title={routine.name}
            detail={`${routine.schedule}${
              routine.lastRun
                ? ` · last run ${relativeDay(routine.lastRun.at) ?? ''} (${routine.lastRun.status})`
                : ''
            }`}
            aside={
              <>
                <Badge tone={routine.enabled ? 'success' : 'neutral'}>
                  {routine.enabled ? 'Active' : 'Paused'}
                </Badge>
                {canWrite ? (
                  <Button
                    label={routine.enabled ? 'Pause' : 'Resume'}
                    accessibilityLabel={`${routine.enabled ? 'Pause' : 'Resume'} ${routine.name}`}
                    onPress={() => setPending(routine)}
                  />
                ) : null}
              </>
            }
          />
        ))}
      </Rows>
      {!canWrite ? (
        <Note>{`Pausing and resuming is not available: ${unavailableCopy(writeCapability).reason}`}</Note>
      ) : null}
      {actionError ? <ErrorText>{actionError}</ErrorText> : null}
      <Dialog
        open={pending !== undefined}
        title={pending?.enabled ? 'Pause this routine?' : 'Resume this routine?'}
        onCancel={() => {
          if (!busy) setPending(undefined)
        }}
        actions={
          <>
            <Button
              label="Cancel"
              variant="quiet"
              disabled={busy}
              onPress={() => setPending(undefined)}
            />
            <Button
              label={pending?.enabled ? 'Pause routine' : 'Resume routine'}
              variant="primary"
              disabled={busy}
              busy={busy}
              onPress={confirm}
            />
          </>
        }
      >
        <Txt tone="secondary">
          {pending
            ? `${pending.enabled ? 'Pause' : 'Resume'} ${pending.name} on the Hermes host?`
            : ''}
        </Txt>
      </Dialog>
    </>
  )
}

const controllerCopy: Record<DisplayState['controller'], string> = {
  agent: 'Hermes is in control',
  you: 'You are in control on this device',
  'another-viewer': 'Another viewer is in control',
  none: 'No one is in control',
  unknown: 'Control state unknown',
}

function Computer() {
  const api = useCindlApi()
  const theme = useTheme()
  const display = useCindlState((state) => state.display)
  const canControl = useCan('computer.control')
  const controlCapability = useCapability('computer.control')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (!display) return <Note>Screen status not checked yet.</Note>
  const run = (operation: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    operation()
      .catch((failure: unknown) =>
        setError(describeFailure(failure, CONTROL_UNCERTAIN).message),
      )
      .finally(() => setBusy(false))
  }
  return (
    <View style={{ gap: theme.space[3] }}>
      <Facts
        items={[
          {
            label: 'Screen',
            value:
              display.status === 'running'
                ? 'Running'
                : display.status === 'stopped'
                  ? 'Stopped (Cindl never starts it)'
                  : display.status === 'unavailable'
                    ? 'Unavailable'
                    : 'Unknown',
          },
          { label: 'Control', value: controllerCopy[display.controller] },
          {
            label: 'Scope',
            value:
              'The agent-owned Linux screen of this Hermes profile only. Not your other devices.',
          },
        ]}
      />
      <Note>{NO_LIVE_PICTURE}</Note>
      {canControl ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            gap: theme.space[2],
          }}
        >
          {display.leaseHeldByThisDevice ? (
            <Button
              label="Give control back"
              disabled={busy}
              onPress={() => run(() => api.call('display.releaseControl', {}))}
            />
          ) : display.status === 'running' ? (
            <Button
              label="Take control…"
              disabled={busy}
              onPress={() => setConfirming(true)}
            />
          ) : null}
        </View>
      ) : (
        <Note>{`Taking control is not available: ${unavailableCopy(controlCapability).reason}`}</Note>
      )}
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Dialog
        open={confirming}
        title="Take control of the agent's screen?"
        onCancel={() => setConfirming(false)}
        actions={
          <>
            <Button label="Cancel" variant="quiet" onPress={() => setConfirming(false)} />
            <Button
              label="Take control now"
              variant="primary"
              onPress={() => {
                setConfirming(false)
                run(() => api.call('display.acquireControl', { confirm: true }))
              }}
            />
          </>
        }
      >
        <Txt tone="secondary">{TAKE_CONTROL_WARNING}</Txt>
      </Dialog>
    </View>
  )
}

export function WorkView() {
  const requests = useOpenRequests()
  return (
    <Page
      title="Work"
      lead="What Hermes is doing, what it needs from you, and what is scheduled."
    >
      <Section title="Needs you">
        {requests.length ? (
          requests.map((request) => (
            <RequestCard key={requestKeyOf(request)} request={request} />
          ))
        ) : (
          <Empty>Nothing is waiting on you.</Empty>
        )}
        <Note>
          Covers command approvals and questions Hermes asks over this connection. It is
          not a gate on every action Hermes can take.
        </Note>
      </Section>
      <Section title="Running">
        <Running />
      </Section>
      <Section title="Scheduled">
        <RequireCapability id="routines.read" label="Routines">
          <Routines />
        </RequireCapability>
      </Section>
      <Section title="Computer">
        <RequireCapability id="computer.view" label="Agent computer">
          <Computer />
        </RequireCapability>
      </Section>
    </Page>
  )
}
