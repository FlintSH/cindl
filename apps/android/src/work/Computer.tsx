import { useCan, useCapability, useCindlApi, useCindlState } from '@cindl/client-react'
import type { DisplayState } from '@cindl/contracts'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { Dialog } from '../overlay/Sheet.tsx'
import { CONTROL_UNCERTAIN, describeFailure } from '../talk/failures.ts'
import { useTheme } from '../theme/theme.tsx'
import { Button, ErrorText, Facts, Note, Txt } from '../ui/primitives.tsx'
import { unavailableCopy } from '../views/RequireCapability.tsx'
import { TAKE_CONTROL_WARNING } from './screen.ts'
import { ScreenView } from './ScreenView.tsx'

const controllerCopy: Record<DisplayState['controller'], string> = {
  agent: 'Hermes is in control',
  you: 'You are in control on this device',
  'another-viewer': 'Another viewer is in control',
  none: 'No one is in control',
  unknown: 'Control state unknown',
}

/**
 * The agent's screen and its control: on Work, and in a conversation's working
 * margin (ADR 0013; web parity: apps/web/src/work/WorkView.tsx Computer). Its
 * view lives as long as this does. Leaving it (another tool, the margin
 * closed, Work no longer shown) closes the view and gives control back if this
 * device took it here, even while "Take control now" was still on its way:
 * Hermes's input is never paused behind a screen nobody here watches.
 */
export function Computer() {
  const api = useCindlApi()
  const theme = useTheme()
  const display = useCindlState((state) => state.display)
  const canControl = useCan('computer.control')
  const controlCapability = useCapability('computer.control')
  // `limited` means state and lease only: the live picture needs `available`.
  const view = useCapability('computer.view')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const holding = useRef(false)
  const left = useRef(false)
  useEffect(() => {
    holding.current = display?.leaseHeldByThisDevice === true
  })
  useEffect(
    () => () => {
      left.current = true
      if (holding.current)
        void api.call('display.releaseControl', {}).catch(() => undefined)
    },
    [api],
  )
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
      {display.status === 'running' && view?.state === 'available' ? (
        <ScreenView controlling={display.leaseHeldByThisDevice} />
      ) : view?.state === 'limited' && view.reason ? (
        <Note>{view.reason}</Note>
      ) : null}
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
                run(async () => {
                  await api.call('display.acquireControl', { confirm: true })
                  // Left while it was on its way: give it straight back.
                  if (left.current) await api.call('display.releaseControl', {})
                })
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
