import { useOpenRequests, useTool } from '@cindl/client-react'
import type { ServerRequest } from '@cindl/contracts'
import { useRef } from 'react'
import {
  AccessibilityInfo,
  ScrollView,
  Text,
  View,
  type HostInstance,
} from 'react-native'
import { giveKeyboardFocus } from '../overlay/keyboardFocus.ts'
import { Sheet } from '../overlay/Sheet.tsx'
import { useTheme } from '../theme/theme.tsx'
import { HelpCircle, KeyRound, ShieldAlert } from '../ui/icons.ts'
import { Button, Facts, SectionTitle, Txt } from '../ui/primitives.tsx'
import { Tabs } from '../views/Page.tsx'
import { RequireCapability } from '../views/RequireCapability.tsx'
import { Computer } from '../work/Computer.tsx'
import { duration } from './format.ts'
import { Notice } from './MessageView.tsx'
import { keepPlace, useMarginTool, useSelectedStep, type MarginTool } from './places.ts'
import { requestKeyOf, requestNoun } from './requests.ts'
import { toolStatusLabel, ToolStatusIcon } from './ToolRow.tsx'

function Evidence({ toolId, blocked }: { toolId: string; blocked: boolean }) {
  const theme = useTheme()
  const tool = useTool(toolId)
  if (!tool) return <Txt tone="tertiary">This step is no longer available.</Txt>
  const took = duration(tool.startedAt, tool.endedAt)
  const block = (value: string) => (
    <View
      style={{
        padding: theme.space[3],
        borderRadius: theme.radius.sm,
        backgroundColor: theme.colors.surfaceSunken,
      }}
    >
      <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
        {value}
      </Text>
    </View>
  )
  return (
    <View style={{ gap: theme.space[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <ToolStatusIcon status={tool.status} blocked={blocked} />
        <Txt weight="semibold" style={{ flex: 1 }}>
          {tool.title}
        </Txt>
      </View>
      <Facts
        items={[
          {
            label: 'Tool',
            value: (
              <Text style={[theme.text.code, { color: theme.colors.text }]}>
                {tool.name}
              </Text>
            ),
          },
          {
            label: 'Status',
            value: blocked
              ? 'Waiting for you'
              : (tool.progress ?? toolStatusLabel[tool.status]),
          },
          ...(took ? [{ label: 'Duration', value: took }] : []),
        ]}
      />
      {tool.argsPreview ? (
        <>
          <SectionTitle>Input (redacted preview)</SectionTitle>
          {block(tool.argsPreview)}
        </>
      ) : null}
      {tool.resultPreview ? (
        <>
          <SectionTitle>Result (redacted preview)</SectionTitle>
          {block(tool.resultPreview)}
        </>
      ) : null}
      {tool.outputRisk ? (
        <Notice
          level="warning"
          text={`Hermes flagged this output: ${tool.outputRisk.reason ?? tool.outputRisk.level}`}
        />
      ) : null}
    </View>
  )
}

/**
 * The working margin, as a sheet over the conversation: the conversation's
 * panel (ADR 0013; web parity: apps/web/src/talk/WorkingMargin.tsx). A few
 * tools for this conversation, switched by a tab row in the sheet's header,
 * by the owner and never by the agent: what it waits on, the selected step's
 * evidence and the agent's computer. Each conversation keeps its tool
 * (places.ts). The actionable cards live in the conversation; the margin only
 * points to them, so a request never shows two sets of decision buttons.
 */
export function WorkingMargin({
  open,
  onClose,
  conversationId,
  blockedToolIds,
  onShowRequest,
}: {
  open: boolean
  onClose: () => void
  conversationId: string
  blockedToolIds: ReadonlySet<string>
  onShowRequest: (requestId: string) => void
}) {
  const theme = useTheme()
  const requests = useOpenRequests(conversationId)
  const selectedToolId = useSelectedStep(conversationId)
  const tool = useMarginTool(conversationId)
  // The chosen tool's tab: focus goes there as the sheet opens.
  const chosen = useRef<HostInstance | null>(null)
  const tools: Array<{ id: MarginTool; label: string }> = [
    // Named by the visible text ("Waiting 2"), so voice control finds it.
    { id: 'waiting', label: requests.length ? `Waiting ${requests.length}` : 'Waiting' },
    { id: 'step', label: 'Step' },
    { id: 'computer', label: 'Computer' },
  ]
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Working margin"
      closeLabel="Close the working margin"
      heading={
        <Tabs
          label="Margin tools"
          items={tools}
          current={tool}
          onSelect={(next) => keepPlace(conversationId, { tool: next })}
          wrap
          selectedRef={chosen}
        />
      }
      initialFocus={() => chosen.current}
    >
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ padding: theme.space[4], gap: theme.space[3] }}
      >
        {tool === 'waiting' ? (
          <Waiting requests={requests} onShowRequest={onShowRequest} />
        ) : tool === 'step' ? (
          selectedToolId ? (
            <>
              <Evidence
                toolId={selectedToolId}
                blocked={blockedToolIds.has(selectedToolId)}
              />
              <Button
                label="Clear the step"
                variant="quiet"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => {
                  keepPlace(conversationId, { toolId: undefined })
                  // The button goes with the step: focus stays on the tool's tab.
                  setTimeout(() => {
                    const tab = chosen.current
                    if (!tab) return
                    AccessibilityInfo.sendAccessibilityEvent(tab, 'focus')
                    giveKeyboardFocus(tab)
                  }, 60)
                }}
              />
            </>
          ) : (
            <Txt tone="tertiary">
              Select a step in the conversation to see what Hermes did.
            </Txt>
          )
        ) : (
          // Its view lives while the tool is shown: another tool, the sheet
          // closed or another conversation closes it (Computer).
          <RequireCapability id="computer.view" label="Agent computer">
            <Computer />
          </RequireCapability>
        )}
      </ScrollView>
    </Sheet>
  )
}

function Waiting({
  requests,
  onShowRequest,
}: {
  requests: ServerRequest[]
  onShowRequest: (requestId: string) => void
}) {
  const theme = useTheme()
  if (!requests.length) return <Txt tone="tertiary">Nothing is waiting on you here.</Txt>
  return (
    <>
      {requests.map((request) => {
        const Icon =
          request.kind === 'approval'
            ? ShieldAlert
            : request.kind === 'clarify'
              ? HelpCircle
              : KeyRound
        return (
          <View
            key={requestKeyOf(request)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}
          >
            <Icon size={15} color={theme.colors.accentText} strokeWidth={1.75} />
            <Txt style={{ flex: 1 }}>{request.title}</Txt>
            <Button
              label="Show"
              accessibilityLabel={`Show ${requestNoun(request)}: ${request.title}`}
              variant="quiet"
              onPress={() => onShowRequest(request.requestId)}
            />
          </View>
        )
      })}
    </>
  )
}
