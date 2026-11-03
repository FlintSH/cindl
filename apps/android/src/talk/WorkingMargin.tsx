import { useOpenRequests, useTool } from '@cindl/client-react'
import { ScrollView, Text, View } from 'react-native'
import { Sheet } from '../overlay/Sheet.tsx'
import { useTheme } from '../theme/theme.tsx'
import { HelpCircle, ShieldAlert } from '../ui/icons.ts'
import { Button, Facts, SectionTitle, Txt } from '../ui/primitives.tsx'
import { duration } from './format.ts'
import { Notice } from './MessageView.tsx'
import { requestKeyOf } from './requests.ts'
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
 * The contextual working margin as a bottom sheet: the step the owner
 * selected, or what this conversation is waiting on. Decision cards live in
 * the conversation only; the margin points to them, so a request never shows
 * two sets of decision buttons.
 */
export function WorkingMargin({
  open,
  onClose,
  conversationId,
  selectedToolId,
  blockedToolIds,
  onClearSelection,
  onShowRequest,
}: {
  open: boolean
  onClose: () => void
  conversationId: string
  selectedToolId: string | undefined
  blockedToolIds: ReadonlySet<string>
  onClearSelection: () => void
  onShowRequest: (requestId: string) => void
}) {
  const theme = useTheme()
  const requests = useOpenRequests(conversationId)
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={selectedToolId ? 'Step details' : 'Waiting on you'}
      closeLabel="Close the working margin"
      headerAside={
        selectedToolId ? (
          <Button label="Back" variant="quiet" onPress={onClearSelection} />
        ) : null
      }
    >
      <ScrollView
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ padding: theme.space[4], gap: theme.space[3] }}
      >
        {selectedToolId ? (
          <Evidence
            toolId={selectedToolId}
            blocked={blockedToolIds.has(selectedToolId)}
          />
        ) : requests.length ? (
          requests.map((request) => {
            const Icon = request.kind === 'approval' ? ShieldAlert : HelpCircle
            const kind = request.kind === 'approval' ? 'approval' : 'question'
            return (
              <View
                key={requestKeyOf(request)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.space[2],
                }}
              >
                <Icon size={15} color={theme.colors.accentText} strokeWidth={1.75} />
                <Txt style={{ flex: 1 }}>{request.title}</Txt>
                <Button
                  label="Show"
                  accessibilityLabel={`Show ${kind}: ${request.title}`}
                  variant="quiet"
                  onPress={() => onShowRequest(request.requestId)}
                />
              </View>
            )
          })
        ) : (
          <Txt tone="tertiary">
            Nothing is waiting on you here. Select a step to see what Hermes did.
          </Txt>
        )}
      </ScrollView>
    </Sheet>
  )
}
