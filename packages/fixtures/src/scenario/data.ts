/**
 * SYNTHETIC DATA. Every person, company, file, command and account below is
 * fictional ("Lumen & Kiln" is an invented ceramics studio). Nothing here may
 * be replaced with real data, and screenshots built from it must keep the
 * "Synthetic demo" banner visible.
 */
import type {
  Conversation,
  McpServerStatus,
  MemoryOverview,
  Message,
  Routine,
  ServerRequest,
  Skill,
  ToolActivity,
} from '@cindl/contracts'

export const SYNTHETIC_ORIGIN = 'https://hermes.synthetic.invalid'
export const T0 = Date.parse('2026-06-02T08:00:00.000Z')
export const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

export const conversations: Conversation[] = [
  {
    id: 'demo-main',
    session: { storedId: 'demo-main', runtimeId: 'rt-demo-main' },
    title: 'Today',
    kind: 'main',
    profile: 'default',
    createdAt: at(-60 * 24 * 30),
    updatedAt: at(14),
    status: 'waiting-on-you',
    preview: 'Moved the glaze supplier call to Thursday.',
  },
  {
    id: 'demo-inventory',
    session: { storedId: 'demo-inventory' },
    title: 'Kiln inventory sheet',
    kind: 'side',
    profile: 'default',
    createdAt: at(-60 * 5),
    updatedAt: at(-30),
    status: 'idle',
    preview: 'Sheet updated with 42 glaze batches.',
  },
  {
    id: 'demo-offsite',
    session: { storedId: 'demo-offsite' },
    title: 'Studio offsite planning',
    kind: 'side',
    profile: 'default',
    createdAt: at(-60 * 48),
    updatedAt: at(-60 * 20),
    status: 'idle',
    preview: 'Two venues held until Friday.',
  },
]

const text = (value: string) => ({ type: 'text' as const, text: value })

export const tools: ToolActivity[] = [
  {
    id: 'tool-calendar',
    conversationId: 'demo-main',
    name: 'calendar.search',
    title: 'Checked the studio calendar for Thursday',
    status: 'complete',
    startedAt: at(2),
    endedAt: at(2.2),
    argsPreview: '{"range": "Thursday", "calendar": "studio (fixture)"}',
    resultPreview: '3 open slots: 10:00, 13:30, 16:00',
  },
  {
    id: 'tool-email',
    conversationId: 'demo-main',
    name: 'email.draft',
    title: 'Drafted a note to the glaze supplier',
    status: 'complete',
    startedAt: at(3),
    endedAt: at(3.4),
    argsPreview: '{"to": "orders@supplier.example"}',
    resultPreview: 'Draft saved (not sent)',
  },
  {
    id: 'tool-sheet',
    conversationId: 'demo-main',
    name: 'terminal',
    title: 'Preparing to update the inventory export',
    status: 'running',
    startedAt: at(13.8),
    progress: 'Waiting for your approval',
  },
]

export const messages: Message[] = [
  {
    id: 'm-1',
    conversationId: 'demo-main',
    role: 'user',
    parts: [text('Can you move the glaze supplier call? Thursday works better.')],
    status: 'complete',
    createdAt: at(1),
    origin: 'reply',
  },
  {
    id: 'm-2',
    conversationId: 'demo-main',
    role: 'assistant',
    parts: [
      { type: 'tool', toolId: 'tool-calendar' },
      { type: 'tool', toolId: 'tool-email' },
      text(
        'Thursday has three open slots. I picked **13:30** and drafted a short note to the supplier.\n\nThe draft is saved but **not sent**: sending email needs your go-ahead in their portal.',
      ),
    ],
    status: 'complete',
    createdAt: at(3.5),
    origin: 'reply',
  },
  {
    id: 'm-3',
    conversationId: 'demo-main',
    role: 'assistant',
    parts: [
      text(
        'Your weekday brief is ready. Two things need you today:\n\n1. Approve the inventory export (below).\n2. Pick which venue to hold for the offsite.',
      ),
    ],
    status: 'complete',
    createdAt: at(12),
    origin: 'routine',
  },
  {
    id: 'm-4',
    conversationId: 'demo-main',
    role: 'user',
    parts: [text('Also refresh the kiln inventory export when you get a chance.')],
    status: 'complete',
    createdAt: at(13.5),
    origin: 'reply',
  },
  {
    id: 'm-5',
    conversationId: 'demo-main',
    role: 'assistant',
    parts: [
      text(
        'On it. The export script writes to the shared sheet, so I need your approval first.',
      ),
      { type: 'tool', toolId: 'tool-sheet' },
    ],
    status: 'streaming',
    createdAt: at(13.7),
    origin: 'reply',
  },
  {
    id: 'm-inv-1',
    conversationId: 'demo-inventory',
    role: 'assistant',
    parts: [
      text(
        'The inventory sheet now lists 42 glaze batches. Three are below reorder level.',
      ),
    ],
    status: 'complete',
    createdAt: at(-30),
    origin: 'reply',
  },
]

export const requests: ServerRequest[] = [
  {
    rpcId: 'demo-approval-1',
    hermesRequestId: 'apr-demo-1',
    connectionEpoch: 1,
    kind: 'approval',
    conversationId: 'demo-main',
    title: 'Run the inventory export script',
    command: 'python3 scripts/export_inventory.py --sheet studio-inventory',
    description: 'Writes the latest batch counts to the shared studio sheet.',
    toolName: 'terminal',
    choices: ['once', 'deny'],
    withheldChoices: ['session', 'always'],
    receivedAt: at(13.9),
    status: 'open',
  },
  {
    rpcId: 'demo-clarify-1',
    connectionEpoch: 1,
    kind: 'clarify',
    conversationId: 'demo-main',
    title: 'Which venue should I hold?',
    questions: [
      {
        qid: 'venue',
        question: 'Both venues release their hold on Friday. Which one should I keep?',
        choices: ['Harbor Loft (fictional)', 'Orchard Barn (fictional)', 'Neither'],
        multiSelect: false,
      },
    ],
    choices: [],
    receivedAt: at(14),
    status: 'open',
  },
]

export const routines: Routine[] = [
  {
    id: 'routine-brief',
    name: 'Weekday brief',
    schedule: 'Weekdays at 07:30',
    enabled: true,
    lastRun: { at: at(-30), status: 'ok' },
    nextRunAt: at(60 * 23.5),
  },
  {
    id: 'routine-invoices',
    name: 'Invoice follow-ups',
    schedule: 'Mondays at 09:00',
    enabled: false,
    lastRun: { at: at(-60 * 24 * 8), status: 'error' },
  },
]

export const skills: Skill[] = [
  {
    name: 'calendar-triage',
    description: 'Find, hold and move calendar slots.',
    category: 'Scheduling',
    enabled: true,
    source: 'user',
  },
  {
    name: 'inventory-sheets',
    description: 'Keep the studio inventory sheet current.',
    category: 'Operations',
    enabled: true,
    source: 'user',
  },
  {
    name: 'draft-replies',
    description: 'Draft replies for review; never sends.',
    category: 'Communication',
    enabled: true,
    source: 'bundled',
  },
]

export const skillContent: Record<string, string> = {
  'calendar-triage':
    "---\nname: calendar-triage\ndescription: Find, hold and move calendar slots.\n---\n\n# Calendar triage\n\n- Offer at most three slots.\n- Never accept an invite on the owner's behalf without asking.\n",
  'inventory-sheets':
    '---\nname: inventory-sheets\ndescription: Keep the studio inventory sheet current.\n---\n\n# Inventory sheets\n\nRun the export script only after approval.\n',
  'draft-replies':
    "---\nname: draft-replies\ndescription: Draft replies for review; never sends.\n---\n\n# Draft replies\n\nKeep drafts short and in the owner's voice.\n",
}

export const soul =
  "# Identity\n\nYou are the chief of staff for Lumen & Kiln, a small (fictional) ceramics studio.\n\n## Truths\n\n- Protect the owner's focus time before 11:00.\n- Ask before anything that sends, buys or deletes.\n\n## Voice\n\nCalm, brief, specific. No exclamation marks.\n"

export const memoryOverview = (readAt: string): MemoryOverview => ({
  items: [
    { key: 'provider', label: 'Memory provider', detail: 'Built-in files (synthetic)' },
    { key: 'entries', label: 'Saved memories', detail: '18 entries' },
    { key: 'updated', label: 'Last updated', detail: 'Yesterday, 17:42' },
  ],
  source: 'Synthetic fixture (GET /api/memory shape)',
  readAt,
})

export const mcpServers: McpServerStatus[] = [
  {
    name: 'studio-files (fixture)',
    state: 'connected',
    toolCount: 12,
    checkedAt: at(-5),
  },
  {
    name: 'calendar (fixture)',
    state: 'error',
    toolCount: 0,
    checkedAt: at(-5),
    error: 'Authorization expired. Reconnect on the Hermes host.',
  },
]
