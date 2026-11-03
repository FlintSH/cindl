import type { List, PhrasingContent, RootContent, Table } from 'mdast'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Linking, ScrollView, Text, View, type TextStyle } from 'react-native'
import { Dialog } from '../overlay/Sheet.tsx'
import { useTheme, type CindlTheme } from '../theme/theme.tsx'
import { Button, Txt } from '../ui/primitives.tsx'
import {
  blockedImage,
  collectDefinitions,
  linkConfirmation,
  linkDestinationLabel,
  linkTarget,
  MAX_MARKDOWN_DEPTH,
  parseMarkdown,
  plainText,
  tableColumnWidths,
  type Definitions,
  type ExternalLink,
} from './model.ts'

interface Context {
  theme: CindlTheme
  definitions: Definitions
  muted: boolean
  /** Nesting level; at MAX_MARKDOWN_DEPTH the rest renders as plain text. */
  depth: number
  openLink: (target: ExternalLink) => void
}

const deeper = (context: Context, muted = context.muted): Context => ({
  ...context,
  muted,
  depth: context.depth + 1,
})

/**
 * Native rendering of agent Markdown (see model.ts for the safety rules):
 * no WebView, no raw HTML, no images, and every link shows its destination
 * host next to its text and asks before leaving the app.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const theme = useTheme()
  const root = useMemo(() => parseMarkdown(text), [text])
  const definitions = useMemo(() => collectDefinitions(root), [root])
  const [pending, setPending] = useState<ExternalLink>()
  const [openError, setOpenError] = useState<string>()
  const context: Context = {
    theme,
    definitions,
    muted: false,
    depth: 0,
    openLink: setPending,
  }
  const confirmation = pending ? linkConfirmation(pending) : undefined
  const close = () => {
    setPending(undefined)
    setOpenError(undefined)
  }
  return (
    <View style={{ gap: theme.space[3] }}>
      {renderBlocks(root.children, context)}
      <Dialog
        open={pending !== undefined}
        title={confirmation?.title ?? ''}
        onCancel={close}
        actions={
          <>
            <Button label="Cancel" variant="quiet" onPress={close} />
            <Button
              label="Open in browser"
              variant="primary"
              onPress={() => {
                if (!pending) return
                Linking.openURL(pending.url).then(close, () =>
                  setOpenError('No app on this device can open this link.'),
                )
              }}
            />
          </>
        }
      >
        {confirmation ? (
          <View style={{ gap: theme.space[2] }}>
            <Txt tone="secondary">{confirmation.lead}</Txt>
            <Txt variant="code" selectable>
              {confirmation.url}
            </Txt>
            {openError ? <Txt tone="danger">{openError}</Txt> : null}
          </View>
        ) : null}
      </Dialog>
    </View>
  )
})

function bodyStyle(context: Context): TextStyle {
  const { theme, muted } = context
  return {
    ...theme.text.body,
    color: muted ? theme.colors.textSecondary : theme.colors.text,
  }
}

function renderBlocks(nodes: readonly RootContent[], context: Context): ReactNode[] {
  return nodes.map((node, index) => <Block key={index} node={node} context={context} />)
}

function Block({ node, context }: { node: RootContent; context: Context }): ReactNode {
  const { theme } = context
  if (context.depth >= MAX_MARKDOWN_DEPTH && 'children' in node)
    return (
      <Text selectable style={bodyStyle(context)}>
        {plainText(node)}
      </Text>
    )
  switch (node.type) {
    case 'paragraph':
      return <Paragraph nodes={node.children} context={context} />
    case 'heading':
      return (
        <Text
          accessibilityRole="header"
          style={[
            node.depth <= 3 ? theme.text.title : theme.text.body,
            {
              fontFamily: theme.fonts.semibold,
              color: theme.colors.text,
              marginTop: theme.space[2],
            },
          ]}
        >
          {renderInlines(node.children, context)}
        </Text>
      )
    case 'blockquote':
      return (
        <View
          style={{
            gap: theme.space[3],
            paddingLeft: theme.space[3],
            borderLeftWidth: 3,
            borderLeftColor: theme.colors.border,
          }}
        >
          {renderBlocks(node.children, deeper(context, true))}
        </View>
      )
    case 'list':
      return <ListBlock node={node} context={context} />
    case 'code':
      return (
        <View
          style={{
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <ScrollView horizontal contentContainerStyle={{ padding: theme.space[3] }}>
            <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
              {node.value}
            </Text>
          </ScrollView>
        </View>
      )
    case 'table':
      return <TableBlock node={node} context={context} />
    case 'thematicBreak':
      return <View style={{ height: 1, backgroundColor: theme.colors.border }} />
    case 'footnoteDefinition':
      return (
        <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
          <Txt
            variant="label"
            tone="tertiary"
          >{`[${node.label ?? node.identifier}]`}</Txt>
          <View style={{ flex: 1, gap: theme.space[2] }}>
            {renderBlocks(node.children, deeper(context, true))}
          </View>
        </View>
      )
    // Raw HTML is never rendered; definitions are resolved where they are used.
    case 'html':
    case 'definition':
      return null
    default:
      return null
  }
}

function Paragraph({
  nodes,
  context,
}: {
  nodes: readonly PhrasingContent[]
  context: Context
}) {
  return (
    <Text selectable style={bodyStyle(context)}>
      {renderInlines(nodes, context)}
    </Text>
  )
}

function renderInlines(nodes: readonly PhrasingContent[], context: Context): ReactNode[] {
  return nodes.map((node, index) => <Inline key={index} node={node} context={context} />)
}

function Inline({
  node,
  context,
}: {
  node: PhrasingContent
  context: Context
}): ReactNode {
  const { theme } = context
  if (context.depth >= MAX_MARKDOWN_DEPTH && 'children' in node) return plainText(node)
  const inner = deeper(context)
  switch (node.type) {
    case 'text':
      return node.value
    case 'break':
      return '\n'
    case 'emphasis':
      return (
        <Text style={{ fontFamily: theme.fonts.italic }}>
          {renderInlines(node.children, inner)}
        </Text>
      )
    case 'strong':
      return (
        <Text style={{ fontFamily: theme.fonts.semibold }}>
          {renderInlines(node.children, inner)}
        </Text>
      )
    case 'delete':
      return (
        <Text style={{ textDecorationLine: 'line-through' }}>
          {renderInlines(node.children, inner)}
        </Text>
      )
    case 'inlineCode':
      return (
        <Text
          style={{
            fontFamily: theme.fonts.mono,
            fontSize: theme.text.body.fontSize - 2,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          {` ${node.value} `}
        </Text>
      )
    case 'link':
      return <LinkSpan url={node.url} label={node.children} context={context} />
    case 'linkReference': {
      const definition = context.definitions.get(node.identifier)
      return definition ? (
        <LinkSpan url={definition.url} label={node.children} context={context} />
      ) : (
        renderInlines(node.children, context)
      )
    }
    case 'image':
      return <BlockedImageSpan url={node.url} alt={node.alt} context={context} />
    case 'imageReference':
      return (
        <BlockedImageSpan
          url={context.definitions.get(node.identifier)?.url}
          alt={node.alt}
          context={context}
        />
      )
    case 'footnoteReference':
      return (
        <Text
          style={{ color: theme.colors.textTertiary }}
        >{`[${node.label ?? node.identifier}]`}</Text>
      )
    // Inline raw HTML is dropped, as on web.
    case 'html':
      return null
    default:
      return null
  }
}

function LinkSpan({
  url,
  label,
  context,
}: {
  url: string
  label: readonly PhrasingContent[]
  context: Context
}) {
  const { theme } = context
  const target = linkTarget(url)
  const content = renderInlines(label, context)
  if (target.kind === 'inert')
    return (
      <Text style={{ textDecorationLine: 'underline', textDecorationStyle: 'dotted' }}>
        {content}
      </Text>
    )
  return (
    <Text>
      <Text
        accessibilityRole="link"
        onPress={() => context.openLink(target)}
        style={{ color: theme.colors.accentText, textDecorationLine: 'underline' }}
      >
        {content}
      </Text>
      <Text
        style={{ color: theme.colors.textTertiary }}
      >{` (${linkDestinationLabel(target)})`}</Text>
    </Text>
  )
}

function BlockedImageSpan({
  url,
  alt,
  context,
}: {
  url: string | undefined
  alt: string | null | undefined
  context: Context
}) {
  const { theme } = context
  const copy = blockedImage(url, alt)
  return (
    <Text
      accessibilityLabel={copy.label}
      style={{ color: theme.colors.textSecondary, fontFamily: theme.fonts.italic }}
    >
      {copy.text}
    </Text>
  )
}

function ListBlock({ node, context }: { node: List; context: Context }) {
  const { theme } = context
  const start = node.start ?? 1
  return (
    <View style={{ gap: theme.space[1] }}>
      {node.children.map((item, index) => {
        const marker =
          item.checked === true
            ? '☑'
            : item.checked === false
              ? '☐'
              : node.ordered
                ? `${start + index}.`
                : '•'
        const markerLabel =
          item.checked === true ? 'Done' : item.checked === false ? 'Not done' : undefined
        return (
          <View key={index} style={{ flexDirection: 'row', gap: theme.space[2] }}>
            <Text
              {...(markerLabel
                ? { accessibilityLabel: markerLabel }
                : node.ordered
                  ? {}
                  : { accessible: false, importantForAccessibility: 'no' as const })}
              style={[bodyStyle(context), { minWidth: node.ordered ? 22 : 12 }]}
            >
              {marker}
            </Text>
            <View style={{ flex: 1, gap: theme.space[1] }}>
              {renderBlocks(item.children, deeper(context))}
            </View>
          </View>
        )
      })}
    </View>
  )
}

function TableBlock({ node, context }: { node: Table; context: Context }) {
  const { theme } = context
  const widths = tableColumnWidths(node)
  return (
    <ScrollView horizontal>
      <View>
        {node.children.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={{
              flexDirection: 'row',
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          >
            {row.children.map((cell, cellIndex) => {
              const align = node.align?.[cellIndex]
              return (
                <View
                  key={cellIndex}
                  style={{
                    width: widths[cellIndex] ?? 120,
                    paddingVertical: theme.space[1],
                    paddingHorizontal: theme.space[3],
                  }}
                >
                  <Text
                    selectable
                    style={[
                      theme.text.ui,
                      {
                        color: theme.colors.text,
                        fontFamily:
                          rowIndex === 0 ? theme.fonts.semibold : theme.fonts.regular,
                        textAlign:
                          align === 'right'
                            ? 'right'
                            : align === 'center'
                              ? 'center'
                              : 'left',
                      },
                    ]}
                  >
                    {renderInlines(cell.children, context)}
                  </Text>
                </View>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}
