import {
  useCan,
  useCapability,
  useCindlApi,
  useCindlState,
  useConversations,
  useOpenRequests,
} from '@cindl/client-react'
import type { Routine, ServerRequest } from '@cindl/contracts'
import { useState } from 'react'
import { View } from 'react-native'
import { useDestinationActive, useNavigate } from '../nav/NavProvider.tsx'
import { Dialog } from '../overlay/Sheet.tsx'
import { describeFailure, ROUTINE_UNCERTAIN } from '../talk/failures.ts'
import { routineDetail } from '../talk/format.ts'
import { RequestCard } from '../talk/RequestCard.tsx'
import { useTheme } from '../theme/theme.tsx'
import { requestKeyOf } from '../talk/requests.ts'
import {
  Badge,
  Button,
  Empty,
  ErrorText,
  Note,
  Row,
  Rows,
  Txt,
} from '../ui/primitives.tsx'
import { Page, Section } from '../views/Page.tsx'
import { RequireCapability, unavailableCopy } from '../views/RequireCapability.tsx'
import { useResource } from '../views/useResource.ts'
import { Computer } from './Computer.tsx'

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
            detail={routineDetail(routine)}
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

/**
 * Work stays mounted while hidden. Not shown, its Computer is closed: the
 * screen's view ends and control this device took is given back (Computer).
 * The section keeps the height it last had, so Work's scroll position is not
 * cut short while it is hidden, and Work comes back where it was left
 * (review 4bdfe6c1, S-4).
 */
function ComputerSection() {
  const shown = useDestinationActive()
  const [room, setRoom] = useState(0)
  return shown ? (
    <View onLayout={(event) => setRoom(event.nativeEvent.layout.height)}>
      <Computer />
    </View>
  ) : (
    <View style={{ minHeight: room }} />
  )
}

/** "In Kiln inventory sheet", or for an app-level prompt "Not part of a conversation". */
function provenance(
  request: ServerRequest,
  conversations: ReadonlyArray<{ id: string; title: string }>,
): string {
  if (!request.conversationId) return 'Not part of a conversation'
  const title = conversations.find((c) => c.id === request.conversationId)?.title
  return `In ${title ?? 'its conversation'}`
}

export function WorkView() {
  const theme = useTheme()
  const requests = useOpenRequests()
  const conversations = useConversations()
  return (
    <Page
      title="Work"
      lead="What Hermes is doing, what it needs from you, and what is scheduled."
    >
      <Section title="Needs you">
        {requests.length ? (
          requests.map((request) => (
            // Every conversation's requests are here: each says whose it is (web parity).
            <View key={requestKeyOf(request)} style={{ gap: theme.space[1.5] }}>
              <Note>{provenance(request, conversations)}</Note>
              <RequestCard request={request} />
            </View>
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
          <ComputerSection />
        </RequireCapability>
      </Section>
    </Page>
  )
}
