import { useCapability, useCindlApi } from '@cindl/client-react'
import {
  capabilityUsable,
  type ClarifyQuestion,
  type RequestAnswer,
  type ServerRequest,
} from '@cindl/contracts'
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  AccessibilityInfo,
  Pressable,
  Text,
  TextInput,
  View,
  type HostInstance,
} from 'react-native'
import { useTheme } from '../theme/theme.tsx'
import {
  Check,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  KeyRound,
  ShieldAlert,
  type LucideIcon,
} from '../ui/icons.ts'
import { Button, focusRing, Note, Txt } from '../ui/primitives.tsx'
import { unavailableCopy } from '../views/RequireCapability.tsx'
import { ANSWER_REFUSED, ANSWER_UNCERTAIN, describeFailure } from './failures.ts'
import {
  answerOnce,
  buildClarifyAnswer,
  chooseOther,
  clarifyDraftStore,
  describeResponse,
  draftFor,
  isQuickQuestion,
  pickChoice,
  sendAnswer,
  setSkipped,
  skipAllAnswer,
  splitQuestions,
  typeAnswer,
  unsupportedCopy,
  withDraft,
  type ClarifyDrafts,
  type QuestionDraft,
} from './requests.ts'

/**
 * One card per open request (web parity: apps/web/src/talk/RequestCard.tsx).
 * Prompts Cindl never answers (sudo, secret, vault, unknown) get a read-only
 * card; approvals and questions get a decision card.
 */
export function RequestCard({
  request,
  focusRequested = false,
  onFocused,
}: {
  request: ServerRequest
  /** Move TalkBack focus to this card's title (from the working margin's Show). */
  focusRequested?: boolean
  onFocused?: () => void
}) {
  const titleRef = useRef<HostInstance>(null)
  useEffect(() => {
    if (!focusRequested) return
    const timer = setTimeout(() => {
      if (titleRef.current)
        AccessibilityInfo.sendAccessibilityEvent(titleRef.current, 'focus')
      onFocused?.()
    }, 250)
    return () => clearTimeout(timer)
  }, [focusRequested, onFocused])
  return request.kind === 'unsupported' ? (
    <UnsupportedCard request={request} titleRef={titleRef} />
  ) : (
    <DecisionCard request={request} titleRef={titleRef} />
  )
}

type TitleRef = RefObject<HostInstance | null>

function CardFrame({ children }: { children: ReactNode }) {
  const theme = useTheme()
  return (
    <View
      style={{
        gap: theme.space[3],
        padding: theme.space[4],
        borderWidth: 1,
        borderLeftWidth: 3,
        borderColor: theme.colors.borderStrong,
        borderLeftColor: theme.colors.accent,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceRaised,
        boxShadow: theme.shadow.raised,
      }}
    >
      {children}
    </View>
  )
}

function CardHeader({
  icon: Icon,
  kindLabel,
  spokenKind,
  title,
  titleRef,
}: {
  icon: LucideIcon
  kindLabel: string
  /** What TalkBack says before the title. */
  spokenKind: string
  title: string
  titleRef: TitleRef
}) {
  const theme = useTheme()
  return (
    <View style={{ gap: theme.space[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1.5] }}>
        <Icon size={14} color={theme.colors.accentText} strokeWidth={1.75} />
        <Txt variant="label" tone="accent" weight="semibold">
          {kindLabel}
        </Txt>
      </View>
      <Text
        ref={titleRef}
        accessibilityRole="header"
        accessibilityLabel={`${spokenKind}: ${title}`}
        style={[
          theme.text.ui,
          { fontFamily: theme.fonts.semibold, color: theme.colors.text },
        ]}
      >
        {title}
      </Text>
    </View>
  )
}

/**
 * Hermes is blocked on a prompt Cindl must never answer: any reply, even a
 * decline, can become the password or secret Hermes uses. The card says what
 * Hermes waits for and offers nothing to send, so the prompt stays open for
 * another Hermes surface.
 */
function UnsupportedCard({
  request,
  titleRef,
}: {
  request: ServerRequest
  titleRef: TitleRef
}) {
  return (
    <CardFrame>
      <CardHeader
        icon={KeyRound}
        kindLabel="Answer outside Cindl"
        spokenKind="Answer outside Cindl"
        title={request.title}
        titleRef={titleRef}
      />
      <Txt variant="body">{unsupportedCopy(request)}</Txt>
    </CardFrame>
  )
}

/**
 * Structured decision card. Shows exactly what will run, as Hermes redacted
 * it, and only the choices Hermes offered that Cindl may send. A clarify set
 * is answered in one submission; answers another device already locked are
 * shown, never overridden. The first tap locks the card synchronously, so a
 * quick Deny then Allow can never send two answers; after the call, the
 * request's status in the shared store decides (an answer that fails later
 * reopens it).
 */
function DecisionCard({
  request,
  titleRef,
}: {
  request: ServerRequest
  titleRef: TitleRef
}) {
  const api = useCindlApi()
  const theme = useTheme()
  const approval = request.kind === 'approval'
  const capability = useCapability(approval ? 'requests.approval' : 'requests.clarify')
  const canAnswer = capabilityUsable(capability)
  // A ref, not state: two taps in the same frame must not both send.
  const sending = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const busy = submitting || request.status === 'answering'
  const { open, locked } = splitQuestions(request)

  const send = async (answer: RequestAnswer) => {
    await answerOnce(sending, request, async () => {
      setSubmitting(true)
      setError(undefined)
      try {
        await sendAnswer(api, request, answer)
      } catch (failure) {
        setError(describeFailure(failure, ANSWER_UNCERTAIN, ANSWER_REFUSED).message)
      } finally {
        setSubmitting(false)
      }
    })
  }

  const kindLabel = approval
    ? 'Approval needed'
    : open.length > 1
      ? `${open.length} questions`
      : 'Question'
  return (
    <CardFrame>
      <CardHeader
        icon={approval ? ShieldAlert : HelpCircle}
        kindLabel={kindLabel}
        spokenKind={approval ? 'Approval needed' : 'Question'}
        title={request.title}
        titleRef={titleRef}
      />
      {!approval && locked.length ? (
        <View
          accessibilityLabel="Answered on another device"
          style={{ gap: theme.space[2] }}
        >
          {locked.map(({ question, response }) => (
            <View key={question.qid} style={{ gap: theme.space[0.5] }}>
              <Txt>{question.question}</Txt>
              <Txt variant="label" tone="secondary">
                {`Answered on another device: ${describeResponse(response)}`}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
      {approval ? (
        <Approval request={request} busy={busy} canAnswer={canAnswer} onAnswer={send} />
      ) : !open.length ? (
        <Note>
          Every question was answered on another device. Hermes is using those answers.
        </Note>
      ) : isQuickQuestion(open) && open[0] ? (
        <QuickQuestion
          question={open[0]}
          busy={busy}
          canAnswer={canAnswer}
          onAnswer={send}
        />
      ) : (
        <QuestionForm
          request={request}
          busy={busy}
          canAnswer={canAnswer}
          onAnswer={send}
        />
      )}
      {!canAnswer ? (
        <Note>
          {`Answering here is not available: ${unavailableCopy(capability).reason} Answer it on the Hermes host.`}
        </Note>
      ) : null}
      {busy && !error ? (
        <Txt variant="label" tone="tertiary" accessibilityLiveRegion="polite">
          Sending your answer…
        </Txt>
      ) : null}
      {error ? (
        <Txt
          variant="label"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {error}
        </Txt>
      ) : null}
    </CardFrame>
  )
}

function Actions({ children }: { children: ReactNode }) {
  const theme = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.space[2],
      }}
    >
      {children}
    </View>
  )
}

function Approval({
  request,
  busy,
  canAnswer,
  onAnswer,
}: {
  request: ServerRequest
  busy: boolean
  canAnswer: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const theme = useTheme()
  const [whyOpen, setWhyOpen] = useState(false)
  const Chevron = whyOpen ? ChevronDown : ChevronRight
  return (
    <>
      {request.command ? (
        <View
          accessible
          accessibilityLabel={`Command: ${request.command}`}
          style={{
            padding: theme.space[3],
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <Text selectable style={[theme.text.code, { color: theme.colors.text }]}>
            {request.command}
          </Text>
        </View>
      ) : null}
      {request.description ? <Txt variant="body">{request.description}</Txt> : null}
      {request.choices.length ? (
        canAnswer ? (
          <View style={{ gap: theme.space[2] }}>
            <Note>Applies to this action only.</Note>
            <Actions>
              {request.choices.includes('deny') ? (
                <Button
                  label="Deny"
                  disabled={busy}
                  onPress={() => void onAnswer({ kind: 'approval', choice: 'deny' })}
                />
              ) : null}
              {request.choices.includes('once') ? (
                <Button
                  label="Allow once"
                  variant="primary"
                  disabled={busy}
                  onPress={() => void onAnswer({ kind: 'approval', choice: 'once' })}
                />
              ) : null}
            </Actions>
          </View>
        ) : null
      ) : (
        <Note>
          Hermes did not offer a choice Cindl can send. Answer this on the Hermes host.
        </Note>
      )}
      {request.withheldChoices?.length ? (
        <View style={{ gap: theme.space[1] }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: whyOpen }}
            accessibilityLabel="Why only once?"
            onPress={() => setWhyOpen(!whyOpen)}
            style={{
              minHeight: theme.layout.touchTarget,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space[1],
              alignSelf: 'flex-start',
            }}
          >
            <Chevron size={14} color={theme.colors.textTertiary} strokeWidth={1.75} />
            <Txt variant="label" tone="secondary">
              Why only once?
            </Txt>
          </Pressable>
          {whyOpen ? (
            <Txt variant="label" tone="secondary">
              Hermes also offers approval for the rest of the session or permanently.
              Cindl only sends one-time decisions; make broader grants on the Hermes host
              if you want them.
            </Txt>
          ) : null}
        </View>
      ) : null}
    </>
  )
}

/** A single open single-choice question: one tap on a choice is the whole reply. */
function QuickQuestion({
  question,
  busy,
  canAnswer,
  onAnswer,
}: {
  question: ClarifyQuestion
  busy: boolean
  canAnswer: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const theme = useTheme()
  return (
    <View style={{ gap: theme.space[2] }}>
      <Txt variant="body">{question.question}</Txt>
      {canAnswer ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
            {(question.choices ?? []).map((choice) => (
              <Button
                key={choice}
                label={choice}
                disabled={busy}
                onPress={() =>
                  void onAnswer({
                    kind: 'clarify',
                    answers: Object.fromEntries([[question.qid, { choices: [choice] }]]),
                  })
                }
              />
            ))}
          </View>
          <Actions>
            <Button
              label="Skip"
              variant="quiet"
              disabled={busy}
              onPress={() =>
                void onAnswer({
                  kind: 'clarify',
                  answers: Object.fromEntries([
                    [question.qid, { skipped: true as const }],
                  ]),
                })
              }
            />
          </Actions>
        </>
      ) : null}
    </View>
  )
}

/** Answer or skip each open question, then send them together once. */
function QuestionForm({
  request,
  busy,
  canAnswer,
  onAnswer,
}: {
  request: ServerRequest
  busy: boolean
  canAnswer: boolean
  onAnswer: (answer: RequestAnswer) => Promise<void>
}) {
  const theme = useTheme()
  const [drafts, setDrafts] = useState<ClarifyDrafts>(() =>
    clarifyDraftStore.load(request.requestId),
  )
  const update = (qid: string, draft: QuestionDraft) =>
    setDrafts((current) => {
      const next = withDraft(current, qid, draft)
      clarifyDraftStore.save(request.requestId, next)
      return next
    })
  const answer = buildClarifyAnswer(request, drafts)
  const disabled = busy || !canAnswer
  return (
    <>
      {splitQuestions(request).open.map((question) => (
        <QuestionFields
          key={question.qid}
          question={question}
          draft={draftFor(drafts, question.qid)}
          disabled={disabled}
          onChange={(draft) => update(question.qid, draft)}
        />
      ))}
      {canAnswer ? (
        <View style={{ gap: theme.space[2] }}>
          <Note>
            {answer
              ? 'Ready to send all answers together.'
              : 'Answer or skip each question, then send once.'}
          </Note>
          <Actions>
            <Button
              label="Skip all"
              variant="quiet"
              disabled={busy}
              onPress={() => void onAnswer(skipAllAnswer(request))}
            />
            <Button
              label="Send answers"
              variant="primary"
              disabled={busy || !answer}
              onPress={() => {
                if (answer) void onAnswer(answer)
              }}
            />
          </Actions>
        </View>
      ) : null}
    </>
  )
}

function QuestionFields({
  question,
  draft,
  disabled,
  onChange,
}: {
  question: ClarifyQuestion
  draft: QuestionDraft
  disabled: boolean
  onChange: (draft: QuestionDraft) => void
}) {
  const theme = useTheme()
  const choices = question.choices ?? []
  const single = !question.multiSelect && choices.length > 0
  const pickDisabled = disabled || draft.skipped
  return (
    <View style={{ gap: theme.space[2] }}>
      <Txt variant="body">{question.question}</Txt>
      {choices.length ? (
        <View
          {...(single ? { accessibilityRole: 'radiogroup' as const } : {})}
          style={{ gap: theme.space[1] }}
        >
          {choices.map((choice) => (
            <Option
              key={choice}
              label={choice}
              kind={question.multiSelect ? 'checkbox' : 'radio'}
              checked={
                question.multiSelect
                  ? draft.selected.includes(choice)
                  : !draft.useOther && draft.selected[0] === choice
              }
              disabled={pickDisabled}
              onPress={() => onChange(pickChoice(question, draft, choice))}
            />
          ))}
          {single ? (
            <Option
              label="Other"
              kind="radio"
              checked={draft.useOther}
              disabled={pickDisabled}
              onPress={() => onChange(chooseOther(draft))}
            />
          ) : null}
        </View>
      ) : null}
      <TextInput
        accessibilityLabel={`Your own answer to: ${question.question}`}
        placeholder={
          !choices.length
            ? 'Type your answer'
            : question.multiSelect
              ? 'Add your own answer'
              : 'Your own answer'
        }
        placeholderTextColor={theme.colors.textTertiary}
        value={draft.other}
        editable={!pickDisabled}
        multiline
        onChangeText={(text) => onChange(typeAnswer(question, draft, text))}
        style={[
          theme.text.ui,
          {
            minHeight: theme.layout.touchTarget,
            paddingHorizontal: theme.space[3],
            paddingVertical: theme.space[2],
            borderWidth: 1,
            borderColor: theme.colors.borderStrong,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface,
            color: theme.colors.text,
            opacity: pickDisabled ? 0.55 : 1,
          },
        ]}
      />
      <Option
        label="Skip this question"
        kind="checkbox"
        checked={draft.skipped}
        disabled={disabled}
        onPress={() => onChange(setSkipped(draft, !draft.skipped))}
      />
    </View>
  )
}

function Option({
  label,
  kind,
  checked,
  disabled,
  onPress,
}: {
  label: string
  kind: 'radio' | 'checkbox'
  checked: boolean
  disabled: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      accessibilityRole={kind}
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      android_ripple={{ color: theme.colors.selection }}
      style={[
        {
          minHeight: theme.layout.touchTarget,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space[3],
          paddingHorizontal: theme.space[3],
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          backgroundColor: checked ? theme.colors.accentSubtle : theme.colors.surface,
          opacity: disabled ? 0.55 : 1,
        },
        focused ? focusRing(theme) : null,
      ]}
    >
      <View
        style={{
          width: 18,
          height: 18,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          borderColor: checked ? theme.colors.accent : theme.colors.borderStrong,
          borderRadius: kind === 'radio' ? theme.radius.pill : theme.radius.xs,
          backgroundColor: checked ? theme.colors.accent : 'transparent',
        }}
      >
        {checked ? (
          <Check size={12} color={theme.colors.onAccent} strokeWidth={3} />
        ) : null}
      </View>
      <Text style={[theme.text.ui, { flex: 1, color: theme.colors.text }]}>{label}</Text>
    </Pressable>
  )
}
