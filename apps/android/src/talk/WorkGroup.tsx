import { entry } from '@cindl/client-core'
import { useCindlState } from '@cindl/client-react'
import type { ToolStatus } from '@cindl/contracts'
import { useMemo, useReducer, useState } from 'react'
import { Text, View } from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import { ChevronDown, ChevronRight } from '../ui/icons.ts'
import { focusRing, Press } from '../ui/primitives.tsx'
import { ToolRow, ToolStatusIcon } from './ToolRow.tsx'
import { groupChoice, startsOpen, summarize, type StepFacts } from './workGroups.ts'

/** The group's steps as plain facts, selected as one string so the snapshot stays stable. */
function useStepFacts(
  toolIds: readonly string[],
  blocked: ReadonlySet<string>,
): StepFacts[] {
  const key = useCindlState((state) =>
    toolIds
      .map((id) => {
        const tool = entry(state.tools, id)
        return tool
          ? `${tool.status}|${tool.startedAt ?? ''}|${tool.endedAt ?? ''}`
          : 'missing||'
      })
      .join(','),
  )
  return useMemo(
    () =>
      key.split(',').map((row, index) => {
        const [status = 'missing', startedAt, endedAt] = row.split('|')
        return {
          status: status as ToolStatus | 'missing',
          startedAt: startedAt || undefined,
          endedAt: endedAt || undefined,
          blocked: blocked.has(toolIds[index] ?? ''),
        }
      }),
    [key, blocked, toolIds],
  )
}

/**
 * Consecutive steps as one work log (web parity, after T3 Code): a 48dp row
 * that says how many steps and how long they took, opening into the steps.
 * It stays open while Hermes works, waits on the owner or has a failure, and
 * while one of its steps is selected; the owner's own choice wins.
 */
export function WorkGroup({
  groupKey,
  toolIds,
  selectedToolId,
  blockedToolIds,
  onSelectTool,
}: {
  groupKey: string
  toolIds: readonly string[]
  selectedToolId: string | undefined
  blockedToolIds: ReadonlySet<string>
  onSelectTool: (toolId: string) => void
}) {
  const theme = useTheme()
  const facts = useStepFacts(toolIds, blockedToolIds)
  const summary = summarize(facts)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [focused, setFocused] = useState(false)
  const holdsSelection = selectedToolId !== undefined && toolIds.includes(selectedToolId)
  const open = holdsSelection || (groupChoice.get(groupKey) ?? startsOpen(summary))
  const status: ToolStatus =
    summary.blocked > 0 || summary.live > 0
      ? 'running'
      : summary.failed > 0
        ? 'error'
        : 'complete'
  const meta =
    summary.took ?? (summary.blocked ? 'Waiting for you' : summary.live ? 'Working' : '')
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ gap: theme.space[0.5] }}>
      <Press
        accessibilityRole="button"
        accessibilityLabel={`${summary.label}${meta ? `, ${meta}` : ''}. ${
          open ? 'Hide the steps' : 'Show the steps'
        }.`}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          groupChoice.set(groupKey, !open)
          rerender()
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        android_ripple={{ color: theme.colors.selection }}
        style={[
          {
            minHeight: theme.layout.touchTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[2],
            paddingHorizontal: theme.space[2],
            paddingVertical: theme.space[1],
            borderRadius: theme.radius.md,
          },
          focused ? focusRing(theme) : null,
        ]}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: theme.radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <ToolStatusIcon status={status} blocked={summary.blocked > 0} />
        </View>
        <Text
          numberOfLines={1}
          style={[theme.text.ui, { flex: 1, color: theme.colors.textSecondary }]}
        >
          {summary.label}
        </Text>
        {meta ? (
          <Text style={[theme.text.label, { color: theme.colors.textTertiary }]}>
            {meta}
          </Text>
        ) : null}
        <Chevron size={14} color={theme.colors.textTertiary} strokeWidth={1.75} />
      </Press>
      {open ? (
        <View
          style={{
            gap: theme.space[0.5],
            marginLeft: theme.space[2] + 10,
            paddingLeft: theme.space[2],
            borderLeftWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          {toolIds.map((toolId) => (
            <ToolRow
              key={toolId}
              toolId={toolId}
              selected={selectedToolId === toolId}
              blocked={blockedToolIds.has(toolId)}
              onSelect={onSelectTool}
            />
          ))}
        </View>
      ) : null}
    </View>
  )
}
